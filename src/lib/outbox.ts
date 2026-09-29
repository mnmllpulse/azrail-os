import { getAgentByName } from "agents";
import type { Env } from "../types";
import { log } from "./resilience";
export async function dispatchOutbox(env:Env):Promise<void> {
  const {results}=await env.AZRAIL_D1.prepare("SELECT o.mission_id,o.params FROM mission_outbox o JOIN missions m ON m.id=o.mission_id WHERE o.delivered=0 AND m.status='queued' ORDER BY o.created_at LIMIT 20").all<{mission_id:string;params:string}>();
  for(const row of results) {
    try {
      const params=JSON.parse(row.params);
      const agent=await getAgentByName(env.Orchestrator,params.projectId);
      await agent.startMission(params);
    } catch { log("error","outbox.delivery_failed",{missionId:row.mission_id}); }
  }
}
