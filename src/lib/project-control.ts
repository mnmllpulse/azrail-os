import type { Env } from "../types";
import { AccessError } from "./accounts";

export async function withProjectLock<T>(env:Env,project:string|undefined,owner:string,work:()=>Promise<T>):Promise<T> {
  if(!project) return work();
  const row=await env.AZRAIL_D1.prepare("INSERT INTO operation_locks(project_id,owner,started_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING owner").bind(project,owner,Date.now()).first();
  if(!row) throw new AccessError("Проект занят. Если процесс прервался, используйте восстановление миссии.",409);
  try { return await work(); }
  finally { await env.AZRAIL_D1.prepare("DELETE FROM operation_locks WHERE project_id=? AND owner=?").bind(project,owner).run(); }
}
export async function requireCapability(env:Env,project:string|undefined,capability:string):Promise<void> {
  if(!["git","deploy","sandbox","qa"].includes(capability)) return;
  if(!project) throw new AccessError("Интеграция требует проект.");
  const row=await env.AZRAIL_D1.prepare("SELECT 1 AS ok FROM project_permissions WHERE project_id=? AND capability=?").bind(project,capability).first();
  if(!row) throw new AccessError(`Администратор не разрешил ${capability} для этого проекта.`);
}
export function toolCapability(tool:string):string {
  if(tool.startsWith("sandbox_"))return "sandbox";
  if(tool==="open_pr"||tool==="git_diff")return "git";
  if(tool==="run_tests")return "qa";
  return "";
}
