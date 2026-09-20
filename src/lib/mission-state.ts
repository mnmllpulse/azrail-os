// AZRAIL — жизненный цикл миссии в D1.
//
// Появился вместе с переносом миссии в фон. До этого весь цикл жил внутри
// одного HTTP-запроса: POST /api/mission ждал `runMission()` от начала до
// конца. Cloudflare обрывает клиентское соединение примерно на сотой
// секунде — а миссия из восьми шагов с вызовами модели в неё почти никогда
// не укладывается. Отдавался 524, результат терялся, и — что хуже — строка
// в missions навсегда оставалась в статусе "executing", потому что UPDATE
// стоял ПОСЛЕ await, до которого управление уже не доходило.
//
// Здесь собраны все переходы статуса в одном месте: раньше они были
// размазаны по роуту, и половина путей (отмена, зависание) не existовала
// вовсе.

import type { Env, TaskResult } from "../types";
import { log } from "./resilience";

/** Статусы, которые миссия может иметь в D1. */
export type MissionRow = {
  id: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  result_json?: string | null;
};

/** Статусы, после которых миссия больше ничего не делает. */
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "waiting_approval"] as const;

export function isTerminal(status: string | undefined | null): boolean {
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Перевод статуса TaskResult в статус строки миссии. */
export function statusForResult(result: Pick<TaskResult, "status" | "error">): string {
  if (result.error === "cancelled") return "cancelled";
  if (result.status === "done") return "completed";
  if (result.status === "failed") return "failed";
  return "waiting_approval";
}

/**
 * Запись финального состояния миссии.
 *
 * result_json — новая колонка. Клиент больше не получает результат в ответе
 * на POST (тот возвращается сразу, ещё до начала работы), и без сохранения
 * результата забрать его потом было бы неоткуда: события в mission_events
 * описывают ход, но не итог.
 *
 * ЗАПАСНОЙ ПУТЬ ОБЯЗАТЕЛЕН: у уже развёрнутой базы этой колонки нет, пока
 * не применена миграция. Падать здесь нельзя — работа сделана, файлы
 * записаны, и потерять отметку о завершении из-за отсутствия колонки
 * означало бы оставить миссию вечно висящей.
 */
export async function finishMission(
  env: Env,
  missionId: string,
  status: string,
  result: TaskResult | null,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await env.AZRAIL_D1.prepare(
      `UPDATE missions SET status = ?, finished_at = ?, updated_at = ?, result_json = ? WHERE id = ?`,
    )
      .bind(status, now, now, result ? JSON.stringify(result) : null, missionId)
      .run();
    return;
  } catch (err) {
    log("warn", "mission.finish_without_result_column", {
      missionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await env.AZRAIL_D1.prepare(
      `UPDATE missions SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(status, now, now, missionId)
      .run();
  } catch (err) {
    log("error", "mission.finish_failed", {
      missionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Отметка «идёт работа» — для наблюдателя и для сборщика зависших. */
export async function markRunning(env: Env, missionId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await env.AZRAIL_D1.prepare(`UPDATE missions SET status = 'executing', updated_at = ? WHERE id = ?`)
      .bind(now, missionId)
      .run();
  } catch (err) {
    log("warn", "mission.mark_running_failed", {
      missionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Запрос на остановку. Не убивает цикл — выставляет флаг, который цикл
 * читает на границе шага (см. ExecutionContext.shouldAbort).
 *
 * Возвращает, что реально произошло: миссия уже завершилась — «поздно»,
 * миссии нет — «не найдена». Тихое `success: true` на несуществующий id
 * выглядело бы как успешная отмена того, чего не было.
 */
export async function requestCancel(
  env: Env,
  missionId: string,
): Promise<{ ok: boolean; reason: "cancelling" | "already_finished" | "not_found"; status?: string }> {
  const row = await env.AZRAIL_D1.prepare(`SELECT status FROM missions WHERE id = ?`)
    .bind(missionId)
    .first<{ status: string }>();
  if (!row) return { ok: false, reason: "not_found" };
  if (isTerminal(row.status)) return { ok: false, reason: "already_finished", status: row.status };

  await env.AZRAIL_D1.prepare(`UPDATE missions SET status = 'cancelling', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), missionId)
    .run();
  return { ok: true, reason: "cancelling", status: "cancelling" };
}

/** Читает флаг остановки. Ошибка чтения НЕ останавливает миссию: недоступная
 *  база — не команда «стоп», и прерывать из-за неё начатую работу нельзя. */
export async function isCancelRequested(env: Env, missionId: string): Promise<boolean> {
  try {
    const row = await env.AZRAIL_D1.prepare(`SELECT status FROM missions WHERE id = ?`)
      .bind(missionId)
      .first<{ status: string }>();
    return row?.status === "cancelling" || row?.status === "cancelled";
  } catch (err) {
    log("warn", "mission.cancel_check_failed", {
      missionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Сколько минут без обновления считать зависанием. */
export const DEFAULT_STALE_MINUTES = 20;

export function staleMinutes(env: Env): number {
  const n = Number(env.AZRAIL_MISSION_STALE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MINUTES;
}

/**
 * Сборщик зависших миссий. Запускается по крону.
 *
 * Зачем нужен, если статус теперь пишется в фоне: Durable Object можно
 * выселить, инстанс — перезапустить, alarm — не доставить. Любой из этих
 * случаев оставляет строку в "executing" навсегда, и интерфейс будет
 * показывать вечно идущую работу, которой давно нет. Крон — единственное,
 * что это закрывает: сама остановленная миссия о себе уже не сообщит.
 *
 * Выделено в функцию, а не вписано в обработчик, чтобы было чем проверять:
 * обработчик крона в тесте не позвать.
 */
export async function reapStaleMissions(env: Env, now = Date.now()): Promise<{ reaped: number; ids: string[] }> {
  const cutoff = new Date(now - staleMinutes(env) * 60_000).toISOString();
  const { results } = await env.AZRAIL_D1.prepare(
    `SELECT id FROM missions
      WHERE status IN ('queued', 'executing', 'cancelling')
        AND COALESCE(updated_at, created_at) < ?
      LIMIT 100`,
  )
    .bind(cutoff)
    .all<{ id: string }>();

  const ids = (results ?? []).map((r) => r.id);
  for (const id of ids) {
    await finishMission(env, id, "failed", {
      status: "failed",
      agent: "mission-reaper",
      summary:
        `Миссия не подавала признаков жизни дольше ${staleMinutes(env)} мин и помечена как упавшая. ` +
        `Сделанные до этого шаги остались в журнале.`,
      error: "stale",
    });
  }
  if (ids.length) log("warn", "mission.reaped", { count: ids.length, ids });
  return { reaped: ids.length, ids };
}

/* ── Подсказки на ходу ────────────────────────────────────────────────
 *
 * ЗАЧЕМ. До сих пор в идущую миссию можно было только вмешаться топором:
 * отменить. Видишь по карте, что агент пошёл не туда, — и единственный
 * доступный жест это убить всё вместе с наработанным контекстом. Для
 * миссии на десять минут это дорого до нелепости.
 *
 * ГДЕ ХРАНИТСЯ. В KV, а не в D1. Подсказка живёт секунды: её кладут и
 * почти сразу забирают. Отдельная таблица с историей и индексами ради
 * значения, которое существует до следующего шага, — лишняя работа и
 * лишняя схема. TTL сам чистит то, что никто не забрал.
 */

/** Сколько живёт неподобранная подсказка. Миссия читает их на каждом
 *  шаге; час — с запасом на самый медленный шаг и на то, что подсказку
 *  отправили в миссию, которая уже падает. */
const HINT_TTL_SECONDS = 3600;

/** Потолок на одну подсказку. Это реплика в одну-две фразы, а не
 *  переписывание задания: длинная подсказка вытеснит из запроса саму
 *  задачу и сделает ровно то, от чего мы бережём контекст. */
export const MAX_HINT_LENGTH = 600;

/** Сколько подсказок ждёт своей очереди. Больше пяти — это уже не
 *  поправка на ходу, а новая задача; её надо ставить отдельной миссией. */
export const MAX_PENDING_HINTS = 5;

const hintKey = (missionId: string) => `mission:hints:${missionId}`;

export async function sendHint(
  env: Env,
  missionId: string,
  text: string,
): Promise<{ ok: boolean; reason: "queued" | "empty" | "too_many" | "already_finished" | "not_found" }> {
  const clean = text.trim().slice(0, MAX_HINT_LENGTH);
  if (!clean) return { ok: false, reason: "empty" };

  const row = await env.AZRAIL_D1.prepare(`SELECT status FROM missions WHERE id = ?`)
    .bind(missionId)
    .first<{ status: string }>();
  if (!row) return { ok: false, reason: "not_found" };

  // Подсказка завершённой миссии — не ошибка пользователя, а опоздание.
  // Принять её молча значило бы дать человеку думать, что она учтётся.
  if (isTerminal(row.status)) return { ok: false, reason: "already_finished" };

  const existing = await readHints(env, missionId);
  if (existing.length >= MAX_PENDING_HINTS) return { ok: false, reason: "too_many" };

  await env.AZRAIL_KV.put(hintKey(missionId), JSON.stringify([...existing, clean]), {
    expirationTtl: HINT_TTL_SECONDS,
  });
  return { ok: true, reason: "queued" };
}

async function readHints(env: Env, missionId: string): Promise<string[]> {
  const raw = await env.AZRAIL_KV.get(hintKey(missionId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // Испорченное значение — это отсутствие подсказок, а не повод падать.
    return [];
  }
}

/**
 * Забирает подсказки и сразу их стирает.
 *
 * Стирание ДО возврата, а не после обработки: подсказка, пережившая свой
 * шаг, будет повторена моделью на следующем — и агент получит её дважды,
 * как настойчивое требование. Цена ошибки здесь несимметрична: потерять
 * подсказку при сбое неприятно, повторять её бесконечно — хуже.
 *
 * Сбой чтения миссию не трогает: подсказки вспомогательны.
 */
export async function drainHints(env: Env, missionId: string): Promise<string[]> {
  try {
    const hints = await readHints(env, missionId);
    if (hints.length) await env.AZRAIL_KV.delete(hintKey(missionId));
    return hints;
  } catch (err) {
    log("warn", "mission.hint_drain_failed", {
      missionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
