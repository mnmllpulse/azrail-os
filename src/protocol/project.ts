/**
 * Canonical project transport model for DARK MNMLL PULSE OS.
 * Не импортирует внутренние классы AZRAIL и пригоден для UI/API boundary.
 */

export type ProjectStatus = "active" | "archived" | "deleted";

export interface ProjectFileRef {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  r2Key?: string;
  createdAt: string;
}

export interface ProjectDeploymentRef {
  id: string;
  provider: "cloudflare" | "vercel" | "github" | "other";
  environment: "preview" | "staging" | "production";
  status: "queued" | "building" | "ready" | "failed";
  url?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  defaultConversationId?: string;
  activeMissionId?: string;
  files: ProjectFileRef[];
  deployments: ProjectDeploymentRef[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  status?: Exclude<ProjectStatus, "deleted">;
}
