import type { Env } from "../types";
/** Caller authorizes the project first; admission, catalogue and delivery are atomic. */
export async function createMission(env: Env, id: string, projectId: string, goal: string, options:Record<string,unknown>={}): Promise<boolean> {
  const now = new Date().toISOString();
  const results=await env.AZRAIL_D1.batch([
    env.AZRAIL_D1.prepare(`INSERT INTO missions(id,project_id,goal,status,created_at,updated_at)
      SELECT ?,?,?,'queued',?,? WHERE NOT EXISTS(SELECT 1 FROM missions WHERE project_id=? AND status IN ('queued','executing','cancelling')) RETURNING id`)
      .bind(id,projectId,goal,now,now,projectId),
    env.AZRAIL_D1.prepare("INSERT INTO mission_outbox(mission_id,params,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM missions WHERE id=?)")
      .bind(id,JSON.stringify({missionId:id,projectId,goal,maxIterations:12,...options}),Date.now(),id),
    // The Create screen can start with a fresh project ID. Register its
    // catalogue row only if this mission was admitted; a rejected/busy request
    // must not create a ghost project. Existing metadata and ownership stay intact.
    env.AZRAIL_D1.prepare("INSERT INTO users(id,name) SELECT 'system','AZRAIL system' WHERE EXISTS(SELECT 1 FROM missions WHERE id=?) ON CONFLICT(id) DO NOTHING").bind(id),
    env.AZRAIL_D1.prepare(`INSERT INTO projects(id,user_id,name,status,r2_prefix,created_at,updated_at)
      SELECT ?,'system',?,'active',?,?,? WHERE EXISTS(SELECT 1 FROM missions WHERE id=?) ON CONFLICT(id) DO NOTHING`)
      .bind(projectId,goal.trim().replace(/\s+/g,' ').slice(0,120)||'Новый проект',`projects/${projectId}/`,now,now,id),
  ]);
  return !!results[0].results?.length;
}
