import type { Env } from "../types";
import { log } from "../lib/resilience";

/**
 * АВАРИЙНЫЙ СТОП ПО ЗАПИСЯМ.
 *
 * Cloudflare берёт деньги за каждую операцию записи и НЕ ДАЁТ поставить
 * жёсткий потолок расходов. Узнают по счёту. Публично описанные случаи:
 * $36 000 у побочного проекта с 81 пользователем (зациклившаяся очередь,
 * 16 млрд записей в Durable Objects), $34 000 за восемь дней при нуле
 * пользователей (объект переставлял себе будильник, не проверяя, не стоит
 * ли он уже), $4 868 у соло-разработчика с обычным счётом в $5.
 *
 * У AZRAIL сейчас этих паттернов нет: будильников не используется вовсе,
 * цикл ограничен двадцатью шагами, записи идут пачками по несколько штук
 * на шаг. И на бесплатном плане переплата невозможна в принципе —
 * Cloudflare перестаёт обслуживать, а не выставляет счёт.
 *
 * Этот файл существует ради момента ПЕРЕХОДА НА ПЛАТНЫЙ ПЛАН. Ровно
 * тогда защита перестаёт быть бесплатной, а её отсутствие — становится
 * дорогим. Ставить её надо ДО оплаты: после первого счёта она уже не
 * поможет.
 *
 * Считается грубо и дёшево: счётчик в KV с часовым окном. Точность здесь
 * не нужна — нужен порядок величины и способность остановиться. Точный
 * учёт стоил бы записей, то есть той самой проблемы, которую решает.
 */

/** Потолок записей в час. Нормальная миссия — до 60. */
const DEFAULT_HOURLY_WRITES = 5000;

export interface BudgetState {
  allowed: boolean;
  used: number;
  limit: number;
  /** Сколько осталось до потолка — для предупреждения заранее. */
  remaining: number;
}

const hourKey = (): string => {
  const now = new Date();
  return `writes:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}:${now.getUTCHours()}`;
};

const limitFor = (env: Env): number => Number(env.AZRAIL_WRITE_BUDGET) || DEFAULT_HOURLY_WRITES;

/**
 * Проверить и списать бюджет записей.
 *
 * Списывается ЗАРАНЕЕ, по заявленной стоимости, а не по факту. Причина
 * та же, что и у лимита моделей: узнать о превышении после того, как
 * записи уже сделаны, бесполезно.
 */
export async function chargeWrites(env: Env, cost: number): Promise<BudgetState> {
  const limit = limitFor(env);
  const key = hourKey();

  let used = 0;
  try {
    used = Number(await env.AZRAIL_KV.get(key)) || 0;
  } catch (err) {
    // KV недоступен — считать нечем. Пропускаем, но ГРОМКО: молчаливое
    // отключение защиты от расходов — худший из возможных отказов.
    log("error", "budget.kv_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, used: 0, limit, remaining: limit };
  }

  if (used + cost > limit) {
    log("error", "budget.exceeded", { used, cost, limit });
    return { allowed: false, used, limit, remaining: Math.max(0, limit - used) };
  }

  try {
    // TTL чуть больше часа: ключ уходит сам, чистить не нужно.
    await env.AZRAIL_KV.put(key, String(used + cost), { expirationTtl: 3900 });
  } catch (err) {
    log("warn", "budget.kv_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { allowed: true, used: used + cost, limit, remaining: limit - used - cost };
}

/** Сколько записей может потребовать миссия в худшем случае. */
export function estimateMissionWrites(maxIterations: number): number {
  // На шаг: событие начала, событие конца, запись вызова инструмента,
  // обновление плана. Плюс создание миссии, план, проверки, финал.
  const perStep = 4;
  const fixed = 20;
  return maxIterations * perStep + fixed;
}

