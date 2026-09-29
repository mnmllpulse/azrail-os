// AZRAIL — модели, подключённые вручную.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
//
// До него закрепить модель можно было только из зашитого реестра:
// runModel() звал findModel(slug) по статическому массиву и на незнакомый
// слаг бросал «Модель не найдена в реестре». То есть любая модель, которой
// нет в MODEL_REGISTRY, была недоступна в принципе — даже та, что
// прекрасно работает в аккаунте Cloudflare прямо сейчас. Каталог у
// провайдера пополняется еженедельно, а реестр правится релизами: разрыв
// между ними и был тем, что мешало «подключить любую модель».
//
// ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ — и это важнее того, что делает.
//
// Он НЕ обходит защиту. Ручная модель проходит ровно те же ворота, что и
// любая другая: modelBlockReason (сторонние выключены / нет Gateway / не
// Paid-план), свежий тариф перед платным вызовом, месячный бюджет,
// повторная проверка политики перед отправкой. Добавление модели в список
// разрешает её ВЫБРАТЬ, а не разрешает потратить деньги.
//
// Он НЕ смешивает проверенное с добавленным на слово. Записи отсюда всегда
// помечены custom: true. Реестр в коде держится на правиле «только
// подтверждённое каталогом, у каждой записи source» — правило заведено
// после того, как вписанный по памяти слаг оказался снятым с поддержки.
// Ручная запись по определению не сверена с каталогом, и вид у неё должен
// быть другой.

import type { Env } from "../types";
import {
  findModel,
  MODEL_REGISTRY,
  type ModelCapability,
  type ModelEntry,
  type ModelTier,
} from "./model-registry";

/** Отказ по вине ввода, а не по вине системы: наружу идёт 400, не 500. */
export class CustomModelError extends Error {}

const TIERS: ModelTier[] = ["frontier", "balanced", "fast"];

const CAPABILITIES: ModelCapability[] = [
  "text_generation",
  "tool_calling",
  "reasoning",
  "coding",
  "vision",
  "image_generation",
  "embeddings",
  "multilingual",
];

/**
 * Требует ли слаг маршрутизации через AI Gateway.
 *
 * ВЫЧИСЛЯЕТСЯ, А НЕ СПРАШИВАЕТСЯ. Во всём реестре это поле строго равно
 * «слаг не начинается с @cf/» — проверено по всем 26 записям. Оставить его
 * ручным значило бы завести галочку, неверное положение которой ломает
 * вызов уже после отправки, с сообщением про Gateway вместо сообщения про
 * опечатку.
 */
export function gatewayRequiredFor(slug: string): boolean {
  return !slug.startsWith("@cf/");
}

export interface CustomModelInput {
  slug: unknown;
  provider: unknown;
  tier: unknown;
  capabilities: unknown;
  contextWindow?: unknown;
  source: unknown;
}

interface CustomModelRow {
  slug: string;
  provider: string;
  tier: string;
  capabilities: string;
  context_window: number | null;
  requires_gateway: number;
  source: string;
  created_at: number;
  created_by: string;
}

/** Запись таблицы, дополненная признаком происхождения. */
export interface CustomModelEntry extends ModelEntry {
  custom: true;
  createdAt: number;
  createdBy: string;
}

