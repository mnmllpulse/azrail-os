import type { Env, MissionEvent } from "../types";

export async function emitMissionEvent(env: Env, missionId: string, type: string, data?: unknown) {
  const event: MissionEvent = { id: crypto.randomUUID(), missionId, type, data, createdAt: new Date().toISOString() };
  await env.AZRAIL_D1.prepare(`INSERT INTO mission_events (id, mission_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(event.id, missionId, type, JSON.stringify(data ?? null), event.createdAt).run();
  return event;
}

export async function listMissionEvents(env: Env, missionId: string, limit = 200) {
  const { results } = await env.AZRAIL_D1.prepare(
    `SELECT id, mission_id, type, data, created_at FROM mission_events WHERE mission_id = ? ORDER BY created_at ASC LIMIT ?`
  ).bind(missionId, limit).all();
  return results.map((r: any) => ({ ...r, data: typeof r.data === "string" ? safeJson(r.data) : r.data }));
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return s; } }
