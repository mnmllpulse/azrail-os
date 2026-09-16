import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isTerminal,
  statusForResult,
  reapStaleMissions,
  requestCancel,
  isCancelRequested,
  finishMission,
  staleMinutes,
  DEFAULT_STALE_MINUTES,
} from "../src/lib/mission-state";
import { readKey, lookup, remember } from "../src/lib/idempotency";
import { issueTicket, redeemTicket, TICKET_TTL_SECONDS } from "../src/lib/ws-ticket";
import { checkRateLimit } from "../src/lib/auth";
import type { Env } from "../src/types";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf-8");

/** Код без комментариев.
 *
 *  В этом проекте комментарии подробные и часто цитируют то, ЧЕГО В КОДЕ
 *  БОЛЬШЕ НЕТ («здесь раньше стоял await engine.runMission(...)»). Поиск
 *  по сырому тексту находит такую цитату и объявляет отсутствующий вызов
 *  присутствующим — проверка «этого больше не вызывается» обязана смотреть
 *  на код, а не на рассказ о нём. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

// ─── Заглушки хранилищ ──────────────────────────────────────────────────
// Ровно столько поведения, сколько используют проверяемые функции. Полная
// эмуляция D1 проверяла бы саму эмуляцию.

interface Row {
  id: string;
  status: string;
  updated_at?: string;
  created_at?: string;
}

function fakeD1(rows: Row[], opts: { failOnResultColumn?: boolean } = {}) {
  const log: string[] = [];
  const db = {
    rows,
    log,
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args;
          return stmt;
        },
        async first<T>() {
          log.push(sql);
          if (/SELECT status FROM missions/.test(sql)) {
            const found = rows.find((r) => r.id === stmt.args[0]);
            return (found ? { status: found.status } : null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          log.push(sql);
          if (/SELECT id FROM missions/.test(sql)) {
            const cutoff = String(stmt.args[0]);
            const active = ["queued", "executing", "cancelling"];
            return {
              results: rows
                .filter((r) => active.includes(r.status) && (r.updated_at ?? r.created_at ?? "") < cutoff)
                .map((r) => ({ id: r.id })) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          log.push(sql);
          if (opts.failOnResultColumn && sql.includes("result_json")) {
            throw new Error("no such column: result_json");
          }
          if (/UPDATE missions SET status/.test(sql)) {
            const id = stmt.args[stmt.args.length - 1];
            const target = rows.find((r) => r.id === id);
            // Статус приходит двумя способами: параметром (finishMission)
            // и литералом прямо в SQL (requestCancel). Учитывать только
            // первый — значит проверять половину путей.
            const literal = /SET status = '([^']+)'/.exec(sql);
            if (target) target.status = literal ? literal[1] : String(stmt.args[0]);
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

function fakeKV(opts: { broken?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      if (opts.broken) throw new Error("KV недоступен");
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      if (opts.broken) throw new Error("KV недоступен");
      store.set(key, value);
    },
    async delete(key: string) {
      if (opts.broken) throw new Error("KV недоступен");
      store.delete(key);
    },
  };
}

const envWith = (parts: Partial<Env>): Env => parts as Env;

// ─────────────────────────────────────────────────────────────────────────

describe("Миссия исполняется в фоне, а не внутри HTTP-запроса", () => {
  const idx = src("src/index.ts");
  const orch = src("src/agents/orchestrator.ts");
  const engine = src("src/core/execution-engine.ts");

  it("роут НЕ ждёт выполнения миссии", () => {
    // Здесь была причина самого дорогого класса отказов: весь цикл из
    // восьми-двадцати шагов с вызовами модели шёл внутри одного запроса.
    // Cloudflare рвёт клиентское соединение примерно на сотой секунде —
    // результат терялся, а строка в missions навсегда оставалась в
    // "executing", потому что финальный UPDATE стоял ПОСЛЕ недостижимого
    // await.
    const from = idx.indexOf('url.pathname === "/api/mission" && request.method === "POST"');
    const mission = code(idx.slice(from, idx.indexOf('url.pathname === "/api/mission/cancel"', from)));
    expect(mission).not.toContain("runMission(");
    expect(mission).not.toContain("new ExecutionEngine");
    expect(mission, "миссия обязана уходить в фон").toContain(".startMission(");
  });

  it("роут отвечает 202: работа принята, но не выполнена", () => {
    const from = idx.indexOf('url.pathname === "/api/mission" && request.method === "POST"');
    const mission = idx.slice(from, idx.indexOf('url.pathname === "/api/mission/cancel"', from));
    expect(mission).toContain('status: "accepted"');
    expect(mission).toContain("202");
  });

  it("цикл живёт в Durable Object и держит объект от выселения", () => {
    // Durable Object выселяется примерно через минуту простоя, а ожидание
    // ответа модели с его точки зрения и есть простой. Без heartbeat
    // длинная миссия рискует умереть на середине — та же потеря работы,
    // от которой уходили, только по другой причине.
    expect(orch).toContain("async runMissionTask(");
    expect(orch).toContain("this.keepAlive()");
    expect(orch).toContain("stopHeartbeat()");
  });

  it("планировщик — штатный из SDK, а не собственный alarm()", () => {
    // Свой alarm() на подклассе Agent перехватывает будильник, на котором
    // SDK держит собственные задачи и heartbeat.
    expect(orch).toContain('this.schedule(0, "runMissionTask"');
    expect(orch).not.toMatch(/\basync alarm\s*\(/);
  });

  it("падение цикла не оставляет миссию висящей", () => {
    const task = orch.slice(orch.indexOf("async runMissionTask("));
    expect(task).toContain("catch");
    expect(task).toContain('finishMission(this.env, missionId, "failed"');
  });
});

describe("Остановка миссии", () => {
  it("флаг ставится, если миссия ещё идёт", async () => {
    const db = fakeD1([{ id: "m1", status: "executing" }]);
    const env = envWith({ AZRAIL_D1: db as unknown as D1Database });
    const res = await requestCancel(env, "m1");
    expect(res).toMatchObject({ ok: true, reason: "cancelling" });
    expect(db.rows[0].status).toBe("cancelling");
  });

  it("завершённую миссию остановить нельзя — и об этом говорится прямо", async () => {
    // Тихое success:true на уже закончившуюся миссию выглядело бы как
    // успешная отмена того, что и так не шло.
    const db = fakeD1([{ id: "m1", status: "completed" }]);
    const env = envWith({ AZRAIL_D1: db as unknown as D1Database });
    expect(await requestCancel(env, "m1")).toMatchObject({ ok: false, reason: "already_finished" });
  });

  it("несуществующая миссия — не найдена, а не отменена", async () => {
    const db = fakeD1([]);
    const env = envWith({ AZRAIL_D1: db as unknown as D1Database });
    expect(await requestCancel(env, "нет-такой")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("цикл спрашивает про остановку ПЕРЕД вызовом модели", () => {
    // Иначе отмена оплачивала бы ещё один вызов ради права остановиться.
    const engine = src("src/core/execution-engine.ts");
    const loop = engine.slice(engine.indexOf("for (let i = 0; i < maxIterations; i++)"));
    const abortAt = loop.indexOf("ctx.shouldAbort");
    const decideAt = loop.indexOf("this.decideNextStep(");
    expect(abortAt).toBeGreaterThan(-1);
    expect(abortAt, "проверка останова должна быть до решения шага").toBeLessThan(decideAt);
  });

  it("недоступная база не считается командой «стоп»", async () => {
    // Прерывать начатую работу из-за сбоя чтения нельзя: это не команда.
    const env = envWith({
      AZRAIL_D1: {
        prepare() {
          return { bind: () => ({ first: async () => { throw new Error("D1 упал"); } }) };
        },
      } as unknown as D1Database,
    });
    expect(await isCancelRequested(env, "m1")).toBe(false);
  });
});

describe("Сборщик зависших миссий", () => {
  it("закрывает только те, что давно не обновлялись", async () => {
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    const old = new Date(now - 60 * 60_000).toISOString();
    const fresh = new Date(now - 60_000).toISOString();
    const db = fakeD1([
      { id: "зависла", status: "executing", updated_at: old },
      { id: "идёт", status: "executing", updated_at: fresh },
      { id: "закончилась", status: "completed", updated_at: old },
    ]);
    const env = envWith({ AZRAIL_D1: db as unknown as D1Database });

    const res = await reapStaleMissions(env, now);
    expect(res.ids).toEqual(["зависла"]);
    expect(db.rows.find((r) => r.id === "идёт")!.status).toBe("executing");
    expect(db.rows.find((r) => r.id === "закончилась")!.status).toBe("completed");
  });

  it("порог настраивается, но имеет разумное умолчание", () => {
    expect(staleMinutes(envWith({}))).toBe(DEFAULT_STALE_MINUTES);
    expect(staleMinutes(envWith({ AZRAIL_MISSION_STALE_MINUTES: "5" }))).toBe(5);
    // Мусор в переменной не должен превращаться в NaN-минут: тогда
    // сборщик замолчал бы навсегда и никто бы этого не заметил.
    expect(staleMinutes(envWith({ AZRAIL_MISSION_STALE_MINUTES: "нисколько" }))).toBe(DEFAULT_STALE_MINUTES);
    expect(staleMinutes(envWith({ AZRAIL_MISSION_STALE_MINUTES: "-3" }))).toBe(DEFAULT_STALE_MINUTES);
  });

  it("крон объявлен в конфиге — иначе сборщик никогда не запустится", () => {
    const wrangler = src("wrangler.toml");
    expect(wrangler).toContain("[triggers]");
    expect(wrangler).toMatch(/crons\s*=/);
    expect(src("src/index.ts")).toContain("async scheduled(");
  });
});

describe("Финальный статус миссии", () => {
  it("отмена не выдаётся за поломку", () => {
    expect(statusForResult({ status: "failed", error: "cancelled" })).toBe("cancelled");
    expect(statusForResult({ status: "failed", error: "boom" })).toBe("failed");
    expect(statusForResult({ status: "done" })).toBe("completed");
    expect(statusForResult({ status: "needs_input" })).toBe("waiting_approval");
  });

  it("terminal-статусы перечислены честно", () => {
    expect(isTerminal("executing")).toBe(false);
    expect(isTerminal("cancelling")).toBe(false);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal(undefined)).toBe(false);
  });

  it("база без колонки result_json не оставляет миссию висящей", async () => {
    // Миграция применяется отдельной командой. До неё первый UPDATE падает
    // на "no such column" — и без запасного пути миссия осталась бы в
    // "executing" навсегда, хотя работа выполнена.
    const db = fakeD1([{ id: "m1", status: "executing" }], { failOnResultColumn: true });
    const env = envWith({ AZRAIL_D1: db as unknown as D1Database });
    await finishMission(env, "m1", "completed", { status: "done", agent: "t", summary: "готово" });
    expect(db.rows[0].status).toBe("completed");
  });
});

describe("Идемпотентность запуска", () => {
  it("повтор с тем же ключом отдаёт ту же миссию", async () => {
    const kv = fakeKV();
    const env = envWith({ AZRAIL_KV: kv as unknown as KVNamespace });
    expect(await lookup(env, "mission", "k1")).toBeNull();
    await remember(env, "mission", "k1", "mission-1");
    expect((await lookup(env, "mission", "k1"))?.missionId).toBe("mission-1");
  });

  it("ключ из заголовка проверяется по форме", () => {
    const req = (v?: string) => new Request("https://x/", v ? { headers: { "Idempotency-Key": v } } : undefined);
    expect(readKey(req("abc-123_X"))).toBe("abc-123_X");
    expect(readKey(req())).toBe("");
    // Ключ попадает в имя записи KV. Принимать его без границ — значит
    // разрешить чужому забить пространство имён.
    expect(readKey(req("x".repeat(300)))).toBe("");
    expect(readKey(req("has space"))).toBe("");
    expect(readKey(req("semi;colon"))).toBe("");
  });

  it("недоступный KV не мешает запустить работу", async () => {
    // Отсутствие защиты от дубля хуже, чем невозможность работать вовсе.
    const env = envWith({ AZRAIL_KV: fakeKV({ broken: true }) as unknown as KVNamespace });
    expect(await lookup(env, "mission", "k1")).toBeNull();
    await expect(remember(env, "mission", "k1", "m1")).resolves.toBeUndefined();
  });
});

describe("Билет для WebSocket", () => {
  it("гасится при первом использовании", async () => {
    // Иначе это просто токен покороче: подсмотренный в логах билет
    // работал бы столько же, сколько живёт.
    const kv = fakeKV();
    const env = envWith({ AZRAIL_KV: kv as unknown as KVNamespace });
    const { ticket, expiresIn } = await issueTicket(env, "shared");
    expect(expiresIn).toBe(TICKET_TTL_SECONDS);
    expect(await redeemTicket(env, ticket)).toBe("shared");
    expect(await redeemTicket(env, ticket)).toBeNull();
  });

  it("чужой билет не проходит, недоступный KV — тоже", async () => {
    const env = envWith({ AZRAIL_KV: fakeKV() as unknown as KVNamespace });
    expect(await redeemTicket(env, "выдуманный")).toBeNull();
    expect(await redeemTicket(env, "")).toBeNull();

    const broken = envWith({ AZRAIL_KV: fakeKV({ broken: true }) as unknown as KVNamespace });
    expect(await redeemTicket(broken, "что-угодно")).toBeNull();
  });

  it("интерфейс больше не кладёт постоянный токен в адрес сокета", () => {
    const html = src("public/index.html");
    expect(html).not.toContain("/api/stream?token=");
    expect(html).toContain("/api/stream?ticket=");
    expect(html).toContain("/api/stream/ticket");
  });
});

describe("Лимит расхода закрывается при сбое, а не открывается", () => {
  it("недоступный KV запрещает запуск", async () => {
    // Раньше здесь стояло allowed: true — защита кошелька снималась ровно
    // в тот момент, когда переставала работать.
    const env = envWith({ AZRAIL_KV: fakeKV({ broken: true }) as unknown as KVNamespace });
    const res = await checkRateLimit(env, "shared", 1);
    expect(res.allowed).toBe(false);
  });

  it("исправный KV считает как считал", async () => {
    const env = envWith({ AZRAIL_KV: fakeKV() as unknown as KVNamespace, AZRAIL_HOURLY_LIMIT: "3" });
    expect((await checkRateLimit(env, "u", 1)).allowed).toBe(true);
    expect((await checkRateLimit(env, "u", 1)).allowed).toBe(true);
    // Полная стоимость проверяется ДО списания: задача ценой 2 при одном
    // свободном месте не должна пролезать.
    expect((await checkRateLimit(env, "u", 2)).allowed).toBe(false);
    expect((await checkRateLimit(env, "u", 1)).allowed).toBe(true);
  });
});

describe("Неизвестный путь отдаёт приложение", () => {
  const idx = src("src/index.ts");

  it("биндинг ASSETS наконец читается кодом", () => {
    // Он был объявлен в wrangler.toml и не использовался ни одной строкой:
    // любая опечатка в адресе выдавала голый текст «Core API Running».
    expect(idx).toContain("env.ASSETS.fetch(");
    expect(src("src/types.ts")).toContain("ASSETS?: Fetcher");
  });

  it("под страницу не подменяются ответы API", () => {
    // Промахнувшийся запрос к /api/… должен получить честную ошибку, а не
    // HTML, который он не сможет разобрать.
    const block = idx.slice(idx.indexOf("Неизвестный путь отдаёт ПРИЛОЖЕНИЕ"));
    expect(block).toContain('!url.pathname.startsWith("/api/")');
    expect(block).toContain('includes("text/html")');
  });
});
