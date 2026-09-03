// AZRAIL — защита платных эндпоинтов.
//
// Причина существования: Worker получает публичный URL. Без проверки любой,
// кто узнает адрес, запускает Nemotron 120B за твой счёт. Это не гипотетика —
// это стоимость на счёте Cloudflare.
//
// Принцип FAIL-CLOSED: если секрет AZRAIL_TOKEN не задан, эндпоинты НЕ
// работают. Альтернатива (пускать всех, пока не настроено) означала бы, что
// забытая настройка = открытый кошелёк. Лучше явная ошибка при старте.

import type { Env } from "../types";
import { log } from "./resilience";

export interface AuthResult {
  ok: boolean;
  /** Причина отказа — уже готова к отдаче пользователю */
  status?: number;
  error?: string;
  /** Идентификатор вызывающего для счётчика лимита */
  caller?: string;
}

/** Сравнение, не зависящее от позиции первого различия. Обычное === на
 *  строках выходит раньше при первом несовпавшем символе, что теоретически
 *  позволяет подбирать токен по времени ответа. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkAuth(request: Request, env: Env): AuthResult {
  if (!env.AZRAIL_TOKEN) {
    return {
      ok: false,
      status: 503,
      error:
        "Авторизация не настроена. Задай секрет: wrangler secret put AZRAIL_TOKEN " +
        "(или Dashboard → Worker → Settings → Variables → Add secret). " +
        "До этого платные эндпоинты закрыты намеренно.",
    };
  }

  const header = request.headers.get("Authorization") ?? "";
  let token = header.startsWith("Bearer ") ? header.slice(7) : "";

  // WebSocket-хендшейк не даёт JS выставить кастомный заголовок (ограничение
  // самого браузерного API, не этого проекта) — единственный канал для
  // токена там URL. Запасной путь читается, только если заголовка нет, а не
  // вместо него: тот, кто прислал оба, не получает два шанса подобрать токен.
  if (!token) {
    const url = new URL(request.url);
    token = url.searchParams.get("token") ?? "";
  }

  if (!token) {
    return { ok: false, status: 401, error: "Нужен заголовок Authorization: Bearer <токен> (или ?token= для WebSocket)." };
  }
  if (!safeEqual(token, env.AZRAIL_TOKEN)) {
    return { ok: false, status: 401, error: "Неверный токен." };
  }

  // Пока один общий токен — идентификатор вызывающего один. Когда появятся
  // пользователи, сюда придёт их id, и лимит станет персональным.
  return { ok: true, caller: "shared" };
}

// ─── Лимит расхода ────────────────────────────────────────────────────────

const DEFAULT_HOURLY_LIMIT = 50;

export interface RateLimitResult {
  allowed: boolean;
  used: number;
  limit: number;
  /** Unix-время, когда счётчик обнулится */
  resetAt: number;
}

/** Счётчик задач за час, в KV. Окно фиксированное (по часам календаря), а не
 *  скользящее: скользящее требует хранить таймстемпы каждого запроса, что при
 *  KV-хранилище дороже самой защиты. Это упрощение — на границе часа лимит
 *  можно превысить почти вдвое, и это осознанный компромисс, а не недосмотр. */
/**
 * Лимит запусков модели в час.
 *
 * `cost` — сколько единиц списать. Он появился не для симметрии: обычная
 * задача через /api/task — это ОДИН проход агента, а миссия через
 * /api/mission прогоняет до двадцати вызовов модели подряд. Считать их
 * одинаково значит оставить самый дорогой путь фактически без ограничения:
 * двадцать миссий подряд стоят как четыреста обычных задач, а счётчик
 * покажет двадцать.
 */
export async function checkRateLimit(env: Env, caller: string, cost = 1): Promise<RateLimitResult> {
  const limit = Number(env.AZRAIL_HOURLY_LIMIT) || DEFAULT_HOURLY_LIMIT;
  const now = Date.now();
  const hourBucket = Math.floor(now / 3_600_000);
  const key = `ratelimit:${caller}:${hourBucket}`;
  const resetAt = (hourBucket + 1) * 3_600_000;

  let used = 0;
  try {
    used = Number(await env.AZRAIL_KV.get(key)) || 0;
  } catch (err) {
    // KV недоступен — не блокируем работу из-за счётчика. Раньше комментарий
    // здесь утверждал, что "вызывающий код это залогирует" — неправда:
    // index.ts логирует только ветку rl.allowed === false, а этот путь
    // всегда возвращает allowed: true, так что вызывающий код её никогда
    // не увидит. Найдено при аудите. Логируем здесь же, у источника.
    log("error", "ratelimit.kv_unavailable", {
      caller,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, used: 0, limit, resetAt };
  }

  // Проверяем ПОЛНУЮ стоимость до списания, а не факт «остался хоть один».
  // Иначе миссия ценой в 8 единиц пролезала бы при одном свободном месте,
  // и лимит превращался бы в пожелание.
  if (used + cost > limit) {
    return { allowed: false, used, limit, resetAt };
  }

  try {
    // TTL чуть больше часа: ключ уйдёт сам, чистить не нужно.
    await env.AZRAIL_KV.put(key, String(used + cost), { expirationTtl: 3900 });
  } catch (err) {
    // Инкремент не прошёл — пропускаем запрос, счётчик просто менее точен.
    // Ниже серьёзности предыдущего catch (лимит не отключается целиком),
    // но тот же принцип: не молчать про недоступность KV.
    log("warn", "ratelimit.kv_increment_failed", {
      caller,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { allowed: true, used: used + cost, limit, resetAt };
}
