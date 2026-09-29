import type { Env } from "../types";
import { UnsafePathError } from "./safe-path";

export function workspacePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 500 || /[\\\x00-\x1f\x7f]/.test(value)
      || value.split("/").some(p => !p || p === "." || p === "..")) {
    throw new UnsafePathError("workspace path", value);
  }
  return value;
}

/** 0.8's default prefix stored URL-encoded segments; published versions used raw paths.
 * New versioned workspaces and snapshots use raw R2 keys (R2 is not a URL). */
export function storedWorkspacePath(prefix: string, path: string): string {
  const safe = workspacePath(path);
  return prefix.endsWith("/workspace/") ? safe.split("/").map(encodeURIComponent).join("/") : safe;
}
export function logicalWorkspacePath(prefix: string, stored: string): string {
  const path = prefix.endsWith("/workspace/") ? stored.split("/").map(decodeURIComponent).join("/") : stored;
  return workspacePath(path);
}
export async function workspacePrefix(env: Env, project: string): Promise<string> {
  const fallback = `projects/${project}/workspace/`;
  if (!env.AZRAIL_D1) return fallback;
  const row = await env.AZRAIL_D1.prepare("SELECT prefix FROM workspace_heads WHERE project_id=?")
    .bind(project).first<{prefix:string}>();
  if (!row) return fallback;
  if (!row.prefix.startsWith(`projects/${project}/workspace-versions/`) || !row.prefix.endsWith("/"))
    throw new Error("Invalid workspace head");
  return row.prefix;
}
export async function publishWorkspace(env: Env, project: string, files: Array<{path:string;content:string|Uint8Array}>) {
  const paths = files.map(f => workspacePath(f.path));
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate workspace paths");
  const prefix = `projects/${project}/workspace-versions/${crypto.randomUUID()}/`;
  for (const f of files) await env.AZRAIL_R2.put(prefix + f.path, f.content);
  await env.AZRAIL_D1.prepare("INSERT INTO workspace_heads(project_id,prefix) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET prefix=excluded.prefix")
    .bind(project,prefix).run();
  return prefix;
}
