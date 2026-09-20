import { Agent } from "agents";
import { assertRepo, pathSegments, UnsafePathError } from "../lib/safe-path";
import type { Env, GitAgentState, TaskRequest, TaskResult, GitOperation } from "../types";

// ВАЖНО про источник знаний: формы ответов GitHub REST API взяты по знанию API,
// а НЕ проверены живыми запросами в этой сессии — api.github.com отдал
// rate-limit на IP песочницы. Эндпоинты стабильные и давние, но если что-то
// пойдёт не так на первом реальном запуске — смотреть надо сюда в первую очередь.
// Проверяется одним вызовом: POST /api/task с gitOp.type="list_commits".

const GH = "https://api.github.com";

/** btoa() ломается на не-latin1 (кириллица в коде/README → InvalidCharacterError).
 *  Кодируем через UTF-8 байты — иначе коммиты с русским текстом молча падают. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

interface GhError {
  message?: string;
}

export class GitAgent extends Agent<Env, GitAgentState> {
  initialState: GitAgentState = { lastRunAt: null };

  /** См. RunnableAgent.ping — проверка того, что DO поднимается и отвечает. */
  async ping() {
    let storageReadable = false;
    try {
      // Прямой запрос к хранилищу Durable Object, а не чтение this.state:
      // геттер состояния кеширует и на тёплом экземпляре не дошёл бы до
      // SQLite вообще. Подробности — в комментарии к AgentPing.
      this.sql`SELECT 1`;
      storageReadable = true;
    } catch {
      storageReadable = false;
    }
    return { storageReadable };
  }

  async run(request: TaskRequest): Promise<TaskResult> {
    this.setState({ lastRunAt: new Date().toISOString() });

    if (!this.env.GITHUB_TOKEN) {
      return {
        status: "needs_input",
        agent: "git-agent",
        summary: "Нет GITHUB_TOKEN — без него Git-операции невозможны.",
        questions: ["Задай секрет: `wrangler secret put GITHUB_TOKEN` (нужны права repo)."],
      };
    }

    // Репозиторий берём из запроса, env.GITHUB_REPO — только фоллбек.
    // (Раньше репо было жёстко одно на весь воркер — не масштабировалось
    //  на несколько проектов, это чинится здесь.)
    const repo = request.gitRepo ?? this.env.GITHUB_REPO;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return {
        status: "needs_input",
        agent: "git-agent",
        summary: "Не указан репозиторий.",
        questions: ['Передай "gitRepo": "owner/name" в запросе, либо задай секрет GITHUB_REPO по умолчанию.'],
      };
    }

    const op = request.gitOp;
    if (!op) {
      return {
        status: "needs_input",
        agent: "git-agent",
        summary: "Не указана Git-операция.",
        questions: [
          'Передай "gitOp", например: {"type":"create_branch","branch":"feature/x"} · ' +
            '{"type":"commit_file","branch":"main","path":"src/a.ts","content":"...","message":"..."} · ' +
            '{"type":"open_pr","head":"feature/x","base":"main","title":"..."} · ' +
            '{"type":"diff","base":"main","head":"feature/x"} · {"type":"list_commits"}',
        ],
      };
    }

    try {
      switch (op.type) {
        case "create_branch":
          return await this.createBranch(repo, op);
        case "commit_file":
          return await this.commitFile(repo, op);
        case "open_pr":
          return await this.openPr(repo, op);
        case "diff":
          return await this.diff(repo, op);
        case "list_commits":
          return await this.listCommits(repo, op);
        default:
          return {
            status: "needs_input",
            agent: "git-agent",
            summary: `Неизвестная операция: ${(op as { type: string }).type}`,
          };
      }
    } catch (err) {
      if (err instanceof UnsafePathError) {
        return {
          status: "needs_input",
          agent: "git-agent",
          summary: "Запрос отклонён: параметр не прошёл проверку безопасности.",
          error: err.message,
        };
      }
      return {
        status: "failed",
        agent: "git-agent",
        summary: "Сбой при обращении к GitHub API.",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async gh(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${GH}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "azrail-os", // GitHub требует User-Agent, иначе 403
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async ghFail(res: Response, action: string): Promise<TaskResult> {
    let detail = "";
    try {
      detail = ((await res.json()) as GhError).message ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    return {
      status: "failed",
      agent: "git-agent",
      summary: `${action}: GitHub вернул ${res.status}.`,
      error: detail.slice(0, 500),
    };
  }

  private async createBranch(repo: string, op: Extract<GitOperation, { type: "create_branch" }>): Promise<TaskResult> {
    const from = op.from ?? "main";
    // Имя ветки может содержать слеши (feature/x), поэтому кодируется
    // посегментно. Сегмент ".." отвергается: он увёл бы запрос с эндпоинта
    // чтения ссылки на произвольный путь GitHub API.
    const refRes = await this.gh(`/repos/${assertRepo(repo)}/git/ref/heads/${pathSegments(from, "from")}`);
    if (!refRes.ok) return this.ghFail(refRes, `Не удалось прочитать ветку "${from}"`);
    const baseSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;

    const createRes = await this.gh(`/repos/${assertRepo(repo)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${op.branch}`, sha: baseSha }),
    });
    if (!createRes.ok) return this.ghFail(createRes, `Не удалось создать ветку "${op.branch}"`);

    return {
      status: "done",
      agent: "git-agent",
      summary: `Ветка "${op.branch}" создана от "${from}" (${baseSha.slice(0, 7)}).`,
      data: { repo, branch: op.branch, from, baseSha },
    };
  }

  private async commitFile(repo: string, op: Extract<GitOperation, { type: "commit_file" }>): Promise<TaskResult> {
    // Contents API требует sha существующего файла при обновлении и запрещает
    // его при создании — поэтому сначала проверяем, есть ли файл.
    let existingSha: string | undefined;
    // Путь файла — самое очевидное место для обхода: он и должен содержать
    // слеши, поэтому проверяется каждый сегмент отдельно.
    const safePath = pathSegments(op.path, "path");
    const headRes = await this.gh(
      `/repos/${assertRepo(repo)}/contents/${safePath}?ref=${encodeURIComponent(op.branch)}`,
    );
    if (headRes.ok) {
      existingSha = ((await headRes.json()) as { sha?: string }).sha;
    } else if (headRes.status !== 404) {
      return this.ghFail(headRes, `Не удалось проверить файл "${op.path}"`);
    }

    const putRes = await this.gh(`/repos/${assertRepo(repo)}/contents/${safePath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: op.message,
        content: toBase64(op.content),
        branch: op.branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    if (!putRes.ok) return this.ghFail(putRes, `Не удалось закоммитить "${op.path}"`);

    const commit = (await putRes.json()) as { commit?: { sha?: string; html_url?: string } };
    return {
      status: "done",
      agent: "git-agent",
      summary: `${existingSha ? "Обновлён" : "Создан"} файл "${op.path}" в ветке "${op.branch}".`,
      data: { repo, path: op.path, branch: op.branch, created: !existingSha, commitSha: commit.commit?.sha, url: commit.commit?.html_url },
    };
  }

  private async openPr(repo: string, op: Extract<GitOperation, { type: "open_pr" }>): Promise<TaskResult> {
    const res = await this.gh(`/repos/${assertRepo(repo)}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: op.title, head: op.head, base: op.base, body: op.body ?? "" }),
    });
    if (!res.ok) return this.ghFail(res, "Не удалось открыть PR");

    const pr = (await res.json()) as { number?: number; html_url?: string };
    return {
      status: "done",
      agent: "git-agent",
      summary: `PR #${pr.number} открыт: ${op.head} → ${op.base}.`,
      data: { repo, number: pr.number, url: pr.html_url },
    };
  }

  private async diff(repo: string, op: Extract<GitOperation, { type: "diff" }>): Promise<TaskResult> {
    const res = await this.gh(`/repos/${assertRepo(repo)}/compare/${encodeURIComponent(op.base)}...${encodeURIComponent(op.head)}`);
    if (!res.ok) return this.ghFail(res, `Не удалось сравнить ${op.base}...${op.head}`);

    const cmp = (await res.json()) as {
      ahead_by?: number;
      behind_by?: number;
      files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
    };
    const files = (cmp.files ?? []).map((f) => ({
      file: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
    const totalAdd = files.reduce((s, f) => s + f.additions, 0);
    const totalDel = files.reduce((s, f) => s + f.deletions, 0);

    return {
      status: "done",
      agent: "git-agent",
      summary: `${op.base}...${op.head}: ${files.length} файлов, +${totalAdd} / -${totalDel}, впереди на ${cmp.ahead_by ?? 0} коммитов.`,
      data: { repo, aheadBy: cmp.ahead_by, behindBy: cmp.behind_by, files },
    };
  }

  private async listCommits(repo: string, op: Extract<GitOperation, { type: "list_commits" }>): Promise<TaskResult> {
    const limit = Math.min(op.limit ?? 10, 50);
    const query = new URLSearchParams({ per_page: String(limit) });
    if (op.branch) query.set("sha", op.branch);

    const res = await this.gh(`/repos/${assertRepo(repo)}/commits?${query}`);
    if (!res.ok) return this.ghFail(res, "Не удалось получить коммиты");

    const raw = (await res.json()) as Array<{
      sha: string;
      html_url?: string;
      commit: { message: string; author?: { name?: string; date?: string } };
    }>;
    const commits = raw.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author?.name,
      date: c.commit.author?.date,
      url: c.html_url,
    }));

    return {
      status: "done",
      agent: "git-agent",
      summary: `${commits.length} коммитов${op.branch ? ` в "${op.branch}"` : ""}.`,
      data: { repo, commits },
    };
  }
}
