import type { Env } from "../types";

// Правило проекта: CORS всегда через динамический getCors() + CORS_ORIGIN,
// никогда не хардкодить домен.
export function getCors(env: Env, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN || "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return headers;
}
