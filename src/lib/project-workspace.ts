import type { Env } from "../types";
import { listFilesPage } from "./workspace";
import { listFacts } from "./memory-agent";
import { listVersions } from "./versions";

export interface ProjectWorkspaceSnapshot {
  files: Awaited<ReturnType<typeof listFilesPage>>;
  memory: Awaited<ReturnType<typeof listFacts>>;
  versions: Awaited<ReturnType<typeof listVersions>>;
}

export async function loadProjectWorkspace(
  env: Env,
  projectId: string,
): Promise<ProjectWorkspaceSnapshot> {
  const [files, memory, versions] = await Promise.all([
    listFilesPage(env, projectId, 200),
    listFacts(env, projectId, 30),
    listVersions(env, projectId, 30),
  ]);
  return { files, memory, versions };
}
