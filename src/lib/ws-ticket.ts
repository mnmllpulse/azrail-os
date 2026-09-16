// AZRAIL — одноразовые билеты для WebSocket.
//
// Проблема, которую это закрывает: браузерный конструктор WebSocket не даёт
// выставить заголовок Authorization — это ограничение самого API, не проекта.
// Поэтому токен уходил в строку запроса: /api/stream?token=<AZRAIL_TOKEN>.
// Строка запроса попадает в логи Cloudflare, в историю браузера и в Referer.
// То есть ПОСТОЯННЫЙ токен от всех платных эндпоинтов оседал в местах, из
// которых его никто не удалит.
//
// Билет живёт минуту, годен один раз и не даёт ничего, кроме подключения к
// потоку. Утечь он может ровно так же — но утекает уже мусор.

import type { Env } from "../types";
import { log } from "./resilience";

/** Срок жизни билета. Секунд достаточно: между выдачей и рукопожатием
 *  проходит доли секунды, а всё сверх этого — только окно для чужого. */
export const TICKET_TTL_SECONDS = 60;

const keyFor = (ticket: string) => `wsticket:${ticket}`;

/** Выдать билет. Вызывается только после успешной проверки токена. */
export async function issueTicket(env: Env, caller: string): Promise<{ ticket: string; expiresIn: number }> {
  const ticket = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.AZRAIL_KV.put(keyFor(ticket), caller, { expirationTtl: TICKET_TTL_SECONDS });
  return { ticket, expiresIn: TICKET_TTL_SECONDS };
}

/**
 * Погасить билет. Именно погасить, а не просто проверить: ключ удаляется
 * сразу после чтения, поэтому подсмотренный в логах билет второй раз не
 * сработает. Без удаления это был бы просто токен покороче.
 */
export async function redeemTicket(env: Env, ticket: string): Promise<string | null> {
  if (!ticket) return null;
  try {
    const caller = await env.AZRAIL_KV.get(keyFor(ticket));
    if (!caller) return null;
    await env.AZRAIL_KV.delete(keyFor(ticket));
    return caller;
  } catch (err) {
    // KV недоступен — билет считается негодным. Здесь fail-closed уместен:
    // это ворота авторизации, а не счётчик.
    log("error", "wsticket.kv_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
