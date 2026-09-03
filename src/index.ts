import { getAgentByName, routeAgentRequest } from "agents";
import type { Env, TaskRequest, TaskResult } from "./types";
import { getCors } from "./lib/cors";
import { Orchestrator } from "./agents/orchestrator";
import { forgetFact, listFacts, type MemoryCategory } from "./lib/memory-agent";
import { listVersions, restoreVersion } from "./lib/versions";
import { handleUpload } from "./lib/upload";
import { describeRegistry, allCapabilities } from "./lib/agent-registry";
import { describeTools } from "./lib/tool-registry";
import { addMessage, deleteConversation, ensureConversation, listMessages } from "./lib/chat-store";
import { ExecutionEngine } from "./core/execution-engine";
import { listMissionEvents } from "./lib/event-store";
import { MODEL_REGISTRY } from "./lib/model-registry";
import { extractText, runModel } from "./lib/model-router";
import { checkAuth, checkRateLimit } from "./lib/auth";
import { chargeWrites, estimateMissionWrites } from "./lib/write-budget";
import { log } from "./lib/resilience";

export { Orchestrator };

// Дочерние агенты ОБЯЗАНЫ быть экспортированы отсюда: subAgent() ищет класс
// в ctx.exports по его имени (`ctx.exports[cls.name]`) и, не найдя, бросает
// "Sub-agent class ... not found in worker exports".
//
// Имена экспортов должны в точности совпадать с именами классов — SDK
// сопоставляет именно по cls.name, поэтому переименование экспорта здесь
// сломает подъём агента в рантайме, не сломав при этом сборку.
//
// Отдельных записей в [[migrations]] им не требуется: subAgent поднимает их
// как facets внутри Orchestrator, а не как самостоятельные Durable Objects.
export { ArchitectAgent } from "./agents/architect-agent";
export { CodeAgent } from "./agents/code-agent";
export { UiAgent } from "./agents/ui-agent";
export { GitAgent } from "./agents/git-agent";
export { DeployAgent } from "./agents/deploy-agent";
export { SecurityAgent } from "./agents/security-agent";
export { QaAgent } from "./agents/qa-agent";
export { EvolutionAgent } from "./agents/evolution-agent";

/** Потолок тела для /api/task. Файлы идут через /api/upload, здесь только JSON. */
const MAX_TASK_BODY_BYTES = 1024 * 1024;

