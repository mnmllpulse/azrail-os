import { describe, it, expect, vi } from "vitest";
import { sqliteD1 } from "./stubs/sqlite-d1";
import {
  addCustomModel,
  effectiveRegistry,
  findAnyModel,
  listCustomModels,
  removeCustomModel,
  gatewayRequiredFor,
  CustomModelError,
} from "../src/lib/custom-models";
import { MODEL_REGISTRY, findModel } from "../src/lib/model-registry";
import { setModelPolicy, eligibleRegistry } from "../src/lib/model-policy";
import { runModel } from "../src/lib/model-router";
import type { Env } from "../src/types";

/**
 * ПОДКЛЮЧЕНИЕ ЛЮБОЙ МОДЕЛИ ВРУЧНУЮ — проверки на живом SQLite.
 *
 * Здесь именно исполнение, а не разбор текста: миграция 008 и schema.sql
 * должны создавать таблицу, INSERT должен проходить, а маршрутизатор —
 * доходить до вызова закреплённой вручную модели. Статические проверки
 * этого не ловят: они одинаково довольны и рабочим запросом, и запросом
 * к несуществующей колонке.
 */
function fixture() {
  const { db, sqlite } = sqliteD1();
  const run = vi.fn(async () => ({ response: "ok", usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  const env = {
    AZRAIL_D1: db,
    AI: { run },
    AI_GATEWAY_ID: "configured",
    AZRAIL_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, sqlite, run };
}

const llama = {
  slug: "@cf/meta/llama-4-maverick-17b-128e-instruct",
  provider: "Meta",
  tier: "balanced",
  capabilities: ["text_generation", "coding"],
  source: "живой каталог аккаунта, 2026-09-29",
};

describe("подключение модели вручную: хранилище", () => {
  it("свежая база из schema.sql уже умеет хранить ручные модели", async () => {
    // schema.sql миграции не проигрывает. Забытая там таблица означала бы
    // возможность, которой на новой установке не будет никогда.
    const { env } = fixture();
    expect(await listCustomModels(env)).toEqual([]);
    await addCustomModel(env, llama, "acc-1");
    expect((await listCustomModels(env)).map((m) => m.slug)).toEqual([llama.slug]);
  });

  it("сохранённая запись читается обратно без потерь", async () => {
    const { env } = fixture();
    await addCustomModel(env, { ...llama, contextWindow: 131072 }, "acc-1");
    const [saved] = await listCustomModels(env);
    expect(saved).toMatchObject({
      slug: llama.slug,
      provider: "Meta",
      tier: "balanced",
      capabilities: ["text_generation", "coding"],
      contextWindow: 131072,
      requiresGateway: false,
      source: llama.source,
      custom: true,
      createdBy: "acc-1",
    });
  });

  it("пустое окно контекста остаётся «не проверено», а не нулём", async () => {
    // Ноль отфильтровал бы модель из отбора по длине запроса — то есть
    // «не измерено» превратилось бы в «не подходит никогда».
    const { env } = fixture();
    await addCustomModel(env, { ...llama, contextWindow: "" }, "acc-1");
    const [saved] = await listCustomModels(env);
    expect(saved.contextWindow).toBeUndefined();
  });

  it("повторное подключение того же слага обновляет запись, а не двоит список", async () => {
    const { env } = fixture();
    await addCustomModel(env, llama, "acc-1");
    await addCustomModel(env, { ...llama, tier: "frontier", source: "перепроверено 2026-09-30" }, "acc-1");
    const list = await listCustomModels(env);
    expect(list).toHaveLength(1);
    expect(list[0].tier).toBe("frontier");
    expect(list[0].source).toBe("перепроверено 2026-09-30");
  });

  it("отключение удаляет запись, повтор не считается ошибкой", async () => {
    const { env } = fixture();
    await addCustomModel(env, llama, "acc-1");
    expect(await removeCustomModel(env, llama.slug)).toEqual({ removed: true });
    expect(await removeCustomModel(env, llama.slug)).toEqual({ removed: false });
    expect(await listCustomModels(env)).toEqual([]);
  });

  it("отсутствие таблицы читается как пустой список, а не как отказ", async () => {
    // База, не прошедшая миграцию, не должна выглядеть как сломанный
    // маршрутизатор: зашитый реестр продолжает работать.
    const { env, sqlite } = fixture();
    sqlite.exec("DROP TABLE custom_models");
    expect(await listCustomModels(env)).toEqual([]);
    expect((await effectiveRegistry(env)).length).toBe(MODEL_REGISTRY.length);
  });

  it("сломанный JSON возможностей не роняет весь список", async () => {
    const { env, sqlite } = fixture();
    await addCustomModel(env, llama, "acc-1");
    sqlite.exec("UPDATE custom_models SET capabilities='{не json'");
    const [saved] = await listCustomModels(env);
    expect(saved.capabilities).toEqual([]);
  });
});

describe("подключение модели вручную: проверка ввода", () => {
  const bad = async (patch: Record<string, unknown>, match: RegExp) => {
    const { env } = fixture();
    await expect(addCustomModel(env, { ...llama, ...patch }, "acc-1")).rejects.toThrow(match);
  };

  it("слаг с пробелами и кавычками отклоняется до записи", () =>
    bad({ slug: '"@cf/meta/llama 4"' }, /недопустимые символы/));
  it("слаг из проверенного реестра отклоняется как лишний", () =>
    bad({ slug: MODEL_REGISTRY[0].slug }, /уже есть в проверенном реестре/));
  it("неизвестный класс отклоняется с перечислением допустимых", () =>
    bad({ tier: "best" }, /frontier, balanced, fast/));
  it("пустой список возможностей отклоняется", () =>
    bad({ capabilities: [] }, /хотя бы одну возможность/));
  it("выдуманная возможность отклоняется с её именем в тексте", () =>
    bad({ capabilities: ["telepathy"] }, /telepathy/));
  it("отрицательное окно контекста отклоняется", () =>
    bad({ contextWindow: -1 }, /больше нуля/));
  it("источник данных обязателен — иначе запись нечем перепроверить", () =>
    bad({ source: "   " }, /источник данных/));
  it("отказ по вине ввода — это CustomModelError, то есть 400, а не 500", async () => {
    const { env } = fixture();
    await expect(addCustomModel(env, { ...llama, tier: "x" }, "acc-1")).rejects.toBeInstanceOf(
      CustomModelError,
    );
  });

  it("дубликаты возможностей схлопываются молча", async () => {
    const { env } = fixture();
    const m = await addCustomModel(env, { ...llama, capabilities: ["coding", "coding"] }, "acc-1");
    expect(m.capabilities).toEqual(["coding"]);
  });

  it("необходимость Gateway выводится из слага и не берётся из ввода", async () => {
    const { env } = fixture();
    expect(gatewayRequiredFor("@cf/meta/x")).toBe(false);
    expect(gatewayRequiredFor("openai/gpt-6")).toBe(true);
    const outside = await addCustomModel(
      env,
      { ...llama, slug: "openai/gpt-6", provider: "OpenAI", requiresGateway: false } as never,
      "acc-1",
    );
    expect(outside.requiresGateway).toBe(true);
  });
});

describe("подключение модели вручную: маршрутизация", () => {
  it("расширенный реестр — зашитый плюс ручной, проверенные впереди", async () => {
    const { env } = fixture();
    await addCustomModel(env, llama, "acc-1");
    const reg = await effectiveRegistry(env);
    expect(reg).toHaveLength(MODEL_REGISTRY.length + 1);
    expect(reg.slice(0, MODEL_REGISTRY.length)).toEqual(MODEL_REGISTRY);
    expect(reg[reg.length - 1].slug).toBe(llama.slug);
  });

  it("findAnyModel находит и зашитую, и ручную", async () => {
    const { env } = fixture();
    await addCustomModel(env, llama, "acc-1");
    expect((await findAnyModel(env, MODEL_REGISTRY[0].slug))?.slug).toBe(MODEL_REGISTRY[0].slug);
    expect((await findAnyModel(env, llama.slug))?.provider).toBe("Meta");
    expect(await findAnyModel(env, "нет/такой")).toBeUndefined();
  });

  it("ручная модель участвует и в автоматическом отборе, а не только в закреплении", async () => {
    // Иначе подключение читалось бы как «работает наполовину»: выбрать
    // руками можно, а маршрутизатор о ней не знает.
    const { env } = fixture();
    (env as { AZRAIL_WORKERS_PLAN?: string }).AZRAIL_WORKERS_PLAN = "paid";
    await setModelPolicy(env, true, 10);
    const before = (await eligibleRegistry(env)).length;
    await addCustomModel(env, llama, "acc-1");
    const after = await eligibleRegistry(env);
    expect(after.length).toBe(before + 1);
    expect(after.some((m) => m.slug === llama.slug)).toBe(true);
  });

  it("ручная модель отсеивается теми же воротами, что и любая другая", async () => {
    // Подключение не добавляет исключений в modelBlockReason: при
    // выключенных платных моделях запись просто не проходит отбор.
    const { env } = fixture();
    await addCustomModel(env, llama, "acc-1");
    expect((await eligibleRegistry(env)).some((m) => m.slug === llama.slug)).toBe(false);
  });

  it("закреплённая вручную модель действительно вызывается, когда ворота открыты", async () => {
    // Сквозная проверка всей цепочки: таблица → findAnyModel → runModel →
    // реальный вызов. Условия здесь ровно те же, что и для проверенной
    // платной модели: включены платные модели, Workers Paid, свежий
    // тариф, бюджет. Ни одного послабления ради ручной записи нет —
    // именно это и проверяется.
    const { env, run, sqlite } = fixture();
    (env as { AZRAIL_WORKERS_PLAN?: string }).AZRAIL_WORKERS_PLAN = "paid";
    await setModelPolicy(env, true, 10);
    await addCustomModel(env, llama, "acc-1");
    sqlite
      .prepare("INSERT INTO model_prices(model,input_micro_usd_per_million,output_micro_usd_per_million,updated_at) VALUES(?,?,?,?)")
      .run(llama.slug, 1, 1, Date.now());
    const out = await runModel(env, "chat", { messages: [] }, { preferredModel: llama.slug });
    expect(run).toHaveBeenCalled();
    expect(run.mock.calls[0][0]).toBe(llama.slug);
    expect(out.model).toBe(llama.slug);
  });

  it("без свежего тарифа ручная модель не вызывается, хотя и подключена", async () => {
    // Граница, ради которой тариф вообще заведён: выбрать модель можно,
    // потратить по ней — нет, пока цена не подтверждена.
    const { env, run } = fixture();
    (env as { AZRAIL_WORKERS_PLAN?: string }).AZRAIL_WORKERS_PLAN = "paid";
    await setModelPolicy(env, true, 10);
    await addCustomModel(env, llama, "acc-1");
    await expect(
      runModel(env, "chat", { messages: [] }, { preferredModel: llama.slug }),
    ).rejects.toThrow(/тариф/);
    expect(run).not.toHaveBeenCalled();
  });

  it("несуществующий слаг по-прежнему явная ошибка, а не тихий автовыбор", async () => {
    const { env, run } = fixture();
    await expect(
      runModel(env, "chat", { messages: [] }, { preferredModel: "@cf/выдуманная/модель" }),
    ).rejects.toThrow(/не найдена/);
    expect(run).not.toHaveBeenCalled();
  });

  it("подключение не открывает кошелёк: платная ручная модель всё так же под политикой", async () => {
    // Сторонние модели выключены по умолчанию. Подключить — значит
    // получить право выбрать, а не право потратить.
    const { env, run } = fixture();
    await addCustomModel(env, { ...llama, slug: "openai/gpt-6", provider: "OpenAI" }, "acc-1");
    await expect(
      runModel(env, "chat", { messages: [] }, { preferredModel: "openai/gpt-6" }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("строка, попавшая в таблицу в обход кода, не подменяет проверенную запись", async () => {
    const { env, sqlite } = fixture();
    const taken = MODEL_REGISTRY[0].slug;
    sqlite
      .prepare(
        "INSERT INTO custom_models(slug,provider,tier,capabilities,context_window,requires_gateway,source,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(taken, "Подделка", "fast", '["coding"]', null, 0, "вручную", Date.now(), "acc-1");
    const reg = await effectiveRegistry(env);
    expect(reg.filter((m) => m.slug === taken)).toHaveLength(1);
    expect((await findAnyModel(env, taken))?.provider).toBe(findModel(taken)?.provider);
  });
});
