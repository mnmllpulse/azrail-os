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
      `UPDATE missions SET status = ?, finished_at = ?, updated_at = ?, result_json = ? WHERE id = ? AND status IN ('queued', 'executing', 'cancelling')`,
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
      `UPDATE missions SET status = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'executing', 'cancelling')`,
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
export async function markRunning(env: Env, missionId: string): Promise<boolean> {
  const row = await env.AZRAIL_D1.prepare(
    "UPDATE missions SET status='executing', updated_at=? WHERE id=? AND status='queued' RETURNING id",
  ).bind(new Date().toISOString(), missionId).first<{id:string}>();
  return !!row;
}

/** Compare-and-set: cancellation must never resurrect a terminal mission. */
export async function requestCancel(
  env: Env, missionId: string,
): Promise<{ ok: boolean; reason: "cancelling" | "already_finished" | "not_found"; status?: string }> {
  const changed = await env.AZRAIL_D1.prepare(
    "UPDATE missions SET status='cancelling', updated_at=? WHERE id=? AND status IN ('queued','executing','cancelling') RETURNING id",
  ).bind(new Date().toISOString(), missionId).first<{id:string}>();
  if (changed) return { ok: true, reason: "cancelling", status: "cancelling" };
  const row = await env.AZRAIL_D1.prepare("SELECT status FROM missions WHERE id = ?")
    .bind(missionId).first<{status:string}>();
  return row ? {ok:false, reason:"already_finished", status:row.status} : {ok:false, reason:"not_found"};
}

/** A lost lease, missing row, or terminal status stops further work.
 * A database error propagates: it is not permission to keep spending. */
export async function isCancelRequested(env: Env, missionId: string): Promise<boolean> {
  const row = await env.AZRAIL_D1.prepare("SELECT status FROM missions WHERE id = ?")
    .bind(missionId).first<{status:string}>();
  return !row || !["queued", "executing"].includes(row.status);
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
  const finishedAt = new Date(now).toISOString();
  const result: TaskResult = {
    status: "failed", agent: "mission-reaper",
    summary: `Миссия не обновлялась дольше ${staleMinutes(env)} мин. Сделанные шаги сохранены.`, error: "stale",
  };
  // Selection and transition are one statement; a fresh heartbeat cannot be overwritten.
  const {results} = await env.AZRAIL_D1.prepare(`
    UPDATE missions SET status='failed', finished_at=?, updated_at=?, result_json=?
    WHERE id IN (SELECT id FROM missions
      WHERE status IN ('queued','executing','cancelling')
      AND COALESCE(updated_at,created_at) < ? LIMIT 100)
    RETURNING id
  `).bind(finishedAt, finishedAt, JSON.stringify(result), cutoff).all<{id:string}>();
  const ids = (results ?? []).map(row => row.id);
  if (ids.length) log("warn", "mission.reaped", {count:ids.length, ids});
  await env.AZRAIL_D1.prepare("DELETE FROM mission_hints WHERE expires_at <= ?").bind(now).run();
  return {reaped:ids.length, ids};
}

const HINT_TTL_SECONDS = 3600;
export const MAX_HINT_LENGTH = 600;
export const MAX_PENDING_HINTS = 5;

/** D1 admission and DELETE RETURNING avoid KV read/modify/write lost updates. */
export async function sendHint(
  env: Env, missionId: string, text: string,
): Promise<{ok:boolean; reason:"queued"|"empty"|"too_many"|"already_finished"|"not_found"}> {
  const clean = text.trim().slice(0, MAX_HINT_LENGTH);
  if (!clean) return {ok:false, reason:"empty"};
  const now = Date.now();
  const inserted = await env.AZRAIL_D1.prepare(`
    INSERT INTO mission_hints(mission_id,text,expires_at)
    SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM missions WHERE id=? AND status IN ('queued','executing'))
    AND (SELECT COUNT(*) FROM mission_hints WHERE mission_id=? AND expires_at>?) < ?
    RETURNING id
  `).bind(missionId, clean, now + HINT_TTL_SECONDS * 1000, missionId, missionId, now, MAX_PENDING_HINTS).first();
  if (inserted) return {ok:true, reason:"queued"};
  const row = await env.AZRAIL_D1.prepare("SELECT status FROM missions WHERE id = ?")
    .bind(missionId).first<{status:string}>();
  if (!row) return {ok:false, reason:"not_found"};
  return {ok:false, reason:["queued","executing"].includes(row.status) ? "too_many" : "already_finished"};
}

/** Atomically takes the queue. Concurrent new messages cannot be erased. */
export async function drainHints(env: Env, missionId: string): Promise<string[]> {
  try {
    const {results} = await env.AZRAIL_D1.prepare(
      "DELETE FROM mission_hints WHERE mission_id=? RETURNING id,text,expires_at",
    ).bind(missionId).all<{id:number;text:string;expires_at:number}>();
    return (results ?? []).filter(r=>r.expires_at>Date.now()).sort((a,b)=>a.id-b.id).map(r=>r.text);
  } catch (err) {
    log("warn", "mission.hint_drain_failed", {missionId, error:err instanceof Error ? err.message : String(err)});
    return [];
  }
}
