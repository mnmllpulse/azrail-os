import type { Env } from "../types";
import { log } from "./resilience";

export function positiveLimit(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** One SQL statement reserves a fixed-window quota, including concurrent requests. */
export async function reserveQuota(env: Env, scope: string, cost: number, limit: number) {
  const bucket = Math.floor(Date.now() / 3_600_000);
  const resetAt = (bucket + 1) * 3_600_000;
  if (!Number.isSafeInteger(cost) || cost <= 0 || cost > limit) {
    return { allowed: false, used: 0, limit, resetAt };
  }
  try {
    const row = await env.AZRAIL_D1.prepare(`
      INSERT INTO request_quotas (scope, bucket, used) VALUES (?, ?, ?)
      ON CONFLICT(scope, bucket) DO UPDATE SET used = used + excluded.used
      WHERE used + excluded.used <= ? RETURNING used
    `).bind(scope, bucket, cost, limit).first<{ used: number }>();
    if (row) return { allowed: true, used: row.used, limit, resetAt };
    const current = await env.AZRAIL_D1.prepare(
      "SELECT used FROM request_quotas WHERE scope = ? AND bucket = ?",
    ).bind(scope, bucket).first<{ used: number }>();
    return { allowed: false, used: current?.used ?? limit, limit, resetAt };
  } catch (err) {
    log("error", "quota.unavailable", { scope, error: err instanceof Error ? err.message : String(err) });
    return { allowed: false, used: 0, limit, resetAt };
  }
}

export async function cleanupSecurityState(env: Env): Promise<void> {
  await env.AZRAIL_D1.batch([
    // Admission records include uncertain effects and successful replay bodies.
    // Deleting them on a timer permits the same request to spend twice.
    env.AZRAIL_D1.prepare("DELETE FROM request_quotas WHERE bucket < ?")
      .bind(Math.floor(Date.now() / 3_600_000) - 1),
    env.AZRAIL_D1.prepare("DELETE FROM websocket_tickets WHERE expires_at <= ?").bind(Date.now()),
  ]);
}
