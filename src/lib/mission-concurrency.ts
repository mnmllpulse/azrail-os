import type { Env } from "../types";
/** Admission and durable delivery intent are one D1 transaction. */
export async function createMission(env: Env, id: string, projectId: string, goal: string, options:Record<string,unknown>={}): Promise<boolean> {
  const now = new Date().toISOString();
  const results=await env.AZRAIL_D1.batch([
    env.AZRAIL_D1.prepare(`INSERT INTO missions(id,project_id,goal,status,created_at,updated_at)
      SELECT ?,?,?,'queued',?,? WHERE NOT EXISTS(SELECT 1 FROM missions WHERE project_id=? AND status IN ('queued','executing','cancelling')) RETURNING id`)
      .bind(id,projectId,goal,now,now,projectId),
    env.AZRAIL_D1.prepare("INSERT INTO mission_outbox(mission_id,params,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM missions WHERE id=?)")
      .bind(id,JSON.stringify({missionId:id,projectId,goal,maxIterations:12,...options}),Date.now(),id),
  ]);
  return !!results[0].results?.length;
}
