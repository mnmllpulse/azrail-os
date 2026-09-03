// AZRAIL — общие типы
import type { Orchestrator } from "./agents/orchestrator";

export interface Env {
  AZRAIL_D1: D1Database;
  AZRAIL_KV: KVNamespace;
  AZRAIL_R2: R2Bucket;
  AI: Ai;
  Orchestrator: DurableObjectNamespace<Orchestrator>;

  // Слаги моделей ЗДЕСЬ БОЛЬШЕ НЕ ЖИВУТ. Их единственное место —
  // lib/model-registry.ts, где у каждого записан источник данных.
  // Две переменные в конфиге были вторым источником правды, а один из
  // них уже успел устареть незамеченным.
  CORS_ORIGIN: string;
  /** Потолок операций записи в час. Защита от неограниченного счёта. */
  AZRAIL_WRITE_BUDGET?: string;
  /**
   * Биндинг контейнеров Cloudflare для песочницы. Появится вместе с
   * платным планом; до тех пор исполнение идёт через GitHub Actions.
   */
  AZRAIL_SANDBOX?: unknown;

  // Не подключены (ресурсы ещё не созданы). Опциональны — код деградирует
  // без ошибок, если биндинга нет. См. README → "Пробелы".
  AZRAIL_VECTORIZE?: VectorizeIndex;
  AZRAIL_QUEUE?: Queue;

  // Секреты (wrangler secret put) — опциональны
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;

  /** Токен доступа к платным эндпоинтам. Без него они закрыты (fail-closed). */
  AZRAIL_TOKEN?: string;
  /** Лимит задач в час на вызывающего. По умолчанию 50. */
  AZRAIL_HOURLY_LIMIT?: string;

  /**
   * ID шлюза AI Gateway. Без него недоступны СТОРОННИЕ модели
   * (anthropic/*, openai/* и прочие не-@cf): им нужен маршрут через шлюз.
   * Значение "default" создаёт шлюз при первом обращении.
   * Заодно включает аналитику Gateway — стоимость, задержки, ошибки.
   */
  AI_GATEWAY_ID?: string;
}

export type InputType = "zip" | "pdf" | "docx" | "github" | "text" | "json" | "image" | "audio" | "video" | "code" | "unknown";

export type Intent =
  | "analyze_spec"
  | "review_repo"
  | "generate_code"
  | "deploy"
  | "git_operation"
  | "generate_ui"
  | "security_scan"
  | "qa_check"
  | "evolution_audit"
  | "unclear";

/** Файл, сгенерированный агентом. Скармливается Git Agent'у как есть. */
export interface GeneratedFile {
  path: string;
  content: string;
}

export type QaOperation =
  /** Структурный анализ: какие модули не упоминаются ни в одном тесте. Без выполнения кода. */
  | { type: "coverage_gaps" }
  /** Запуск GitHub Actions workflow (workflow_dispatch) */
  | { type: "trigger_tests"; workflow: string; ref?: string }
  /** Последний прогон — статус и заключение */
  | { type: "latest_run"; workflow?: string; branch?: string }
  /** Джобы конкретного прогона с упавшими шагами */
  | { type: "check_run"; runId: number };

export type GitOperation =
  | { type: "create_branch"; branch: string; from?: string }
  | { type: "commit_file"; branch: string; path: string; content: string; message: string }
  | { type: "open_pr"; head: string; base: string; title: string; body?: string }
  | { type: "diff"; base: string; head: string }
  | { type: "list_commits"; branch?: string; limit?: number };

// ─── Миссии и инструменты ─────────────────────────────────────────────────
// Слой автономного выполнения: миссия — это задача, которую AZRAIL ведёт
// сам через цикл вызовов инструментов, а не один вызов агента.

export interface AttachmentRef {
  r2Key?: string;
  fileName: string;
  inputType: InputType;
  size?: number;
  mimeType?: string;
}

