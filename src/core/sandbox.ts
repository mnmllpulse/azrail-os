import type { Env } from "../types";

/**
 * ПЕСОЧНИЦА.
 *
 * Её единственное настоящее назначение — сделать ответ на вопрос «работает
 * ли это» НЕПОДДЕЛЫВАЕМЫМ. Терминал, предпросмотр, дерево файлов — всё
 * обслуживает эту задачу и без неё бессмысленно.
 *
 * ── Почему движок сменный ────────────────────────────────────────────
 *
 * Настоящая песочница на Cloudflare (контейнеры) требует платного плана.
 * Ждать его — значит на месяцы оставить `done` мнением модели, а это самая
 * дорогая дыра в системе.
 *
 * Но исполнение тестов уже доступно ДРУГИМ путём: GitHub Actions. Сигнал
 * там такой же внешний и объективный, просто приходит минутами, а не
 * секундами. Для проверки «сломали или нет» этого достаточно.
 *
 * Поэтому здесь два движка за одним интерфейсом:
 *   container — контейнеры Cloudflare. Быстро, произвольные команды.
 *               Появится вместе с платным планом.
 *   actions   — GitHub Actions. Работает СЕГОДНЯ, нужен только GITHUB_TOKEN.
 *               Медленно, только заранее описанные workflow.
 *
 * Разбор результата, обрезка вывода и политика сети — общие. Когда движок
 * сменится, менять придётся один адаптер, а не проверку качества целиком.
 */

export type SandboxBackend = "container" | "actions" | "none";

export interface TestResult {
  passed: number;
  failed: number;
  total: number;
  /** Итог. Считается КОДОМ, а не моделью — в этом весь смысл. */
  ok: boolean;
  /** Какой прогонщик распознан. Для диагностики, не для логики. */
  runner: string;
  /** Названия упавших тестов, если удалось вытащить. */
  failures: string[];
}

/* ── Пределы ─────────────────────────────────────────────────────────
   Все три обязательны. Отсутствие любого — источник неограниченных
   расходов: забытый контейнер стоит денег круглосуточно. */
export const SANDBOX_LIMITS = {
  /** Одна команда. Дольше — почти всегда зависание, а не работа. */
  COMMAND_TIMEOUT_MS: 120_000,
  /** Простой до уничтожения. Баланс скорости следующего шага и цены. */
  IDLE_TIMEOUT_MS: 10 * 60_000,
  /** Абсолютный потолок жизни песочницы. */
  MAX_LIFETIME_MS: 60 * 60_000,
  /** Потолок выхлопа одной команды. */
  MAX_OUTPUT_BYTES: 5 * 1024 * 1024,
  /** Сколько строк оставлять с каждого конца при обрезке. */
  KEEP_HEAD_LINES: 100 as number,
  KEEP_TAIL_LINES: 100 as number,
} as const;

/* ── Политика сети ───────────────────────────────────────────────────
   Запрещено по умолчанию, разрешено точечно.

   Причина не в паранойе: внутри исполняется код, написанный моделью по
   запросу пользователя. Без ограничений он может отправить содержимое
   проекта куда угодно, и обнаружится это никогда. */
export const ALLOWED_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "github.com",
  "codeload.github.com",
] as const;

/**
 * Разрешён ли хост.
 *
 * Сравнение по ТОЧНОМУ хосту, а не по вхождению подстроки: проверка вида
 * `url.includes("github.com")` пропускает `github.com.evil.ru` — классический
 * способ обойти список разрешённых.
 */
export function isAllowedHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    // Не разобралось как URL — значит не разрешено. Отказ по умолчанию.
    return false;
  }
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Умная обрезка вывода.
 *
 * Не «первые N килобайт»: ошибки почти всегда в КОНЦЕ вывода, а контекст
 * запуска — в начале. Обрезка с головы теряет причину падения, обрезка с
 * хвоста теряет то, что вообще запускали.
 *
 * Середина не нужна: там обычно повторяющийся прогресс сборки.
 *
 * Зачем вообще обрезать: необрезанный выхлоп забивает контекст модели и
 * вытесняет оттуда саму задачу — недооценённая причина, по которой агент
 * «забывает», что делал.
 */
