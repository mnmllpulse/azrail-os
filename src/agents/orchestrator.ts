import { Agent } from "agents";
import { log } from "../lib/resilience";
import { runModel, route, extractText } from "../lib/model-router";
import type { Env, OrchestratorState, TaskRequest, TaskResult, Intent, GeneratedFile } from "../types";
// Orchestrator больше не импортирует агентов поимённо — только реестр.
// Git Agent остаётся прямым импортом: commitFiles() вызывает конкретную
// структурную операцию, а не абстрактную возможность.
import { GitAgent } from "./git-agent";
import { AGENT_REGISTRY, capabilityForIntent, findByCapability, type Capability } from "../lib/agent-registry";
import { ensureProject } from "../lib/project";
import { addMessage, ensureConversation, listMessages } from "../lib/chat-store";

const MIN_PAYLOAD_LENGTH = 8;

/**
 * AZRAIL ORCHESTRATOR
 *
 * Единственный агент с явным Durable Object биндингом (см. wrangler.toml).
 * Code Agent и Deploy Agent — sub-agents (this.subAgent), у них своя
 * изолированная SQLite-память, но общий рантайм-инстанс с оркестратором.
 *
 * Обязательный воркфлоу из системного промпта (раздел 5):
 *   Шаг 1 — анализ / классификация намерения
 *   Шаг 2 — проверка достаточности данных (не домысливать)
 *   Шаг 3+ — передаётся дальше конкретному агенту
 */
/** Закрытый список меток намерения. Один источник и для проверки ответа
 *  модели, и для его разбора: два списка неминуемо разъехались бы. */
const ALLOWED_INTENTS: Intent[] = [
  "analyze_spec", "review_repo", "generate_code", "deploy", "git_operation",
  "generate_ui", "security_scan", "qa_check", "evolution_audit", "unclear",
];

