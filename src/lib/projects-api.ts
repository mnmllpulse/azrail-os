import type { Env } from "../types";
import type { Principal } from "./accounts";
import { requireResource } from "./accounts";
import { ensureProject } from "./project";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  stack: string | null;
  status: string;
  r2_prefix: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  stack?: string;
  status: "active" | "archived";
  r2Prefix?: string;
  createdAt: string;
  updatedAt: string;
}

function mapProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    stack: row.stack ?? undefined,
    status: row.status === "archived" ? "archived" : "active",
    r2Prefix: row.r2_prefix ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function validateProjectName(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Название проекта обязательно.");
  const name = value.trim();
  if (name.length < 1 || name.length > 120) {
    throw new TypeError("Название проекта должно содержать от 1 до 120 символов.");
  }
  return name;
}

export function validateProjectDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) {
    throw new TypeError("Описание проекта должно быть строкой до 2000 символов.");
  }
  return value.trim() || null;
}

export async function listProjects(env: Env, principal: Principal): Promise<ProjectSummary[]> {
  const result = principal.role === "admin"
    ? await env.AZRAIL_D1.prepare(
        "SELECT id,name,description,stack,status,r2_prefix,created_at,updated_at FROM projects WHERE status<>'deleted' ORDER BY updated_at DESC LIMIT 200",
      ).all<ProjectRow>()
    : await env.AZRAIL_D1.prepare(
        "SELECT p.id,p.name,p.description,p.stack,p.status,p.r2_prefix,p.created_at,p.updated_at FROM projects p JOIN resource_owners o ON o.kind='project' AND o.resource_id=p.id WHERE o.account_id=? AND p.status<>'deleted' ORDER BY p.updated_at DESC LIMIT 200",
      ).bind(principal.id).all<ProjectRow>();

  return (result.results ?? []).map(mapProject);
}

export async function getProject(env: Env, principal: Principal, projectId: string): Promise<ProjectSummary | null> {
  await requireResource(env, principal, "project", projectId);
  const row = await env.AZRAIL_D1.prepare(
    "SELECT id,name,description,stack,status,r2_prefix,created_at,updated_at FROM projects WHERE id=? AND status<>'deleted'",
  ).bind(projectId).first<ProjectRow>();
  return row ? mapProject(row) : null;
}

export async function createProject(
  env: Env,
  principal: Principal,
  input: { name?: unknown; description?: unknown },
): Promise<ProjectSummary> {
  const name = validateProjectName(input.name);
  const description = validateProjectDescription(input.description);
  const projectId = crypto.randomUUID();

  // Ownership is claimed before the row exists. For non-admin accounts this
  // prevents the legacy-resource safeguard from mistaking our own fresh row
  // for somebody else's project.
  await requireResource(env, principal, "project", projectId, true);

  const created = await ensureProject(env, projectId, name);
  if (!created) {
    await env.AZRAIL_D1.prepare(
      "DELETE FROM resource_owners WHERE kind='project' AND resource_id=? AND account_id=?",
    ).bind(projectId, principal.id).run();
    throw new Error("Не удалось создать проект.");
  }

  await env.AZRAIL_D1.prepare(
    "UPDATE projects SET name=?,description=?,r2_prefix=?,status='active',updated_at=datetime('now') WHERE id=?",
  ).bind(name, description, `projects/${projectId}/`, projectId).run();

  const project = await getProject(env, principal, projectId);
  if (!project) throw new Error("Созданный проект не найден.");
  return project;
}

export async function updateProject(
  env: Env,
  principal: Principal,
  projectId: string,
  input: { name?: unknown; description?: unknown; status?: unknown },
): Promise<ProjectSummary> {
  await requireResource(env, principal, "project", projectId);

  const existing = await getProject(env, principal, projectId);
  if (!existing) throw new Error("Проект не найден.");

  const name = input.name === undefined ? existing.name : validateProjectName(input.name);
  const description = input.description === undefined
    ? existing.description ?? null
    : validateProjectDescription(input.description);

  let status = existing.status;
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "archived") {
      throw new TypeError("status должен быть active или archived.");
    }
    status = input.status;
  }

  await env.AZRAIL_D1.prepare(
    "UPDATE projects SET name=?,description=?,status=?,updated_at=datetime('now') WHERE id=?",
  ).bind(name, description, status, projectId).run();

  const updated = await getProject(env, principal, projectId);
  if (!updated) throw new Error("Проект не найден после обновления.");
  return updated;
}
