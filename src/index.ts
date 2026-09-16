import { getAgentByName, routeAgentRequest } from "agents";
import type { Env, TaskRequest, TaskResult, AttachmentRef } from "./types";
import { getCors } from "./lib/cors";
import { Orchestrator } from "./agents/orchestrator";
import { forgetFact, listFacts, type MemoryCategory } from "./lib/memory-agent";
import { listVersions, restoreVersion } from "./lib/versions";
import { handleUpload } from "./lib/upload";
import { describeRegistry, allCapabilities } from "./lib/agent-registry";
import { describeTools } from "./lib/tool-registry";
import { addMessage, deleteConversation, ensureConversation, listMessages } from "./lib/chat-store";
import { listMissionEvents } from "./lib/event-store";
import { MODEL_REGISTRY } from "./lib/model-registry";
import { extractText, runModel } from "./lib/model-router";
import { checkAuth, checkRateLimit } from "./lib/auth";
import { chargeWrites, estimateMissionWrites } from "./lib/write-budget";
import { validateAgainstCanon, summarizeCanon } from "./lib/canon-check";
import { loadAttachments, attachmentsToText } from "./lib/attachments";
import { log } from "./lib/resilience";
import {
  MAX_PENDING_HINTS,
  finishMission,
  isTerminal,
  reapStaleMissions,
  requestCancel,
  sendHint,
} from "./lib/mission-state";
import { issueTicket, redeemTicket } from "./lib/ws-ticket";
import { lookup as idemLookup, readKey as idemKey, remember as idemRemember } from "./lib/idempotency";
import { SEED_CASES } from "./bench/cases";
import { runBench } from "./bench/runner";
import { listRuns, loadOutcomes, saveRun } from "./bench/store";
import { runInContainer, detectBackend } from "./core/sandbox";
import { syncWorkspaceToSandbox } from "./core/workspace-sync";

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
// Класс песочницы. НЕ прямой реэкспорт из пакета: наш подкласс применяет
// объявленные лимиты (см. core/azrail-sandbox.ts), иначе SANDBOX_LIMITS
// остаётся документацией, а поведением правит чужое умолчание.
// Wrangler ищет класс по имени из [[containers]].class_name.
export { Sandbox } from "./core/azrail-sandbox";

