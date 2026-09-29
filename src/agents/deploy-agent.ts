import { withBillingScope, projectBillingScope } from "../lib/billing-context";
import { Agent } from "agents";
import { assertRepo, UnsafePathError } from "../lib/safe-path";
import { requireCapability } from "../lib/project-control";
import { AccessError } from "../lib/accounts";
import { unzipSync } from "fflate";
import type { Env, DeployAgentState, TaskRequest, TaskResult, DeployOperation } from "../types";

const REQUIRED_FILES = ["package.json", "wrangler.toml"];

/**
 * DEPLOY AGENT
 *
 * Честное ограничение платформы: Cloudflare Worker не может выполнять
 * npm install / build / test (нет доступа к процессам/shell). Поэтому
 * MVP-версия агента:
 *   1. проверяет готовность проекта к деплою (обязательные файлы, наличие .env.example);
 *   2. формирует чек-лист рисков;
 *   3. если заданы GITHUB_TOKEN + GITHUB_REPO — триггерит уже существующий
 *      GitHub Actions → Cloudflare Workers Builds пайплайн через
 *      repository_dispatch, вместо того чтобы пытаться собрать проект сам.
 * Реальный build/test выполняет существующий CI (см. память проекта: деплой
 * идёт через Cloudflare Workers Builds, подключённый к GitHub).
 */
export class DeployAgent extends Agent<Env, DeployAgentState> {
  initialState: DeployAgentState = { lastRunAt: null };

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
    return withBillingScope(request._billingScope ?? projectBillingScope(request.projectId), () => this.runScoped(request));
  }

  private async runScoped(request: TaskRequest): Promise<TaskResult> {
    this.setState({ lastRunAt: new Date().toISOString() });

    if (request.inputType === "zip" && request.r2Key) {
      return this.checkZipReadiness(request);
    }

    const deployOp = request.deployOp;
    if (!deployOp || deployOp.type !== "trigger_ci") {
      return {
        status: "needs_input",
        agent: "deploy-agent",
        summary: "Deploy readiness можно анализировать автоматически, но внешний CI не запускается без явного deployOp.trigger_ci.",
        questions: [
          'Для staging передай deployOp: {"type":"trigger_ci","environment":"staging"}.',
          'Production дополнительно требует confirmProduction=true и серверный AZRAIL_ALLOW_PRODUCTION_DEPLOY=true.',
        ],
      };
    }

    if (request.intent !== "deploy") {
      return {
        status: "needs_input",
        agent: "deploy-agent",
        summary: "Внешний deploy отклонён: TaskRequest должен иметь intent=deploy.",
      };
    }

    if (this.env.GITHUB_TOKEN && this.env.GITHUB_REPO) {
      return this.triggerCi(request, deployOp);
    }

    return {
      status: "needs_input",
      agent: "deploy-agent",
      summary: "Deploy разрешён структурно, но GitHub CI не настроен.",
      questions: [
        "Задай серверные секреты GITHUB_TOKEN и GITHUB_REPO.",
      ],
    };
  }

  private async checkZipReadiness(request: TaskRequest): Promise<TaskResult> {
    const obj = await this.env.AZRAIL_R2.get(request.r2Key!);
    if (!obj) {
      return { status: "failed", agent: "deploy-agent", summary: `Объект ${request.r2Key} не найден в AZRAIL_R2.` };
    }
    const files = unzipSync(new Uint8Array(await obj.arrayBuffer()));
    const names = Object.keys(files);
    const missing = REQUIRED_FILES.filter((f) => !names.some((n) => n.endsWith(f)));
    const risks: string[] = [];
    if (!names.some((n) => n.endsWith(".env.example"))) risks.push("Нет .env.example — секреты придётся угадывать при первом деплое.");
    if (!names.some((n) => n.endsWith(".gitignore"))) risks.push("Нет .gitignore — риск закоммитить node_modules/.env.");
    if (names.some((n) => n.includes("node_modules/"))) risks.push("В архиве лежит node_modules — раздувает деплой, лучше исключить.");

    return {
      status: missing.length > 0 ? "needs_input" : "done",
      agent: "deploy-agent",
      summary:
        missing.length > 0
          ? `Не хватает обязательных файлов: ${missing.join(", ")}.`
          : "Проект содержит обязательные файлы, реальную сборку/тесты выполнит подключённый GitHub CI после пуша.",
      data: { missingFiles: missing, risks, fileCount: names.length },
      questions: missing.length > 0 ? [`Добавь в архив: ${missing.join(", ")}`] : undefined,
    };
  }

  private async triggerCi(request: TaskRequest, op: Extract<DeployOperation, { type: "trigger_ci" }>): Promise<TaskResult> {
    try {
      await requireCapability(this.env, request.projectId, "deploy");
    } catch (err) {
      if (err instanceof AccessError) {
        return {
          status: "needs_input",
          agent: "deploy-agent",
          summary: err.message,
        };
      }
      throw err;
    }

    if (
      op.environment === "production" &&
      (op.confirmProduction !== true || this.env.AZRAIL_ALLOW_PRODUCTION_DEPLOY !== "true")
    ) {
      return {
        status: "needs_input",
        agent: "deploy-agent",
        summary: "Production deploy заблокирован fail-closed.",
        questions: [
          "Для production нужны одновременно deployOp.confirmProduction=true и серверный AZRAIL_ALLOW_PRODUCTION_DEPLOY=true.",
        ],
      };
    }

    // GITHUB_REPO — секрет окружения, а не поле из тела запроса, поэтому
    // риск здесь ниже, чем у аналогичных мест в git-agent.ts/qa-agent.ts,
    // где repo приходит из request. Но именно этот вызов до сих пор
    // интерполировал значение напрямую в URL, не пройдя через assertRepo,
    // хотя импорт уже стоял в файле — найдено при аудите, не было
    // отдельного теста, который бы это поймал.
    let repo: string;
    try {
      repo = assertRepo(this.env.GITHUB_REPO);
    } catch (err) {
      if (err instanceof UnsafePathError) {
        return {
          status: "failed",
          agent: "deploy-agent",
          summary: "GITHUB_REPO настроен некорректно — не похож на owner/name.",
          error: err.message,
        };
      }
      throw err;
    }

    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "azrail-os",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "azrail-deploy",
        client_payload: { projectId: request.projectId ?? null, environment: op.environment, triggeredAt: new Date().toISOString() },
      }),
    });

    if (!res.ok) {
      return {
        status: "failed",
        agent: "deploy-agent",
        summary: `GitHub repository_dispatch вернул ${res.status}.`,
        error: await res.text(),
      };
    }

    return {
      status: "done",
      agent: "deploy-agent",
      summary: `Событие azrail-deploy (${op.environment}) отправлено в ${repo} — дальше сборку и тесты ведёт существующий CI.`,
    };
  }
}