export function truncateOutput(
  text: string,
  head = SANDBOX_LIMITS.KEEP_HEAD_LINES,
  tail = SANDBOX_LIMITS.KEEP_TAIL_LINES,
): string {
  const lines = (text ?? "").split("\n");
  if (lines.length <= head + tail) return text ?? "";

  const skipped = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    ``,
    `… пропущено ${skipped} строк(и) середины вывода …`,
    ``,
    ...lines.slice(-tail),
  ].join("\n");
}

/* ── Разбор результата тестов ────────────────────────────────────────

   Отдельная чистая функция, потому что это САМОЕ важное место системы:
   отсюда берётся объективный сигнал «работает или нет».

   ВАЖНАЯ АСИММЕТРИЯ с разбором вердикта проверяющего (core/checker.ts):
   там непонятный ответ считается прохождением, потому что проверка —
   надстройка и не должна блокировать сделанную работу.

   ЗДЕСЬ НАОБОРОТ. Если разобрать не удалось, `ok` берётся из КОДА
   ВОЗВРАТА и никогда не предполагается истинным. Это основание для
   решения, а не подсказка: «не понял вывод» обязано означать «не
   подтверждено», иначе весь смысл теряется. */

interface RunnerPattern {
  name: string;
  re: RegExp;
  read: (m: RegExpMatchArray) => { passed: number; failed: number };
}

const RUNNERS: RunnerPattern[] = [
  {
    // vitest: "Tests  2 failed | 10 passed (12)"
    name: "vitest",
    re: /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i,
    read: (m) => ({ failed: Number(m[1] ?? 0), passed: Number(m[2]) }),
  },
  {
    // jest: "Tests:  2 failed, 10 passed, 12 total"
    name: "jest",
    re: /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+skipped,\s*)?(\d+)\s+passed/i,
    read: (m) => ({ failed: Number(m[1] ?? 0), passed: Number(m[2]) }),
  },
  {
    // pytest: "2 failed, 10 passed in 1.23s"
    name: "pytest",
    re: /(?:(\d+)\s+failed,\s*)?(\d+)\s+passed(?:,|\s+in\s)/i,
    read: (m) => ({ failed: Number(m[1] ?? 0), passed: Number(m[2]) }),
  },
];

export function parseTestOutput(raw: string, exitCode?: number): TestResult {
  const text = raw ?? "";

  for (const runner of RUNNERS) {
    const m = text.match(runner.re);
    if (!m) continue;
    const { passed, failed } = runner.read(m);
    return {
      passed,
      failed,
      total: passed + failed,
      // Итог по ЧИСЛАМ. Если прогонщик сказал «2 failed», никакое
      // "All done!" ниже по выводу этого не отменяет.
      ok: failed === 0 && passed > 0,
      runner: runner.name,
      failures: extractFailures(text),
    };
  }

  // go test: строчный формат без сводки
  if (/^(ok|FAIL)\s+\S+/m.test(text)) {
    const failed = (text.match(/^FAIL\s+\S+/gm) ?? []).length;
    const passed = (text.match(/^ok\s+\S+/gm) ?? []).length;
    return {
      passed,
      failed,
      total: passed + failed,
      ok: failed === 0 && passed > 0,
      runner: "go",
      failures: extractFailures(text),
    };
  }

  // Ничего не распознано — решает КОД ВОЗВРАТА. Не предполагаем успех.
  return {
    passed: 0,
    failed: 0,
    total: 0,
    ok: exitCode === 0,
    runner: exitCode === undefined ? "неизвестен" : `код ${exitCode}`,
    failures: [],
  };
}

