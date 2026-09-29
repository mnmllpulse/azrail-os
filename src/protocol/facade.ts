/**
 * Public Pulse/AZRAIL facade.
 *
 * New UI uses /api/azrail/* while the existing runtime keeps its stable
 * internal routes. Normalization happens before auth, idempotency and
 * rate-limits, so aliases cannot bypass the existing protection boundary.
 */

const EXACT_ALIASES: Record<string, string> = {
  "/api/azrail/mission": "/api/mission",
  "/api/azrail/mission/cancel": "/api/mission/cancel",
  "/api/azrail/mission/hint": "/api/mission/hint",
  "/api/azrail/mission/recover": "/api/mission/recover",
  "/api/azrail/models": "/api/models",
  "/api/azrail/model-catalog": "/api/model-catalog",
  "/api/azrail/tools": "/api/tools",
  "/api/azrail/agents": "/api/agents",
  "/api/azrail/metrics": "/api/metrics",
  "/api/azrail/chat": "/api/chat",
  "/api/azrail/conversations": "/api/conversations",
  "/api/azrail/upload": "/api/upload",
  "/api/azrail/stream": "/api/stream",
  "/api/azrail/stream/ticket": "/api/stream/ticket",
  "/api/azrail/projects": "/api/projects",
  "/api/azrail/me": "/api/me",
  "/api/azrail/routing-settings": "/api/routing-settings",
};

export function canonicalApiPath(pathname: string): string {
  const exact = EXACT_ALIASES[pathname];
  if (exact) return exact;

  if (pathname.startsWith("/api/azrail/projects/")) {
    return "/api/projects/" + pathname.slice("/api/azrail/projects/".length);
  }

  return pathname;
}

export function normalizeAzrailRequest(request: Request): Request {
  const url = new URL(request.url);
  const canonical = canonicalApiPath(url.pathname);
  if (canonical === url.pathname) return request;
  url.pathname = canonical;
  return new Request(url.toString(), request);
}
