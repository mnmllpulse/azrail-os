import type { Env } from "../types";
export class UncertainToolError extends Error {
  constructor(cause: unknown) { super("Результат шага неопределён; повтор остановлен: " + (cause instanceof Error ? cause.message : String(cause))); }
}
/** In-flight actions are never guessed successful or repeated automatically. */
export async function checkpointTool<T>(env:Env,mission:string,step:number,tool:string,input:unknown,work:()=>Promise<T>,mayHaveEffects=true):Promise<T> {
  const old=await env.AZRAIL_D1.prepare("SELECT status,result_json FROM mission_checkpoints WHERE mission_id=? AND step=?").bind(mission,step).first<{status:string;result_json:string|null}>();
  if(old) throw new Error("Шаг уже записан; требуется восстановление контекста миссии.");
  await env.AZRAIL_D1.prepare("INSERT INTO mission_checkpoints(mission_id,step,tool,input_json,status,updated_at) VALUES(?,?,?,?,'running',?)").bind(mission,step,tool,JSON.stringify(input),Date.now()).run();
  try {
    const value=await work();
    await env.AZRAIL_D1.prepare("UPDATE mission_checkpoints SET status='completed',result_json=?,updated_at=? WHERE mission_id=? AND step=?").bind(JSON.stringify(value)??"null",Date.now(),mission,step).run();
    return value;
  } catch(err) {
    if(!mayHaveEffects) {
      await env.AZRAIL_D1.prepare("UPDATE mission_checkpoints SET status='failed',result_json=?,updated_at=? WHERE mission_id=? AND step=?").bind(JSON.stringify({error:err instanceof Error?err.message:String(err)}),Date.now(),mission,step).run();
      throw err;
    }
    // A thrown network call can have committed remotely. Preserve ambiguity.
    try {
      await env.AZRAIL_D1.prepare("UPDATE mission_checkpoints SET status='uncertain',result_json=?,updated_at=? WHERE mission_id=? AND step=?").bind(JSON.stringify({error:err instanceof Error?err.message:String(err)}),Date.now(),mission,step).run();
    } finally {
      // If D1 itself failed, the existing 'running' row also blocks recovery.
      throw new UncertainToolError(err);
    }
  }
}
export async function loadCheckpoints(env:Env,mission:string) {
  return (await env.AZRAIL_D1.prepare("SELECT step,tool,input_json,result_json,status FROM mission_checkpoints WHERE mission_id=? ORDER BY step").bind(mission).all<{step:number;tool:string;input_json:string;result_json:string|null;status:string}>()).results;
}