/** Названия упавших тестов, насколько их видно в выводе. */
function extractFailures(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:×|✕|FAIL(?:ED)?:?)\s+(.{3,160})/);
    if (m) out.push(m[1].trim());
    if (out.length >= 20) break; // список для человека, а не дамп
  }
  return out;
}

/**
 * Какой движок исполнения доступен.
 *
 * Порядок не случаен: контейнер быстрее и умеет произвольные команды,
 * поэтому если он есть — берём его. Actions — рабочий запасной путь, а не
 * заглушка: сигнал оттуда такой же объективный.
 */
export function detectBackend(env: Env): SandboxBackend {
  if ("AZRAIL_SANDBOX" in env && env.AZRAIL_SANDBOX) return "container";
  if (env.GITHUB_TOKEN) return "actions";
  return "none";
}

/** Человеческое описание — для реестра инструментов и самопроверки. */
export function describeBackend(backend: SandboxBackend): string {
  switch (backend) {
    case "container":
      return "контейнеры Cloudflare — произвольные команды, секунды";
    case "actions":
      return "GitHub Actions — только описанные workflow, минуты";
    case "none":
      return "нет: нужен платный план Cloudflare либо GITHUB_TOKEN";
  }
}

/* ── Контейнер ───────────────────────────────────────────────────────

   Интерфейс намеренно узкий: одна команда, один результат. Богатый API
   песочницы соблазняет складывать в неё логику, которой там не место, —
   а всё, что нужно циклу, это «выполни и скажи, что вышло».

   Реализация появится вместе с биндингом AZRAIL_SANDBOX. До тех пор
   вызовы честно отказывают: обещать исполнение там, где исполнять
   нечем, хуже, чем отказать. */

export interface ExecResult {
  /** Код возврата. Именно он решает, успех это или нет. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Оборвано ли по таймауту — отдельно от ненулевого кода: причина разная. */
  timedOut: boolean;
}

/** Минимум, который должен уметь контейнер. */
export interface ContainerBinding {
  exec(command: string, opts?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult>;
  /** URL проброшенного порта, если сервер поднят. */
  previewUrl?(port: number): Promise<string | null>;
}

/**
 * Достать биндинг контейнера, если он есть.
 *
 * Проверяется НАЛИЧИЕ МЕТОДА, а не просто присутствие поля. Пустой
 * объект в биндинге — обычное дело при неполной настройке, и падать на
 * `undefined is not a function` посреди миссии хуже, чем честно сказать,
 * что песочницы нет.
 */
export function getContainer(env: Env): ContainerBinding | null {
  const raw = (env as { AZRAIL_SANDBOX?: unknown }).AZRAIL_SANDBOX;
  if (!raw || typeof raw !== "object") return null;
  if (typeof (raw as ContainerBinding).exec !== "function") return null;
  return raw as ContainerBinding;
}

/**
 * Выполнить команду и привести результат к единому виду.
 *
 * Вывод обрезается ЗДЕСЬ, а не у вызывающего: забыть обрезку в одном из
 * мест — верный способ однажды получить мегабайт в контексте модели и
 * вытеснить оттуда саму задачу.
 */
export async function runInContainer(
  env: Env,
  command: string,
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<ExecResult & { output: string }> {
  const box = getContainer(env);
  if (!box) {
    throw new Error(
      "Контейнер недоступен: биндинг AZRAIL_SANDBOX не настроен. " +
        "Раскомментируй [[containers]] в wrangler.toml и задеплой.",
    );
  }

  const res = await box.exec(command, {
    timeoutMs: opts?.timeoutMs ?? SANDBOX_LIMITS.COMMAND_TIMEOUT_MS,
    cwd: opts?.cwd,
  });

  const merged = [res.stdout, res.stderr].filter(Boolean).join("\n");
  return { ...res, output: truncateOutput(merged) };
}