/** Закрытый список инструментов. Реальную доступность каждого держит
 *  lib/tool-registry.ts, и она обязана совпадать с адаптерами в
 *  core/execution-engine.ts — за этим следит тест. */
export type ToolName =
  | "read_file" | "write_file" | "edit_file" | "delete_file"
  | "list_files" | "search_files"
  | "run_tests"
  | "open_pr" | "git_diff"
  | "search_web" | "call_model"
  | "generate_image" | "generate_video" | "transcribe"
  | "browser_open" | "browser_click" | "browser_type" | "screenshot"
  | "sandbox_test" | "sandbox_exec" | "sandbox_preview";

export interface ToolCall {
  id: string;
  tool: ToolName;
  status: "queued" | "running" | "done" | "failed";
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type MissionStatus =
  | "queued" | "planning" | "executing" | "verifying"
  | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface MissionEvent {
  id: string;
  missionId: string;
  type: string;
  data?: unknown;
  createdAt: string;
}

export interface TaskRequest {
  projectId?: string;
  userId?: string;
  /** Не нужен для чисто структурных запросов (gitOp) */
  inputType?: InputType;
  intent?: Intent;
  /** Текст задачи, либо путь GitHub-репозитория вида "owner/name" при inputType="github".
   *  Не нужен для чисто структурных запросов (gitOp) */
  payload?: string;
  /** Ключ объекта в AZRAIL_R2 — обязателен для zip/pdf/docx */
  r2Key?: string;
  /** Проставляется Orchestrator'ом после Architect Agent — план, которым Code Agent должен руководствоваться */
  architecturePlan?: string;
  /** Репозиторий "owner/name" для Git Agent. Приоритетнее env.GITHUB_REPO */
  gitRepo?: string;
  /** Структурная Git-операция. Без неё Git Agent вернёт needs_input, а не будет гадать */
  gitOp?: GitOperation;
  /** Структурная QA-операция. По умолчанию coverage_gaps */
  qaOp?: QaOperation;
  /** Направление по стилю/бренду для UI Agent. Приоритетнее его собственных предпочтений */
  designBrief?: string;
  /** Если задано — сгенерированные UI-файлы коммитятся в эту ветку через Git Agent */
  commitToBranch?: string;
  /** Явный слаг модели из реестра — обходит автоматический выбор по тиру.
   *  См. RunOptions.preferredModel в lib/model-router.ts за причиной. */
  preferredModel?: string;
  /** Диалог, к которому относится задача. Хранится в D1 (lib/chat-store.ts),
   *  а не в памяти конкретного Durable Object: диалогов много, и они должны
   *  переживать выгрузку объекта. */
  conversationId?: string;
  /** Сообщение-родитель. Ветвление правок держится на нём: правка старого
   *  сообщения не переписывает историю, а создаёт ветку от него. */
  parentMessageId?: string;
  /** Вложения. Файл уже лежит в R2 — здесь только ссылка на него. */
  attachments?: AttachmentRef[];
  /** Текст сообщения в диалоге. Отличается от payload тем, что payload —
   *  вход для агента, а message — реплика пользователя в переписке. */
  message?: string;
}

export interface TaskResult {
  status: "done" | "failed" | "needs_input";
  agent: string;
  summary: string;
  data?: unknown;
  /** Шаг 2 воркфлоу — уточняющие вопросы, если данных недостаточно */
  questions?: string[];
  error?: string;
}

export interface OrchestratorState {
  activeProjectId: string | null;
  lastIntent: Intent | null;
  taskCount: number;
}

export interface CodeAgentState {
  lastRunAt: string | null;
}

export interface ArchitectAgentState {
  lastRunAt: string | null;
}

export interface GitAgentState {
  lastRunAt: string | null;
}

export interface UiAgentState {
  lastRunAt: string | null;
}

export interface SecurityAgentState {
  lastRunAt: string | null;
}

export interface QaAgentState {
  lastRunAt: string | null;
}

export interface EvolutionAgentState {
  lastRunAt: string | null;
}

export interface DeployAgentState {
  lastRunAt: string | null;
}