export { AnswerAgent } from "./agents/answer-agent";
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

  /**
   * КРОН: сборщик зависших миссий.
   *
   * Нужен именно потому, что миссия теперь идёт в фоне. Durable Object
   * можно выселить, инстанс — перезапустить, запланированную задачу —
   * не доставить. Любой из этих случаев оставляет строку в "executing"
   * навсегда, и интерфейс вечно показывает работу, которой давно нет.
   * Сама остановленная миссия о себе не сообщит — сообщить некому.
   *
   * Расписание — в wrangler.toml, [triggers].
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const { reaped } = await reapStaleMissions(env);
          log("info", "cron.reaper_done", { cron: event.cron, reaped });
        } catch (err) {
          log("error", "cron.reaper_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );
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
      url.pathname === "/api/stream/ticket" ||
      // Остановка миссии — тоже платный контур: она меняет состояние
      // чужой работы, и открывать её было бы способом гасить чужие
      // миссии, зная один только идентификатор.
      url.pathname === "/api/mission/cancel" ||
      url.pathname === "/api/mission/hint" ||
      url.pathname === "/api/bench" ||
      url.pathname.startsWith("/api/projects/");

    if (isProtected) {
      /* Билет вместо токена — только для рукопожатия WebSocket.
       *
       * Конструктор WebSocket в браузере не даёт выставить заголовок
       * Authorization, поэтому единственный канал там — строка запроса. А
       * строка запроса оседает в логах Cloudflare, в истории браузера и в
       * Referer, и класть туда ПОСТОЯННЫЙ токен от всех платных
       * эндпоинтов — значит раздать его насовсем.
       *
       * Билет годен минуту и один раз (см. lib/ws-ticket.ts): утечь он
       * может так же легко, но утекает уже мусор. Токен в query всё ещё
       * принимается checkAuth — ради curl и старых клиентов, но интерфейс
       * им больше не пользуется. */
      const ticket = url.pathname === "/api/stream" ? url.searchParams.get("ticket") : null;
      const auth = ticket
        ? await (async () => {
            const caller = await redeemTicket(env, ticket);
            return caller
              ? { ok: true as const, caller }
              : { ok: false as const, status: 401, error: "Билет недействителен или уже использован." };
          })()
        : checkAuth(request, env);
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

    /* Билет на подключение к потоку. Выдаётся по обычному токену в
     * заголовке, живёт минуту и гасится при первом использовании —
     * см. lib/ws-ticket.ts про то, почему постоянному токену не место
     * в строке запроса. */
    if (url.pathname === "/api/stream/ticket" && request.method === "POST") {
      const issued = await issueTicket(env, "shared");
      return json({ success: true, ...issued }, env);
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
        attachments?: AttachmentRef[];
      };
      let goal = body.message?.trim();
      if (!goal) return json({ error: "message обязателен." }, env, 400);
      if (!body.projectId) return json({ error: "projectId обязателен для миссии." }, env, 400);

      // Миссия идёт другим путём, чем /api/task, и вложения ей нужны так
      // же. Починить только один путь значило бы оставить вторую половину
      // сломанной — ровно так этот класс ошибок и живёт долго.
      if (Array.isArray(body.attachments) && body.attachments.length) {
        goal += attachmentsToText(await loadAttachments(env, body.attachments));
      }

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

      /* Повтор того же запроса не должен запускать вторую миссию.
       * Дрогнувшая связь на мобильном интернете, двойное нажатие, повтор
       * от самого клиента — раньше каждый из этих случаев стоил ещё
       * одного полного прогона моделей, и заметить это можно было только
       * по счёту. Ключ необязателен: без него поведение прежнее. */
      const idemScope = "mission";
      const idempotencyKey = idemKey(request);
      if (idempotencyKey) {
        const seen = await idemLookup(env, idemScope, idempotencyKey);
        if (seen) {
          log("info", "mission.idempotent_hit", { missionId: seen.missionId });
          return json(
            { success: true, missionId: seen.missionId, status: "accepted", deduplicated: true },
            env,
            200,
          );
        }
      }

      const missionId = crypto.randomUUID();
      const maxIterations = Math.max(1, Math.min(Number(body.maxIterations) || 8, 20));

      // Эта запись ОБЯЗАНА пройти, и падать здесь правильно: без строки в
      // missions миссию нечем отслеживать и не к чему привязать события.
      // Отказ ДО работы дешевле, чем осиротевший прогон, потративший модели.
      try {
        await env.AZRAIL_D1.prepare(
          `INSERT INTO missions (id, project_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(missionId, body.projectId, goal, "queued", new Date().toISOString(), new Date().toISOString())
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

      /* ── Миссия уходит в фон ───────────────────────────────────────
       *
       * Здесь раньше стоял `await engine.runMission(...)` — весь цикл из
       * восьми-двадцати шагов с вызовами модели исполнялся внутри этого
       * HTTP-запроса. Cloudflare обрывает клиентское соединение примерно
       * на сотой секунде: длинная миссия отдавала 524, результат терялся,
       * а строка в missions навсегда оставалась в "executing", потому что
       * запись финального статуса стояла ПОСЛЕ недостижимого await.
       *
       * Теперь роут только ставит задачу и отдаёт missionId. Работа идёт
       * в Durable Object оркестратора (см. startMission/runMissionTask):
       * у него нет клиентского соединения, обрывать нечего.
       *
       * Ответ 202, а не 200: работа принята, но не выполнена. Клиент
       * следит за ней через WebSocket или опросом GET /api/mission. */
      const missionSocket = await getAgentByName(env.Orchestrator, body.projectId);
      try {
        await missionSocket.startMission({
          missionId,
          projectId: body.projectId,
          goal,
          maxIterations,
          preferredModel: body.preferredModel,
          // Хост берётся ИЗ ЗАПРОСА: на своём домене предпросмотр должен
          // вести на него же, а не на workers.dev. Внутри фоновой задачи
          // запроса уже нет — значит, передать надо сейчас.
          publicHostname: new URL(request.url).hostname,
        });
      } catch (err) {
        // Не удалось поставить в очередь — миссия не должна остаться
        // висеть в "queued" до сборщика зависших: о неудаче известно
        // ПРЯМО СЕЙЧАС, и честнее закрыть её сразу.
        const message = err instanceof Error ? err.message : String(err);
        log("error", "mission.schedule_failed", { missionId, error: message });
        await finishMission(env, missionId, "failed", {
          status: "failed",
          agent: "orchestrator",
          summary: "Не удалось поставить миссию в работу.",
          error: message,
        });
        return json({ error: "Не удалось запустить миссию.", missionId }, env, 500);
      }

      if (idempotencyKey) await idemRemember(env, idemScope, idempotencyKey, missionId);

      // Бюджет и остаток уходят в ответ: интерфейс предупреждает о
      // приближении к потолку заранее, а не сообщает об упоре постфактум.
      return json(
        {
          success: true,
          missionId,
          status: "accepted",
          budget: { used: budget.used, limit: budget.limit, remaining: budget.remaining },
        },
        env,
        202,
      );
    }

    /* Остановка идущей миссии.
     *
     * До этого остановить её было нечем: кнопка «Отменить» в интерфейсе
     * рвала HTTP-соединение, а цикл на сервере продолжал жечь модели и
     * бюджет записей до конца maxIterations, ни о чём не подозревая.
     *
     * Обрыв происходит на границе шага, а не мгновенно: прервать на
     * середине записи файла значит оставить проект в состоянии, которого
     * не было ни до, ни после. */
    if (url.pathname === "/api/mission/cancel" && request.method === "POST") {
      const cancelBody = (await request.json().catch(() => ({}))) as { missionId?: string };
      const id = cancelBody.missionId?.trim();
      if (!id) return json({ error: "missionId обязателен." }, env, 400);

      const outcome = await requestCancel(env, id);
      if (outcome.reason === "not_found") return json({ error: "Миссия не найдена." }, env, 404);
      if (outcome.reason === "already_finished") {
        return json(
          { success: false, missionId: id, status: outcome.status, error: "Миссия уже завершена — останавливать нечего." },
          env,
          409,
        );
      }
      log("info", "mission.cancel_requested", { missionId: id });
      return json({ success: true, missionId: id, status: "cancelling" }, env);
    }

    /* Слово человека посреди идущей миссии.
     *
     * До этого маршрута единственным способом поправить агента на ходу
     * была отмена — то есть убить работу вместе с наработанным
     * контекстом. Подсказка ложится в очередь; цикл забирает её перед
     * следующим шагом, на той же границе, где проверяет отмену. */
    if (url.pathname === "/api/mission/hint" && request.method === "POST") {
      const hintBody = (await request.json().catch(() => ({}))) as { missionId?: string; text?: string };
      const hintId = hintBody.missionId?.trim();
      if (!hintId) return json({ error: "missionId обязателен." }, env, 400);

      const outcome = await sendHint(env, hintId, hintBody.text ?? "");
      if (outcome.reason === "not_found") return json({ error: "Миссия не найдена." }, env, 404);
      if (outcome.reason === "empty") return json({ error: "Пустая подсказка." }, env, 400);
      // Опоздавшая подсказка отклоняется явно: принять её молча значило бы
      // дать человеку думать, что она будет учтена.
      if (outcome.reason === "already_finished") {
        return json(
          { success: false, missionId: hintId, error: "Миссия уже завершена — подсказку некому прочитать." },
          env,
          409,
        );
      }
      if (outcome.reason === "too_many") {
        return json(
          {
            success: false,
            missionId: hintId,
            error: `Очередь подсказок заполнена (${MAX_PENDING_HINTS}). Дождись, пока агент прочитает предыдущие.`,
          },
          env,
          429,
        );
      }
      log("info", "mission.hint_queued", { missionId: hintId });
      return json({ success: true, missionId: hintId }, env);
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

      const plan = await pick(`SELECT position, title, status, note FROM mission_steps WHERE mission_id = ? ORDER BY position`);
      const calls = await pick(
        `SELECT tool, status, started_at, finished_at FROM tool_calls WHERE mission_id = ? ORDER BY started_at`,
      );
      const checks = await pick(`SELECT attempt, passed, reason, created_at FROM mission_checks WHERE mission_id = ? ORDER BY attempt`);

      // Проверка по канону считается ЗДЕСЬ, из уже прочитанных строк:
      // ни одного лишнего запроса, ни одного обращения к модели. Отчёт,
      // который стоит дорого, перестают открывать.
      const canon = validateAgainstCanon({
        calls: (calls as Array<{ tool: string; status: string }>) ?? [],
        checks: (checks as Array<{ attempt: number; passed: number }>) ?? [],
        steps: (plan as unknown[]) ?? [],
        status: (mission as { status?: string } | null)?.status,
      });

      /* Результат миссии теперь ЗДЕСЬ, а не в ответе на POST: POST
       * возвращается сразу, ещё до начала работы. Колонка может
       * отсутствовать на базе, где не применена миграция 002 — тогда
       * поле просто пустое, а не ошибка на весь отчёт. */
      const row = mission as { result_json?: string | null; status?: string } | null;
      let result: unknown = null;
      if (row?.result_json) {
        try {
          result = JSON.parse(row.result_json);
        } catch {
          result = null;
        }
      }

      return json(
        {
          success: true,
          mission,
          // Явный признак «работа идёт» — чтобы клиенту не приходилось
          // угадывать это по набору статусов, которые он знать не обязан.
          done: isTerminal(row?.status),
          result,
          events: await listMissionEvents(env, missionId),
          plan,
          calls,
          checks,
          blocked: await pick(`SELECT action, status FROM approvals WHERE mission_id = ?`),
          canon: { summary: summarizeCanon(canon), principles: canon },
        },
        env,
      );
    }

    /* ИЗМЕРИТЕЛЬ КАЧЕСТВА.
     *
     * Отвечает на единственный вопрос, на который до него ответить было
     * нельзя: стало лучше или хуже после правки в промптах, в выборе
     * модели, в цикле выполнения. Одна миссия этого не показывает —
     * разброс между двумя запусками одной задачи больше, чем разница
     * между двумя версиями промпта.
     *
     * ПРОГОН ДОРОГОЙ: каждая задача — это полная миссия с вызовами
     * моделей и записями. Поэтому явное подтверждение (confirm) и
     * последовательное исполнение, а не параллельное. */
    if (url.pathname === "/api/bench" && request.method === "POST") {
      const benchBody = (await request.json().catch(() => ({}))) as {
        confirm?: boolean;
        only?: string[];
        note?: string;
      };

      if (!benchBody.confirm) {
        // Отказ с ЦЕНОЙ в тексте, а не просто «нужно подтверждение»:
        // решение принимают, зная стоимость, а не после счёта.
        const planned = benchBody.only?.length
          ? SEED_CASES.filter((c) => benchBody.only!.includes(c.id))
          : SEED_CASES;
        return json(
          {
            error: "Нужно подтверждение: прогон запускает полные миссии.",
            cases: planned.map((c) => ({ id: c.id, difficulty: c.difficulty, maxIterations: c.maxIterations })),
            estimatedModelCalls: planned.reduce((sum, c) => sum + c.maxIterations, 0),
            hint: 'Повтори запрос с {"confirm": true}.',
          },
          env,
          400,
        );
      }

      if (detectBackend(env) !== "container") {
        // Без контейнера прогнать тесты негде, а без прогона тестов
        // измерять нечего. Отказ честнее числа, полученного неизвестно из
        // чего.
        return json(
          { error: "Измеритель требует контейнерную песочницу: без неё нечем прогнать тесты." },
          env,
          503,
        );
      }

      const runId = crypto.randomUUID().slice(0, 8);
      const startedAt = new Date().toISOString();
      const orchestrator = await getAgentByName(env.Orchestrator, `bench-${runId}`);

      const result = await runBench(
        env,
        {
          // Миссия идёт тем же путём, что и обычная, — иначе измерялся бы
          // не тот код, который работает у пользователя.
          runMission: async ({ projectId, goal, maxIterations }) => {
            const missionId = crypto.randomUUID();
            await env.AZRAIL_D1.prepare(
              `INSERT INTO missions (id, project_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)`,
            )
              .bind(missionId, projectId, goal, new Date().toISOString(), new Date().toISOString())
              .run();
            return orchestrator.runBenchMission({ missionId, projectId, goal, maxIterations });
          },
          execInSandbox: async (projectId, command) => {
            const res = await runInContainer(env, command, { sandboxName: projectId });
            return { exitCode: res.exitCode, output: res.output };
          },
          syncWorkspace: (projectId) => syncWorkspaceToSandbox(env, projectId),
        },
        SEED_CASES,
        { runId, only: benchBody.only },
      );

      try {
        await saveRun(env, runId, result.report, result.outcomes, { note: benchBody.note, startedAt });
      } catch (err) {
        log("error", "bench.save_failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return json({ success: true, ...result }, env);
    }

    if (url.pathname === "/api/bench" && request.method === "GET") {
      const runId = url.searchParams.get("runId");
      if (runId) {
        return json({ success: true, runId, outcomes: await loadOutcomes(env, runId) }, env);
      }
      return json({ success: true, runs: await listRuns(env) }, env);
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

      // ВЛОЖЕНИЯ. До сих пор интерфейс их отправлял, а сервер не читал:
      // файл уходил в R2 и оставался там навсегда, а задача уходила в
      // работу пустой. Ничего не падало — просто содержимое не доезжало,
      // и агент отвечал «не найдено исходных модулей».
      if (Array.isArray(body.attachments) && body.attachments.length) {
        const loaded = await loadAttachments(env, body.attachments);
        body.payload = String(body.payload ?? "") + attachmentsToText(loaded);
        log("info", "task.attachments", {
          total: body.attachments.length,
          read: loaded.filter((a) => a.text).length,
          skipped: loaded.filter((a) => !a.text).length,
        });
      }

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

    /* Неизвестный путь отдаёт ПРИЛОЖЕНИЕ, а не голую строку.
     *
     * Биндинг ASSETS был объявлен в wrangler.toml и не читался ни одной
     * строкой кода — это было честно записано там же в комментарии и так
     * и осталось несделанным. Итог: любая опечатка в адресе (или переход
     * по ссылке на внутренний раздел) выдавала текст «AZRAIL OS — Core
     * API Running» — с виду мёртвый сервис.
     *
     * Только для GET и только когда браузер просит HTML: промахнувшийся
     * запрос к /api/… должен получить честную ошибку, а не страницу,
     * которую он не сможет разобрать. */
    const wantsHtml = (request.headers.get("Accept") ?? "").includes("text/html");
    if (request.method === "GET" && wantsHtml && !url.pathname.startsWith("/api/") && env.ASSETS) {
      try {
        const page = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
        if (page.ok) {
          // 200, а не 404: это единственная страница приложения, и для
          // клиентской навигации она валидный ответ на любой её путь.
          return new Response(page.body, {
            status: 200,
            headers: getCors(env, { "Content-Type": "text/html; charset=utf-8" }),
          });
        }
      } catch (err) {
        log("warn", "assets.fallback_failed", {
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      return json({ error: `Неизвестный путь: ${url.pathname}` }, env, 404);
    }

    return new Response("AZRAIL OS — Core API Running", { headers: getCors(env) });
}