function rowToEntry(row: CustomModelRow): CustomModelEntry {
  let capabilities: ModelCapability[] = [];
  try {
    const parsed: unknown = JSON.parse(row.capabilities);
    // Битую строку в базе молча не превращаем в «модель без возможностей»:
    // такая модель не пройдёт отбор маршрутизатора и исчезнет из выдачи без
    // объяснения. Пустой список тут честнее — он виден в интерфейсе.
    if (Array.isArray(parsed)) {
      capabilities = parsed.filter((c): c is ModelCapability =>
        CAPABILITIES.includes(c as ModelCapability),
      );
    }
  } catch {
    capabilities = [];
  }
  return {
    slug: row.slug,
    provider: row.provider,
    tier: row.tier as ModelTier,
    capabilities,
    ...(row.context_window === null ? {} : { contextWindow: row.context_window }),
    requiresGateway: row.requires_gateway === 1,
    source: row.source,
    custom: true,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/**
 * Список подключённых вручную моделей.
 *
 * Отсутствие таблицы — не ошибка запроса, а не накатанная миграция 008.
 * Падать здесь нельзя: тогда пустой список моделей выглядел бы как
 * поломка всего маршрутизатора, а не как незавершённое обновление схемы.
 * Та же логика, что в readModelPolicy.
 */
export async function listCustomModels(env: Env): Promise<CustomModelEntry[]> {
  try {
    const { results } = await env.AZRAIL_D1.prepare(
      "SELECT slug,provider,tier,capabilities,context_window,requires_gateway,source,created_at,created_by FROM custom_models ORDER BY created_at DESC LIMIT 200",
    ).all<CustomModelRow>();
    return results.map(rowToEntry);
  } catch {
    return [];
  }
}

/**
 * Полный список моделей: зашитый реестр плюс подключённые вручную.
 *
 * Порядок именно такой: проверенные впереди. Маршрутизатор при равных
 * условиях берёт первую подходящую, и предпочесть сверенную с каталогом
 * запись непроверенной — правильное поведение по умолчанию.
 *
 * Слаг, уже занятый реестром, сюда не попадёт: добавление такого
 * отклоняется при записи (см. addCustomModel). Фильтр ниже — защита от
 * строки, попавшей в таблицу в обход кода.
 */
export async function effectiveRegistry(env: Env): Promise<ModelEntry[]> {
  const custom = await listCustomModels(env);
  return [...MODEL_REGISTRY, ...custom.filter((m) => !findModel(m.slug))];
}

/** Поиск по обоим источникам. Возвращает undefined, а не бросает. */
export async function findAnyModel(env: Env, slug: string): Promise<ModelEntry | undefined> {
  const built = findModel(slug);
  if (built) return built;
  return (await listCustomModels(env)).find((m) => m.slug === slug);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CustomModelError(`Поле «${field}» обязательно.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new CustomModelError(`Поле «${field}» длиннее ${max} символов.`);
  }
  return trimmed;
}

/**
 * Подключает модель вручную.
 *
 * Слаг НЕ проверяется обращением к провайдеру, и это осознанно: проверка
 * стоила бы живого вызова модели (то есть денег) на каждое добавление, а
 * при недоступном каталоге отклоняла бы верный слаг. Вместо этого рядом в
 * интерфейсе стоит «Живой каталог Cloudflare», где видно, что аккаунт
 * отдаёт на самом деле, — сверка остаётся за человеком и остаётся
 * бесплатной. Неверный слаг обнаружится первым же вызовом с внятной
 * ошибкой от провайдера, а не тихой подменой на другую модель.
 */
export async function addCustomModel(
  env: Env,
  input: CustomModelInput,
  accountId: string,
): Promise<CustomModelEntry> {
  const slug = text(input.slug, "слаг", 200);
  // Пробелы и кавычки внутри слага — почти всегда след копирования из
  // таблицы вместе с оформлением. Такой слаг уйдёт провайдеру как есть и
  // вернётся отказом, в котором причина не читается.
  if (!/^[A-Za-z0-9@._\-/:]+$/.test(slug)) {
    throw new CustomModelError(
      "Слаг содержит недопустимые символы. Разрешены латиница, цифры и знаки @ . _ - / : — скопируйте его из каталога без кавычек и пробелов.",
    );
  }
  if (findModel(slug)) {
    throw new CustomModelError(
      `Модель «${slug}» уже есть в проверенном реестре — подключать её вручную не нужно.`,
    );
  }

  const provider = text(input.provider, "провайдер", 80);
  const source = text(input.source, "источник данных", 300);

  const tier = text(input.tier, "класс", 20) as ModelTier;
  if (!TIERS.includes(tier)) {
    throw new CustomModelError(`Класс должен быть одним из: ${TIERS.join(", ")}.`);
  }

  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new CustomModelError("Укажите хотя бы одну возможность модели.");
  }
  const capabilities: ModelCapability[] = [];
  for (const raw of input.capabilities) {
    if (!CAPABILITIES.includes(raw as ModelCapability)) {
      throw new CustomModelError(`Неизвестная возможность «${String(raw)}».`);
    }
    // Дубликат в списке — не ошибка ввода, а шум: молча схлопываем.
    if (!capabilities.includes(raw as ModelCapability)) capabilities.push(raw as ModelCapability);
  }

  let contextWindow: number | null = null;
  if (input.contextWindow !== undefined && input.contextWindow !== null && input.contextWindow !== "") {
    const size = Number(input.contextWindow);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 100_000_000) {
      throw new CustomModelError(
        "Окно контекста — целое число токенов больше нуля. Оставьте пустым, если не проверяли: пустое означает «не проверено», и маршрутизатор по нему не фильтрует.",
      );
    }
    contextWindow = size;
  }

  const requiresGateway = gatewayRequiredFor(slug);
  const now = Date.now();
  try {
    await env.AZRAIL_D1.prepare(
      `INSERT INTO custom_models(slug,provider,tier,capabilities,context_window,requires_gateway,source,created_at,created_by)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET provider=excluded.provider,tier=excluded.tier,
         capabilities=excluded.capabilities,context_window=excluded.context_window,
         requires_gateway=excluded.requires_gateway,source=excluded.source`,
    )
      .bind(
        slug,
        provider,
        tier,
        JSON.stringify(capabilities),
        contextWindow,
        requiresGateway ? 1 : 0,
        source,
        now,
        accountId,
      )
      .run();
  } catch (err) {
    // Единственная ожидаемая причина — не накатанная миграция 008. Отдать
    // её как 500 «внутренняя ошибка» значило бы отправить искать поломку
    // вместо того, чтобы назвать недостающий шаг обновления.
    throw new CustomModelError(
      `Не удалось сохранить модель. Если база обновлялась давно, накатите миграцию 008-custom-models.sql. Причина: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    slug,
    provider,
    tier,
    capabilities,
    ...(contextWindow === null ? {} : { contextWindow }),
    requiresGateway,
    source,
    custom: true,
    createdAt: now,
    createdBy: accountId,
  };
}

/** Убирает модель из списка. Отсутствие записи — не ошибка, результат тот же. */
export async function removeCustomModel(env: Env, slug: string): Promise<{ removed: boolean }> {
  if (typeof slug !== "string" || !slug.trim()) {
    throw new CustomModelError("Укажите слаг модели.");
  }
  const result = await env.AZRAIL_D1.prepare("DELETE FROM custom_models WHERE slug=?")
    .bind(slug.trim())
    .run();
  return { removed: (result.meta?.changes ?? 0) > 0 };
}