export class Orchestrator extends Agent<Env, OrchestratorState> {
  initialState: OrchestratorState = {
    activeProjectId: null,
    lastIntent: null,
    taskCount: 0,
  };

  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS local_tasks (
        id TEXT PRIMARY KEY,
        intent TEXT,
        status TEXT,
        started_at TEXT
      )
    `;
    // Таблицы messages здесь БОЛЬШЕ НЕТ намеренно. Переписка переехала в
    // D1 (lib/chat-store.ts): в SQLite объекта она была видна только этому
    // объекту, не переживала его выгрузку и не давала ветвления правок.
    // Два хранилища одного и того же неизбежно разъехались бы.
  }

  /**
   * WebSocket-подключение принято SDK автоматически (см. index.ts —
   * getAgentByName + fetch на апгрейд-запрос). Здесь только логирование:
   * ничего не отправляем на connect, чтобы не путать с onStateUpdate самого
   * SDK, который и так шлёт свой протокольный кадр первым.
   */
  /**
   * Рассылка события миссии подключённым сокетам.
   *
   * Цикл выполнения пишет события в D1 сам (event-store) — это надёжная
   * запись, переживающая перезагрузку. Но пока цикл идёт, смотреть в базу
   * некому: карта миссии в интерфейсе живёт на сокете. Отсюда отдельный
   * вызов — не дубль хранения, а другая задача: показать сейчас.
   */
  broadcastMissionEvent(payload: { event: string; tool?: string; reason?: string; iteration?: number; maxIterations?: number; steps?: number; files?: number }): void {
    try {
      this.broadcast(JSON.stringify({ type: "mission_event", ...payload }));
    } catch (err) {
      log("warn", "orchestrator.mission_broadcast_failed", {
        event: payload.event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  onConnect(connection: import("agents").Connection) {
    log("info", "orchestrator.ws_connect", { connectionId: connection.id });
  }

  onClose(connection: import("agents").Connection) {
    log("info", "orchestrator.ws_close", { connectionId: connection.id });
  }

  /**
   * Чат поверх того же соединения, что и живой стрим задач — не отдельный
   * канал. Формат входящего сообщения: {"type":"chat","text":"..."}.
   * Всё остальное (в частности протокольные кадры самого SDK) — молча
   * игнорируется, а не считается ошибкой: это НЕ единственный потребитель
   * этого сокета.
   *
   * Переписка хранится в D1 через lib/chat-store.ts, а не в SQLite этого
   * объекта: диалог должен переживать выгрузку объекта и быть читаемым из
   * обычных HTTP-роутов, а не только через сокет.
   */
  async onMessage(connection: import("agents").Connection, message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message !== "string") return;

    let parsed: { type?: string; text?: string; conversationId?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // не наш формат — не JSON вовсе
    }
    if (parsed.type !== "chat" || !parsed.text?.trim()) return;

    const userText = parsed.text.trim().slice(0, 4000);
    // Имя экземпляра объекта — это projectId, поэтому оно же годится как
    // идентификатор диалога по умолчанию: один проект — одна переписка,
    // пока пользователь явно не завёл другую.
    const convId = parsed.conversationId ?? this.name ?? "default";

    let replyText: string;
    try {
      await ensureConversation(this.env, convId, this.state.activeProjectId ?? undefined);
      await addMessage(this.env, convId, "user", userText);

      // Последние сообщения — достаточно для связного диалога, без выгрузки
      // всей истории на каждый вызов модели (растущая стоимость на ровном месте).
      const history = (await listMessages(this.env, convId, 20)) as Array<{ role: string; content: string }>;

      const routed = await runModel<{ response?: string }>(this.env, "chat", {
        messages: [
          {
            role: "system",
            content:
              "Ты — AZRAIL, автономный AI software engineer OS. Отвечай кратко, по делу, " +
              "как в обычном чате с разработчиком, который тобой владеет. Ты не выполняешь " +
              "здесь задачи (для этого отдельный вызов /api/task) — здесь только разговор.",
          },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ],
      });
      replyText = extractText(routed.output) || "(пустой ответ модели)";
      await addMessage(this.env, convId, "assistant", replyText, undefined, routed.model);
    } catch (err) {
      // Сбой записи в D1 не должен съесть ответ пользователю — но и молчать
      // о нём нельзя, иначе переписка теряется незаметно.
      replyText = `Не получилось ответить: ${err instanceof Error ? err.message : String(err)}`;
      log("error", "orchestrator.chat_failed", {
        conversationId: convId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    connection.send(JSON.stringify({ type: "chat_reply", conversationId: convId, text: replyText }));
  }

  /**
   * Самопроверка: прогоняет РЕАЛЬНЫЕ рискованные пути и говорит, что именно
   * живо. Модели не вызываются — проверка бесплатна и её можно жать сколько
   * угодно.
   *
   * Зачем: subAgent() до первого деплоя ни разу не выполнялся. Без этой
   * проверки любая поломка в нём выглядела бы как "задача не выполнена" для
   * всех девяти агентов сразу, и причину искали бы перебором. Здесь же сразу
   * видно: поднимается ли каждый агент, проходит ли запись в D1 по цепочке
   * внешних ключей, отвечают ли KV и R2.
   */
  async selfTest(): Promise<{
    ok: boolean;
    agents: Array<{ id: string; ok: boolean; ms: number; error?: string; storageReadable?: boolean }>;
    storage: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
    routing: Array<{
      intent: string;
      chosen: string | null;
      fallbacks: string[];
      noFallback: boolean;
      reasoning: string[];
    }>;
  }> {
    const agents: Array<{ id: string; ok: boolean; ms: number; error?: string; storageReadable?: boolean }> = [];

    for (const entry of AGENT_REGISTRY) {
      const t0 = Date.now();
      try {
        const agent = await this.subAgent(entry.agentClass, `selftest-${entry.id}`);
        const pong = await agent.ping();
        // ok учитывает хранилище: агент, который поднялся, но не может
        // читать своё состояние, работать всё равно не сможет — это
        // отдельный вид поломки, и прятать его за "ок" нельзя.
        agents.push({
          id: entry.id,
          ok: pong.storageReadable,
          ms: Date.now() - t0,
          storageReadable: pong.storageReadable,
          error: pong.storageReadable ? undefined : "агент поднялся, но его хранилище не отвечает",
        });
      } catch (err) {
        agents.push({
          id: entry.id,
          ok: false,
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const storage: Array<{ name: string; ok: boolean; ms: number; error?: string }> = [];
    const probe = async (name: string, fn: () => Promise<unknown>) => {
      const t0 = Date.now();
      try {
        await fn();
        storage.push({ name, ok: true, ms: Date.now() - t0 });
      } catch (err) {
        storage.push({ name, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
      }
    };

    const probeId = `__selftest_${crypto.randomUUID().slice(0, 8)}__`;

    // Полная цепочка записи в D1, включая внешние ключи. Именно она молча
    // не работала до аудита, и именно её нельзя проверить компилятором.
    await probe("D1 (цепочка записи)", async () => {
      const created = await ensureProject(this.env, probeId, "самопроверка");
      if (!created) throw new Error("не удалось создать проект — проверь внешние ключи и схему");
      await this.env.AZRAIL_D1.prepare(
        `INSERT INTO task_history (id, project_id, agent, intent, input_type, status, input_summary)
         VALUES (?, ?, 'selftest', 'unclear', 'text', 'done', 'самопроверка')`,
      )
        .bind(probeId, probeId)
        .run();
      const { results } = await this.env.AZRAIL_D1.prepare("SELECT id FROM task_history WHERE id = ?")
        .bind(probeId)
        .all();
      if (!results?.length) throw new Error("запись прошла, но не читается обратно");
      // Прибираем за собой: порядок обратный вставке из-за внешних ключей.
      await this.env.AZRAIL_D1.prepare("DELETE FROM task_history WHERE id = ?").bind(probeId).run();
      await this.env.AZRAIL_D1.prepare("DELETE FROM projects WHERE id = ?").bind(probeId).run();
    });

    await probe("KV", async () => {
      await this.env.AZRAIL_KV.put(probeId, "1", { expirationTtl: 60 });
      if ((await this.env.AZRAIL_KV.get(probeId)) !== "1") throw new Error("записалось, но не читается");
      await this.env.AZRAIL_KV.delete(probeId);
    });

    await probe("R2", async () => {
      await this.env.AZRAIL_R2.put(`selftest/${probeId}`, "1");
      if (!(await this.env.AZRAIL_R2.head(`selftest/${probeId}`))) throw new Error("записалось, но не находится");
      await this.env.AZRAIL_R2.delete(`selftest/${probeId}`);
    });

    // Какую модель выберет маршрутизатор — без единого вызова модели.
    // Показывает решение ДО того, как оно будет стоить денег.
    const routing = ["generate_code", "classify", "embeddings"].map((intent) => {
      // Передаём РЕАЛЬНОЕ состояние шлюза: иначе показ маршрута разошёлся
      // бы с тем, что произойдёт при настоящем вызове.
      const d = route(intent, { gatewayAvailable: !!this.env.AI_GATEWAY_ID });
      return {
        intent,
        chosen: d.candidates[0]?.slug ?? null,
        fallbacks: d.candidates.slice(1).map((c) => c.slug),
        // Единственный кандидат означает отсутствие запасного варианта:
        // исчерпается лимит или ляжет провайдер — задача не выполнится
        // вообще. Чаще всего это следствие незаданного AI_GATEWAY_ID,
        // без которого сторонние модели недоступны.
        noFallback: d.candidates.length === 1,
        reasoning: d.reasoning,
      };
    });

    const ok = agents.every((a) => a.ok) && storage.every((s) => s.ok);
    log(ok ? "info" : "error", "selftest.finished", {
      agentsFailed: agents.filter((a) => !a.ok).map((a) => a.id),
      storageFailed: storage.filter((s) => !s.ok).map((s) => s.name),
    });
    return { ok, agents, storage, routing };
  }

  async handleTask(request: TaskRequest): Promise<TaskResult> {
    const taskId = crypto.randomUUID();

    // Шаг 2 — проверка достаточности данных
    const missing = this.checkSufficiency(request);
    if (missing.length > 0) {
      return {
        status: "needs_input",
        agent: "orchestrator",
        summary: "Недостаточно данных для выполнения задачи.",
        questions: missing,
      };
    }

    // Шаг 1 — определить намерение
    const intent = request.intent ?? (await this.classifyIntent(request));

    this.setState({
      activeProjectId: request.projectId ?? this.state.activeProjectId,
      lastIntent: intent,
      taskCount: this.state.taskCount + 1,
    });

    this.sql`
      INSERT INTO local_tasks (id, intent, status, started_at)
      VALUES (${taskId}, ${intent}, 'running', ${new Date().toISOString()})
    `;

    // Строка проекта обязана существовать до записи в task_history:
    // у таблицы внешний ключ на projects(id). См. lib/project.ts.
    if (request.projectId) {
      await ensureProject(this.env, request.projectId);
    }
    await this.recordHistory(taskId, request, intent, "running");

    let result: TaskResult;
    try {
      // Маршрутизация идёт через реестр: Orchestrator ищет ВОЗМОЖНОСТЬ, а не
      // имя агента. Здесь остались только два случая — те, где задача реально
      // не сводится к одному вызову, а образует цепочку из двух агентов.
      if (intent === "analyze_spec" || intent === "generate_code") {
        // Свежая спецификация или генерация с нуля — сначала план архитектуры.
        // review_repo сюда не попадает: там архитектура уже есть, её надо
        // ревьюить, а не проектировать заново.
        const plan = await this.runCapability("architecture", request);

        if (plan.status !== "done") {
          result = plan; // needs_input/failed на планировании — дальше не идём
        } else {
          const planData = plan.data as { output?: string; diagram?: string | null } | undefined;
          const codeResult = await this.runCapability("code_generation", {
            ...request,
            architecturePlan: planData?.output,
          });

          result = {
            ...codeResult,
            data: {
              ...(codeResult.data && typeof codeResult.data === "object" ? codeResult.data : {}),
              architecturePlan: planData?.output,
              architectureDiagram: planData?.diagram,
            },
          };

          // Та же опциональная сшивка, что и у generate_ui ниже: коммитим
          // сгенерированные файлы ТОЛЬКО по явному commitToBranch. Раньше
          // этого не было вовсе — Code Agent мог вернуть files, но дальше
          // они никуда не уходили, отсюда и "почему он ничего не делает".
          if (result.status === "done" && request.commitToBranch) {
            const files = (result.data as { files?: GeneratedFile[] } | undefined)?.files ?? [];
            result = {
              ...result,
              data: {
                ...(result.data && typeof result.data === "object" ? result.data : {}),
                commits: await this.commitFiles(request, files),
              },
            };
          }
        }
      } else if (intent === "generate_ui") {
        result = await this.runCapability("ui_generation", request);

        // Опциональная сшивка: сгенерированные файлы сразу в репозиторий.
        // Только по явному commitToBranch — молча коммитить в чужую ветку
        // то, что сгенерила модель, нельзя.
        if (result.status === "done" && request.commitToBranch) {
          const files = (result.data as { files?: GeneratedFile[] } | undefined)?.files ?? [];
          result = {
            ...result,
            data: {
              ...(result.data && typeof result.data === "object" ? result.data : {}),
              commits: await this.commitFiles(request, files),
            },
          };
        }
      } else {
        // Всё остальное — один агент, найденный по возможности.
        // unclear уходит в code_review как наименее разрушительный дефолт:
        // разбор без изменений безопаснее генерации по неясному запросу.
        const capability = capabilityForIntent(intent) ?? "code_review";
        result = await this.runCapability(capability, request);
      }
    } catch (err) {
      result = {
        status: "failed",
        agent: "orchestrator",
        summary: "Сбой при выполнении задачи.",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.sql`UPDATE local_tasks SET status = ${result.status} WHERE id = ${taskId}`;
    // result.agent — тот, кто РЕАЛЬНО выполнял. Раньше сюда всегда шло
    // "orchestrator", из-за чего Evolution Agent видел один агент на все сбои.
    await this.recordHistory(taskId, request, intent, result.status, result.summary, result.error ?? null, result.agent);
    return result;
  }

  /** Поднимает агента, умеющего нужную возможность, и выполняет задачу.
   *  Единственное место, где вообще создаётся инстанс агента — маршрутизация
   *  выше знает только возможности, не имена и не классы. */
  /**
   * Позвать агента по возможности — снаружи Durable Object.
   *
   * Цикл выполнения (core/execution-engine.ts) — обычный класс, а не
   * Durable Object, поэтому subAgent() ему недоступен. Без этого метода
   * инструменты open_pr / git_diff / run_tests пришлось бы дублировать
   * заново поверх GitHub API — то есть завести второй путь к тому же, со
   * своей отдельной проверкой путей и своими будущими расхождениями.
   *
   * Здесь тот же runCapability, что использует handleTask: один путь,
   * один набор проверок.
   */
  async invokeCapability(capability: Capability, request: TaskRequest): Promise<TaskResult> {
    return this.runCapability(capability, request);
  }

  private async runCapability(capability: Capability, request: TaskRequest): Promise<TaskResult> {
    const candidates = findByCapability(capability);
    if (candidates.length === 0) {
      // Возможность объявлена в маппинге, но агента под неё нет — это баг
      // конфигурации, и молчать о нём нельзя.
      return {
        status: "failed",
        agent: "orchestrator",
        summary: `В реестре нет агента с возможностью "${capability}".`,
      };
    }
    const entry = candidates[0];
    const agent = await this.subAgent(entry.agentClass, `${entry.id}-${request.projectId ?? "default"}`);
    return agent.run(request);
  }

  /** Коммитит сгенерированные файлы через Git Agent — по файлу за коммит
   *  (Contents API атомарен на файл). Неуспешные не глотаем: каждый файл
   *  возвращает свой статус, чтобы частичный коммит был виден. */
  private async commitFiles(request: TaskRequest, files: GeneratedFile[]) {
    if (files.length === 0) return [];
    const gitAgent = await this.subAgent(GitAgent, `git-${request.projectId ?? "default"}`);
    const out: Array<{ path: string; status: string; detail: string }> = [];

    for (const file of files) {
      const res = await gitAgent.run({
        projectId: request.projectId,
        gitRepo: request.gitRepo,
        gitOp: {
          type: "commit_file",
          branch: request.commitToBranch!,
          path: file.path,
          content: file.content,
          message: `AZRAIL UI Agent: ${file.path}`,
        },
      });
      out.push({ path: file.path, status: res.status, detail: res.error ?? res.summary });
    }
    return out;
  }

  async getHistory(projectId: string, limit = 20) {
    const { results } = await this.env.AZRAIL_D1.prepare(
      `SELECT id, agent, intent, input_type, status, output_summary, error, started_at, finished_at
       FROM task_history WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
      .bind(projectId, limit)
      .all();
    return results;
  }

  private checkSufficiency(request: TaskRequest): string[] {
    const questions: string[] = [];

    // Структурные входы самодостаточны: у Git-операции нет "содержимого задачи"
    // в смысле текста или файла, и требовать payload здесь неверно — полноту
    // самой операции проверяет соответствующий агент. Из QA-операций так же
    // самодостаточны те, что ходят в GitHub Actions; coverage_gaps — исключение,
    // ему нужны исходники, поэтому он проверяется как обычная задача.
    if (request.gitOp) return questions;
    // Evolution работает от накопленной истории в D1, а не от приложенного входа.
    if (request.intent === "evolution_audit") return questions;
    if (request.qaOp && request.qaOp.type !== "coverage_gaps") return questions;

    if (!request.payload && !request.r2Key) {
      questions.push(
        "Пришли содержимое задачи: текст, ключ загруженного в AZRAIL_R2 файла (ZIP/PDF/DOCX), либо GitHub-репозиторий вида owner/name.",
      );
    }
    if (request.payload && request.payload.trim().length < MIN_PAYLOAD_LENGTH && !request.r2Key) {
      questions.push("Описание слишком короткое — уточни цель проекта или задачи.");
    }
    if ((request.inputType === "zip" || request.inputType === "pdf" || request.inputType === "docx") && !request.r2Key) {
      questions.push(`Для input_type="${request.inputType}" нужен r2Key — сначала загрузи файл в AZRAIL_R2.`);
    }
    if (request.inputType === "github" && !/^[\w.-]+\/[\w.-]+$/.test(request.payload ?? "")) {
      questions.push('Для input_type="github" payload должен быть в формате "owner/repo".');
    }
    return questions;
  }

  private async classifyIntent(request: TaskRequest): Promise<Intent> {
    // Структурная gitOp в запросе — однозначный сигнал, модель тут не нужна.
    if (request.gitOp) return "git_operation";
    if (request.qaOp) return "qa_check";
    // designBrief/commitToBranch осмысленны только для UI-генерации.
    if (request.designBrief || request.commitToBranch) return "generate_ui";

    // Быстрая эвристика по типу входа — соответствует таблице маршрутизации
    // из раздела 4 системного промпта, без обращения к модели.
    if (request.inputType === "pdf") return "analyze_spec";
    if (request.inputType === "zip" || request.inputType === "github") return "review_repo";

    // Свободный текст — классификация моделью
    try {
      // Классификация — самая частая и самая дешёвая операция: вызывается
      // на КАЖДОМ свободнотекстовом запросе. Политика "classify" в реестре
      // намеренно предпочитает быстрые модели: одно слово на выходе от
      // frontier-модели не станет точнее, а стоить будет заметно дороже.
      const routed = await runModel<{ response?: string }>(this.env, "classify", {
        messages: [
          {
            role: "system",
            content:
              "Классифицируй запрос ровно одним словом из списка: analyze_spec, review_repo, generate_code, deploy, git_operation, generate_ui, security_scan, qa_check, evolution_audit, unclear. generate_ui — если просят интерфейс, компонент, экран, вёрстку. security_scan — если просят проверить безопасность, уязвимости, утечки ключей, зависимости. qa_check — если просят про тесты, покрытие, прогон CI, качество. evolution_audit — если просят аудит проекта целиком, что улучшить, что устарело, где узкие места. Ответь только этим словом, без пояснений.",
          },
          { role: "user", content: (request.payload ?? "").slice(0, 2000) },
        ],
      }, {
        complexity: "trivial",
        // Классификатор обязан вернуть ОДНО слово из закрытого списка.
        // Проза вместо метки означает, что модель не справилась с форматом.
        // Без этой проверки мы молча получили бы "unclear" и отправили
        // задачу не туда — то есть тихая деградация вместо явного отказа.
        validate: (out: { response?: string }) => {
          const text = extractText(out).toLowerCase();
          return ALLOWED_INTENTS.some((i) => text.includes(i))
            ? true
            : "ответ не содержит ни одной известной метки намерения";
        },
      });
      // Через extractText, а не через .response: форм ответа у Workers AI
      // несколько, и при { choices } поле response равно undefined. Тогда raw
      // становился пустым, намерение — "unclear", а unclear по умолчанию
      // уходит в code_review (см. ниже). То есть ЛЮБАЯ фраза — «сделай сайт»,
      // «проверь безопасность» — молча превращалась в обзор кода.
      const raw = extractText(routed.output).trim().toLowerCase();
      return ALLOWED_INTENTS.find((i) => raw.includes(i)) ?? "unclear";
    } catch (err) {
      // Молчаливый возврат "unclear" прятал отказ модели: со стороны это
      // выглядело как «запрос непонятный», хотя классификатор просто упал.
      log("error", "orchestrator.classify_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return "unclear";
    }
  }

  private async recordHistory(
    id: string,
    request: TaskRequest,
    intent: Intent,
    status: TaskResult["status"] | "running",
    outputSummary?: string,
    error?: string | null,
    /** Кто фактически выполнял. На старте задачи ещё неизвестен — тогда "orchestrator". */
    actualAgent = "orchestrator",
  ) {
    const finishedAt = status === "running" ? null : new Date().toISOString();

    // Живой стрим для тех, кто подключён по WebSocket (см. onConnect ниже).
    // До этой правки прогресс задачи был виден только ПОСЛЕ её завершения —
    // ради этого места и заводился весь WebSocket-канал. Рассылка не должна
    // ронять запись в D1 ниже, если вдруг сама упадёт (нет причин, но
    // соединения — внешний, менее предсказуемый канал, чем собственная база).
    try {
      this.broadcast(JSON.stringify({
        type: "task_event",
        taskId: id,
        intent,
        status,
        agent: actualAgent,
        summary: outputSummary ?? null,
        error: error ?? null,
        at: finishedAt ?? new Date().toISOString(),
      }));
    } catch (broadcastErr) {
      log("warn", "orchestrator.broadcast_failed", {
        taskId: id,
        error: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
      });
    }

    try {
      // Гарантия проекта здесь, а не только у вызывающего: функция не должна
      // зависеть от порядка вызовов. ensureProject кеширует результат,
      // поэтому повторный вызов практически бесплатен.
      if (request.projectId) {
        await ensureProject(this.env, request.projectId);
      }
      await this.env.AZRAIL_D1.prepare(
        `INSERT INTO task_history (id, project_id, agent, intent, input_type, status, input_summary, output_summary, error, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent,
           status = excluded.status,
           output_summary = excluded.output_summary,
           error = excluded.error,
           finished_at = excluded.finished_at`,
      )
        .bind(
          id,
          request.projectId ?? null,
          actualAgent,
          intent,
          request.inputType ?? null,
          status,
          (request.payload || request.r2Key || "").slice(0, 500),
          outputSummary ?? null,
          error ?? null,
          finishedAt,
        )
        .run();
    } catch (err) {
      // Задачу из-за аналитики не роняем, но и не молчим: именно молчание
      // здесь скрывало то, что внешние ключи роняли КАЖДУЮ вставку, и
      // история оставалась пустой без единого признака проблемы.
      log("error", "history.write_failed", {
        taskId: id,
        projectId: request.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