function json(data: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: getCors(env, { "Content-Type": "application/json" }),
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: getCors(env) });
    }

    // НАЙДЕНО ПРИ АУДИТЕ: до этой правки try/catch стоял только в четырёх
    // локальных местах (парсинг тела /api/task, /api/upload, DELETE памяти,
    // восстановление версии). Всё остальное — /api/history, /api/memory GET,
    // сам /api/upload изнутри lib/upload.ts (R2.put ничем не накрыт) — при
    // непойманном throw улетало бы наружу как голая ошибка платформы
    // Cloudflare без единой строки в структурных логах и без JSON-ответа,
    // которого ждёт клиент. Общая сетка ниже не меняет поведение уже
    // обработанных путей — она ловит только то, что раньше не ловилось нигде.
    try {
      return await handleRequest(request, env);
    } catch (err) {
      log("error", "fetch.uncaught", {
        path: new URL(request.url).pathname,
        method: request.method,
        error: err instanceof Error ? err.message : String(err),
      });
      return json({ error: "Внутренняя ошибка." }, env, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Раньше здесь проверялось только наличие биндинга (`!!env.AZRAIL_D1`) —
      // это показывало "всё зелено" даже когда D1 недоступна. Теперь делается
      // реальный round-trip к каждому сервису.
      const check = async (name: string, probe: () => Promise<unknown>) => {
        const t0 = Date.now();
        try {
          await probe();
          return { name, status: "ok" as const, ms: Date.now() - t0, error: null };
        } catch (err) {
          return {
            name,
            status: "error" as const,
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      };

      const services = await Promise.all([
        env.AZRAIL_D1
          ? check("d1", () => env.AZRAIL_D1.prepare("SELECT 1").all())
          : Promise.resolve({ name: "d1", status: "absent" as const, ms: null, error: null }),
        env.AZRAIL_KV
          ? check("kv", () => env.AZRAIL_KV.get("__healthcheck__")) // отсутствие ключа — не ошибка, важен сам ответ
          : Promise.resolve({ name: "kv", status: "absent" as const, ms: null, error: null }),
        env.AZRAIL_R2
          ? check("r2", () => env.AZRAIL_R2.head("__healthcheck__"))
          : Promise.resolve({ name: "r2", status: "absent" as const, ms: null, error: null }),
      ]);

      // AI/Vectorize/Queue намеренно не пробуем: вызов модели ради health-check
      // стоит денег и времени, а put в очередь порождал бы мусорные сообщения.
      // Для них честнее показать наличие биндинга и так и назвать это.
      const bindingsOnly = {
        ai: !!env.AI ? "bound" : "absent",
        vectorize: !!env.AZRAIL_VECTORIZE ? "bound" : "absent",
        queue: !!env.AZRAIL_QUEUE ? "bound" : "absent",
      };

      const degraded = services.some((s) => s.status !== "ok");
      return json(
        {
          system: "AZRAIL OS",
          status: degraded ? "degraded" : "healthy",
          services, // реально проверены round-trip'ом
          bindings: bindingsOnly, // только наличие биндинга, не проверка работоспособности
          agents: describeRegistry().length,
          timestamp: new Date().toISOString(),
        },
        env,
        degraded ? 503 : 200,
      );
    }

    // ─── Граница защиты ───────────────────────────────────────────────
    // Всё, что ниже, тратит деньги (модели) или раскрывает данные проекта.
    // Проверка стоит ОДНИМ местом, а не в каждом роуте.
    //
    // ВАЖНО: ни один защищённый роут не должен обрабатываться ВЫШЕ этого
    // блока. Здесь уже была ровно такая ошибка — /api/agents отвечал раньше
    // проверки и по факту был открыт, хотя числился в списке защищённых.
    // Тест в tests/regressions.test.ts ("Регрессия: порядок роутов и
    // защита") следит, чтобы это не повторилось. Раньше здесь была ссылка
    // на несуществующий tests/routes.test.ts — файла с таким именем в
    // проекте нет, тест живёт в общем регрессионном файле.
    const isProtected =
      url.pathname === "/api/task" ||
      url.pathname === "/api/upload" ||
      url.pathname === "/api/agents" ||
      url.pathname === "/api/selftest" ||
      url.pathname === "/api/models" ||
      url.pathname === "/api/tools" ||
      url.pathname === "/api/chat" ||
      url.pathname === "/api/mission" ||
      url.pathname === "/api/conversations" ||
      url.pathname === "/api/polish" ||
      url.pathname === "/api/stream" ||
      url.pathname.startsWith("/api/projects/");

    if (isProtected) {
      const auth = checkAuth(request, env);
      if (!auth.ok) {
        log("warn", "auth.rejected", { path: url.pathname, status: auth.status });
        return json({ error: auth.error }, env, auth.status ?? 401);
      }

      // Лимит — на всё, что реально запускает модели. Раньше здесь стоял
      // только /api/task, и это была дыра: /api/mission прогоняет ЦИКЛ до
      // двадцати вызовов модели, а лимита на нём не было вовсе. Самый
      // дорогой путь оказывался единственным неограниченным.
      //
      // Стоимость разная, потому что расход разный. Миссия списывается по
      // заявленному потолку шагов, а не по факту: списать после выполнения
      // — значит сначала потратить, потом узнать, что было нельзя.
      const MODEL_ROUTES: Record<string, number> = {
        "/api/task": 1,
        "/api/chat": 1,
        "/api/polish": 1,
        "/api/mission": 0, // считается ниже по maxIterations
      };
      if (url.pathname in MODEL_ROUTES) {
        let cost = MODEL_ROUTES[url.pathname];
        if (url.pathname === "/api/mission") {
          // Тело нужно прочитать заранее, чтобы узнать потолок шагов.
          // Request можно прочитать один раз, поэтому дальше по коду идёт
          // клон — иначе роут получил бы уже опустошённый поток.
          const peek = await request.clone().json().catch(() => ({}) as { maxIterations?: number });
          const asked = Number((peek as { maxIterations?: number }).maxIterations) || 8;
          cost = Math.max(1, Math.min(asked, 20));
        }
        const rl = await checkRateLimit(env, auth.caller ?? "shared", cost);
        if (!rl.allowed) {
          log("warn", "ratelimit.exceeded", { caller: auth.caller, used: rl.used, limit: rl.limit });
          return json(
            {
              error: `Лимит исчерпан: ${rl.used} из ${rl.limit} задач в час. Сбросится в ${new Date(rl.resetAt).toISOString()}.`,
              used: rl.used,
              limit: rl.limit,
              resetAt: rl.resetAt,
            },
            env,
            429,
          );
        }
      }
    }

    if (url.pathname === "/api/stream") {
      // Апгрейд до WebSocket — GET-запрос со спецзаголовком, не отдельный
      // метод. Здесь минимальная проверка формы запроса; сам апгрейд и
      // onConnect/onMessage/onClose делает SDK внутри Orchestrator.fetch().
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "Этот путь только для WebSocket-подключения (заголовок Upgrade: websocket)." }, env, 426);
      }
      const instanceName = url.searchParams.get("projectId") ?? "default";
      const orchestrator = await getAgentByName(env.Orchestrator, instanceName);
      return orchestrator.fetch(request);
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      // Список для выпадающего меню в интерфейсе. Раньше слаг вводился
      // руками — опечатка выяснялась только при падении задачи.
      // Отдаём ровно то, что нужно для выбора: сам слаг, кто сделал, класс.
      // Ключей и внутренних причин выбора здесь нет.
      return json(
        {
          success: true,
          models: MODEL_REGISTRY.map((m) => ({
            slug: m.slug,
            provider: m.provider,
            tier: m.tier,
            capabilities: m.capabilities,
            // Модель, требующая Gateway, без AI_GATEWAY_ID не заработает —
            // интерфейс должен показать это ДО выбора, а не после ошибки.
            available: !m.requiresGateway || Boolean(env.AI_GATEWAY_ID),
          })),
        },
        env,
      );
    }

    if (url.pathname === "/api/tools" && request.method === "GET") {
      // Что AZRAIL умеет прямо сейчас. `available` здесь означает «есть
      // рабочий адаптер», а не «запланировано» — см. lib/tool-registry.ts.
      return json({ success: true, tools: describeTools() }, env);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = (await request.json()) as {
        message?: string;
        projectId?: string;
        conversationId?: string;
        parentMessageId?: string;
        preferredModel?: string;
      };
      const message = body.message?.trim();
      if (!message) return json({ error: "message обязателен." }, env, 400);

      const cid = body.conversationId ?? body.projectId ?? crypto.randomUUID();
      await ensureConversation(env, cid, body.projectId);
      await addMessage(env, cid, "user", message, body.parentMessageId);

      const orchestrator = await getAgentByName(env.Orchestrator, body.projectId ?? "default");
      // Аннотация типа обязательна: через RPC-стаб Durable Object возвращаемый
      // тип схлопывается в never, и без неё сборка падает восемью ошибками
      // подряд на обращениях к полям результата.
      const result: TaskResult = await orchestrator.handleTask({
        projectId: body.projectId,
        conversationId: cid,
        parentMessageId: body.parentMessageId,
        inputType: "text",
        message,
        payload: message,
        preferredModel: body.preferredModel,
      });

      const assistantId = await addMessage(
        env,
        cid,
        "assistant",
        result.error ?? result.summary,
        body.parentMessageId,
      );
      return json(
        { success: true, conversationId: cid, assistantMessageId: assistantId, result },
        env,
        result.status === "failed" ? 500 : result.status === "needs_input" ? 422 : 200,
      );
    }

    if (url.pathname === "/api/chat" && request.method === "GET") {
      const conversation = url.searchParams.get("conversationId");
      if (!conversation) return json({ error: "conversationId обязателен." }, env, 400);
      return json({ success: true, messages: await listMessages(env, conversation) }, env);
    }

    if (url.pathname === "/api/chat" && request.method === "DELETE") {
      const conversation = url.searchParams.get("conversationId");
      if (!conversation) return json({ error: "conversationId обязателен." }, env, 400);
      await deleteConversation(env, conversation);
      return json({ success: true }, env);
    }

    if (url.pathname === "/api/mission" && request.method === "POST") {
      // Автономный режим: AZRAIL сам решает, какие инструменты звать.
      // Отличается от /api/task тем, что там один агент делает один проход,
      // а здесь цикл из нескольких шагов с обратной связью.
      const body = (await request.json()) as {
        message?: string;
        projectId?: string;
        maxIterations?: number;
        preferredModel?: string;
      };
      const goal = body.message?.trim();
      if (!goal) return json({ error: "message обязателен." }, env, 400);
      if (!body.projectId) return json({ error: "projectId обязателен для миссии." }, env, 400);

      /* Бюджет записей — до начала работы, не после.
       *
       * Cloudflare не даёт жёсткого потолка расходов: о превышении
       * узнают по счёту. Списываем по ЗАЯВЛЕННОЙ стоимости миссии
       * заранее — узнать о перерасходе после того, как записи сделаны,
       * бесполезно.
       *
       * На бесплатном плане это лишняя предосторожность: там переплата
       * невозможна. Она нужна ровно с того дня, когда план станет
       * платным, и поставить её надо ДО этого дня.
       */
      const budget = await chargeWrites(env, estimateMissionWrites(Number(body.maxIterations) || 8));
      // Остаток уходит в ответ: интерфейс должен показать приближение к
      // потолку ЗАРАНЕЕ, а не сообщить об упоре в него постфактум.
      if (!budget.allowed) {
        return json(
          {
            error:
              `Достигнут часовой потолок операций записи (${budget.used}/${budget.limit}). ` +
              `Это защита от неконтролируемого счёта, а не сбой. Потолок задаётся переменной AZRAIL_WRITE_BUDGET.`,
          },
          env,
          429,
        );
      }

      const missionId = crypto.randomUUID();
      // Эта запись ОБЯЗАНА пройти, и падать здесь правильно: без строки в
      // missions миссию нечем отслеживать и не к чему привязать события.
      // Отказ ДО работы дешевле, чем осиротевший прогон, потративший модели.
      try {
        await env.AZRAIL_D1.prepare(
          `INSERT INTO missions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(missionId, body.projectId, goal, "executing", new Date().toISOString())
          .run();
      } catch (err) {
        log("error", "mission.create_failed", {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return json(
          {
            error:
              "Не удалось создать миссию в базе. Частая причина — не применена схема: " +
              "wrangler d1 execute azrail-db --remote --file=./schema.sql",
          },
          env,
          500,
        );
      }

      const engine = new ExecutionEngine(env);
      // Оркестратор нужен только как канал вещания: сама миссия исполняется
      // здесь, но карта шагов в интерфейсе живёт на его сокете.
      const missionSocket = await getAgentByName(env.Orchestrator, body.projectId);
      const result = await engine.runMission(
        { message: goal, projectId: body.projectId, preferredModel: body.preferredModel },
        {
          missionId,
          projectId: body.projectId,
          iteration: 0,
          maxIterations: body.maxIterations ?? 8,
          preferredModel: body.preferredModel,
          onEvent: (payload) => missionSocket.broadcastMissionEvent(payload),
          // Мост к агентам: сам движок не Durable Object и subAgent()
          // позвать не может. Через это git_diff и run_tests идут тем же
          // путём, что и обычные задачи, — без второй копии работы с
          // GitHub API и её отдельных проверок.
          invokeCapability: (capability, req) => missionSocket.invokeCapability(capability, req),
        },
      );

      // А ВОТ ЗДЕСЬ падать нельзя. Работа уже сделана, файлы записаны,
      // модели потрачены — и уронить всё это из-за неудавшейся отметки о
      // завершении значит отдать пользователю ошибку вместо готового
      // результата. Статус в базе останется "executing"; это неточность в
      // журнале, а не потеря работы.
      const finishedAt = new Date().toISOString();
      try {
        await env.AZRAIL_D1.prepare(
          `UPDATE missions SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(
            result.status === "done" ? "completed" : result.status === "failed" ? "failed" : "waiting_approval",
            finishedAt,
            finishedAt,
            missionId,
          )
          .run();
      } catch (err) {
        log("error", "mission.status_write_failed", {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Бюджет и остаток уходят в ответ: интерфейс предупреждает о
      // приближении к потолку заранее, а не сообщает об упоре постфактум.
      return json({ success: true, budget: { used: budget.used, limit: budget.limit, remaining: budget.remaining }, missionId, result }, env, result.status === "failed" ? 500 : 200);
    }

    if (url.pathname === "/api/mission" && request.method === "GET") {
      const missionId = url.searchParams.get("missionId");
      if (!missionId) return json({ error: "missionId обязателен." }, env, 400);
      const mission = await env.AZRAIL_D1.prepare(`SELECT * FROM missions WHERE id = ?`).bind(missionId).first();
      if (!mission) return json({ error: "Миссия не найдена." }, env, 404);
      /* Полная трассировка прогона.
       *
       * Эти четыре таблицы ПИСАЛИСЬ и никогда не читались: план, вызовы
       * инструментов, вердикты проверок и заблокированные запросы
       * копились в базе, и достать их было нечем. Данные для отладки и
       * для сравнения прогонов уже собирались — просто не отдавались.
       *
       * Каждый запрос обёрнут отдельно: отсутствие одной таблицы (схема
       * применена не полностью — обычный случай при обновлении) не
       * должно лишать трассировки целиком. */
      const pick = async <T>(sql: string): Promise<T[]> => {
        try {
          const { results } = await env.AZRAIL_D1.prepare(sql).bind(missionId).all<T>();
          return results ?? [];
        } catch {
          return [];
        }
      };

      return json(
        {
          success: true,
          mission,
          events: await listMissionEvents(env, missionId),
          plan: await pick(`SELECT position, title, status, note FROM mission_steps WHERE mission_id = ? ORDER BY position`),
          calls: await pick(
            `SELECT tool, status, started_at, finished_at FROM tool_calls WHERE mission_id = ? ORDER BY started_at`,
          ),
          checks: await pick(`SELECT attempt, passed, reason, created_at FROM mission_checks WHERE mission_id = ? ORDER BY attempt`),
          blocked: await pick(`SELECT action, status FROM approvals WHERE mission_id = ?`),
        },
        env,
      );
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      // Список диалогов для боковой панели. Превью — первое сообщение
      // пользователя, а не служебный заголовок: по нему диалог узнаётся.
      const { results } = await env.AZRAIL_D1.prepare(
        `SELECT c.id, c.project_id, c.created_at,
                (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user'
                 ORDER BY m.created_at ASC LIMIT 1) AS preview,
                (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = c.id) AS message_count
         FROM conversations c ORDER BY c.created_at DESC LIMIT 50`,
      ).all();
      return json({ success: true, conversations: results }, env);
    }

    if (url.pathname === "/api/polish" && request.method === "POST") {
      // Довести формулировку до рабочей. Отдельно от /api/chat намеренно:
      // черновик и его правка не должны попадать в историю диалога — иначе
      // переписка засорится тем, что пользователь даже не отправлял.
      const body = (await request.json()) as { text?: string; preferredModel?: string };
      const draft = body.text?.trim();
      if (!draft) return json({ error: "text обязателен." }, env, 400);

      const routed = await runModel<{ response?: string }>(
        env,
        "chat",
        {
          messages: [
            {
              role: "system",
              content:
                "Ты дорабатываешь формулировку задачи для AI-разработчика. Верни ТОЛЬКО " +
                "переписанную задачу — без пояснений, без вступлений, без кавычек. " +
                "Сохрани исходный смысл и язык. Сделай конкретнее: добавь недостающие " +
                "технические детали, которые очевидно подразумеваются. Не выдумывай " +
                "требований, которых в исходнике нет.",
            },
            { role: "user", content: draft },
          ],
        },
        { preferredModel: body.preferredModel },
      );
      return json({ success: true, original: draft, polished: extractText(routed.output) || draft }, env);
    }

    if (url.pathname === "/api/selftest" && request.method === "POST") {
      // Моделей не вызывает, поэтому не под лимитом расхода — жать можно
      // сколько угодно, особенно в первые минуты после деплоя.
      const orchestrator = await getAgentByName(env.Orchestrator, "selftest");
      const result = await orchestrator.selfTest();
      return json({ success: result.ok, ...result }, env, result.ok ? 200 : 503);
    }

    if (url.pathname === "/api/agents" && request.method === "GET") {
      return json({ success: true, agents: describeRegistry(), capabilities: allCapabilities() }, env);
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      const result = await handleUpload(request, env);
      if ("error" in result) return json({ error: result.error }, env, result.status);
      return json({ success: true, ...result }, env);
    }

    if (url.pathname === "/api/task" && request.method === "POST") {
      // Ограничение размера тела: без него в память тянется что угодно.
      // Content-Length может отсутствовать (chunked), поэтому это отсечка
      // очевидных случаев, а не гарантия — настоящий потолок даёт платформа.
      const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
      if (declaredLength > MAX_TASK_BODY_BYTES) {
        return json(
          { error: `Тело запроса больше ${MAX_TASK_BODY_BYTES / 1024 / 1024} МБ. Большие файлы грузи через /api/upload.` },
          env,
          413,
        );
      }

      let body: TaskRequest;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Некорректный JSON в теле запроса." }, env, 400);
      }
      if (!body.inputType && !body.gitOp) {
        return json({ error: 'Нужно "inputType" (для задач с содержимым) либо "gitOp" (для Git-операций).' }, env, 400);
      }

      const instanceName = body.projectId ?? "default";
      const t0 = Date.now();
      log("info", "task.received", {
        projectId: body.projectId,
        intent: body.intent,
        inputType: body.inputType,
        hasGitOp: !!body.gitOp,
        hasQaOp: !!body.qaOp,
      });

      const orchestrator = await getAgentByName(env.Orchestrator, instanceName);
      const result: TaskResult = await orchestrator.handleTask(body);

      log(result.status === "failed" ? "error" : "info", "task.finished", {
        projectId: body.projectId,
        agent: result.agent,
        status: result.status,
        ms: Date.now() - t0,
        error: result.error,
      });
      const status = result.status === "failed" ? 500 : result.status === "needs_input" ? 422 : 200;
      return json(result, env, status);
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/history$/) && request.method === "GET") {
      // decodeURIComponent обязателен: клиент шлёт encodeURIComponent(id),
      // а запись в D1 идёт под сырым projectId из тела запроса. Без декода
      // "test 1" сохранялся бы как "test 1", а искался как "test%201".
      const projectId = decodeURIComponent(url.pathname.split("/")[3]);
      const orchestrator = await getAgentByName(env.Orchestrator, projectId);
      const history = await orchestrator.getHistory(projectId);
      return json({ success: true, data: history }, env);
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/memory$/) && request.method === "GET") {
      const projectId = decodeURIComponent(url.pathname.split("/")[3]);
      const facts = await listFacts(env, projectId);
      return json({ success: true, data: facts }, env);
    }

    // Удаление факта из памяти проекта.
    //
    // Пробел, найденный при разборе: факты пишут пять агентов, а способа
    // убрать ОШИБОЧНЫЙ не было вовсе. Память подмешивается в промпт при
    // каждой будущей задаче по проекту — то есть одна галлюцинация модели
    // тихо отравляла бы всю дальнейшую работу, и починить это можно было
    // бы только руками в базе.
    if (url.pathname.match(/^\/api\/projects\/[^/]+\/memory\/[^/]+\/[^/]+$/) && request.method === "DELETE") {
      const parts = url.pathname.split("/");
      const projectId = decodeURIComponent(parts[3]);
      const category = decodeURIComponent(parts[5]) as MemoryCategory;
      const key = decodeURIComponent(parts[6]);
      try {
        await forgetFact(env, projectId, category, key);
        log("info", "memory.forgotten", { projectId, category, key });
        return json({ success: true, forgotten: { category, key } }, env);
      } catch (err) {
        log("error", "memory.forget_failed", {
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return json({ error: "Не удалось удалить факт." }, env, 500);
      }
    }

    // История версий проекта: UI Agent и Code Agent пишут в project_versions
    // с первых версий, но до этой пары маршрутов ничего не читало запись
    // обратно — таблица только наполнялась. См. lib/versions.ts про то, как
    // разбирается разница форматов r2_object_key между двумя агентами.
    if (url.pathname.match(/^\/api\/projects\/[^/]+\/versions$/) && request.method === "GET") {
      const projectId = decodeURIComponent(url.pathname.split("/")[3]);
      const versions = await listVersions(env, projectId);
      return json({ success: true, data: versions }, env);
    }

    // Восстановление ТОЛЬКО отдаёт файлы версии обратно — ничего не
    // коммитит и не деплоит. Осознанно: самомодификация и деплой AZRAIL
    // идут по отдельному, куда более строгому пути (см. ARCHITECTURE-v2.md,
    // «AZRAIL не разворачивает себя. Никогда»), а это — чтение чужого,
    // не своего, проекта.
    if (
      url.pathname.match(/^\/api\/projects\/[^/]+\/versions\/[^/]+\/restore$/) &&
      request.method === "POST"
    ) {
      const parts = url.pathname.split("/");
      const projectId = decodeURIComponent(parts[3]);
      const versionId = decodeURIComponent(parts[5]);
      try {
        const restored = await restoreVersion(env, projectId, versionId);
        if (!restored) {
          return json({ error: "Версия не найдена." }, env, 404);
        }
        // Неполное восстановление поднимается НА ВЕРХНИЙ уровень ответа.
        // Внутри data флаг technically есть, но его никто не читает — а
        // проект, восстановленный наполовину, выглядит целым и не
        // работает. Причину искали бы в коде, а не в ответе API.
        if (restored.truncated) {
          return json(
            {
              success: true,
              data: restored,
              warning:
                `Восстановлены не все файлы версии (взято ${restored.files.length}): ` +
                `версия слишком велика для одного запроса. Проверь состав перед использованием.`,
            },
            env,
          );
        }
        return json({ success: true, data: restored }, env);
      } catch (err) {
        log("error", "version.restore_route_failed", {
          projectId,
          versionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return json({ error: "Не удалось восстановить версию." }, env, 500);
      }
    }

    // GET / отдаёт Cloudflare Assets (public/index.html) до этого хендлера —
    // сюда запрос на "/" не дойдёт, пока в public/ лежит index.html.

    // Маршрутизация напрямую к агентам (WebSocket/RPC от клиента) — на будущее,
    // для панели управления AZRAIL.
    const agentResponse = await routeAgentRequest(request, env, { cors: true });
    if (agentResponse) return agentResponse;

    return new Response("AZRAIL OS — Core API Running", { headers: getCors(env) });
}
