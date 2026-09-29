import type { Env } from "../types";
import type { Principal } from "./accounts";

const ACTIVE_WINDOW_MS = 90_000;
const MAX_SESSIONS = 100;

function coarse(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Roughly region-level: ~2 degrees. Enough for a globe marker, not exact tracking.
  return Math.round(n / 2) * 2;
}

export interface PresenceSession {
  id: string;
  label: string;
  projectId?: string;
  country?: string;
  edge?: string;
  lat?: number;
  lon?: number;
  lastSeen: number;
  isSelf: boolean;
}

export async function heartbeatPresence(
  env: Env,
  principal: Principal,
  cf: Record<string, unknown>,
  input: { sessionId?: unknown; projectId?: unknown },
): Promise<{ sessionId: string; expiresAt: number }> {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw new TypeError("Некорректный sessionId.");

  const projectId = typeof input.projectId === "string" && input.projectId ? input.projectId : null;
  const country = typeof cf.country === "string" ? cf.country.slice(0, 8) : null;
  const edge = typeof cf.colo === "string" ? cf.colo.slice(0, 12) : null;
  const lat = coarse(cf.latitude);
  const lon = coarse(cf.longitude);
  const now = Date.now();

  await env.AZRAIL_D1.prepare(
    `INSERT INTO pulse_presence(session_id,account_id,project_id,country,edge,lat,lon,last_seen)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET
       account_id=excluded.account_id,
       project_id=excluded.project_id,
       country=excluded.country,
       edge=excluded.edge,
       lat=excluded.lat,
       lon=excluded.lon,
       last_seen=excluded.last_seen`,
  ).bind(sessionId, principal.id, projectId, country, edge, lat, lon, now).run();

  // Cheap opportunistic cleanup; no extra cron is needed for ephemeral presence.
  await env.AZRAIL_D1.prepare("DELETE FROM pulse_presence WHERE last_seen < ?")
    .bind(now - ACTIVE_WINDOW_MS * 2).run();

  return { sessionId, expiresAt: now + ACTIVE_WINDOW_MS };
}

export async function listPresence(
  env: Env,
  principal: Principal,
  selfSessionId: string,
  projectId?: string,
): Promise<PresenceSession[]> {
  const since = Date.now() - ACTIVE_WINDOW_MS;
  const accountClause = principal.role === "admin" ? "" : " AND account_id=?";
  const projectClause = projectId ? " AND (project_id=? OR project_id IS NULL)" : "";
  const sql =
    `SELECT session_id,project_id,country,edge,lat,lon,last_seen
     FROM pulse_presence
     WHERE last_seen>=?${accountClause}${projectClause}
     ORDER BY last_seen DESC LIMIT ?`;
  const values: Array<string | number> = [since];
  if (principal.role !== "admin") values.push(principal.id);
  if (projectId) values.push(projectId);
  values.push(MAX_SESSIONS);
  const query = env.AZRAIL_D1.prepare(sql).bind(...values);

  const rows = await query.all<{
    session_id: string; project_id: string | null; country: string | null; edge: string | null;
    lat: number | null; lon: number | null; last_seen: number;
  }>();

  return (rows.results ?? []).map((row) => ({
    id: row.session_id,
    label: row.session_id === selfSessionId ? "This session" : "Active session",
    projectId: row.project_id ?? undefined,
    country: row.country ?? undefined,
    edge: row.edge ?? undefined,
    lat: row.lat ?? undefined,
    lon: row.lon ?? undefined,
    lastSeen: row.last_seen,
    isSelf: row.session_id === selfSessionId,
  }));
}
