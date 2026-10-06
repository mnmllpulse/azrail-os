import type { Env } from "../types";
import { extractUsage } from "./usage";

interface MeterOptions {
  /** Runs after reservation but before any provider request. A rejection releases it. */
  beforeInvoke?:()=>Promise<void>;
  additionalBudgetScopes?:string[];
  policyRevision?:number;
}
export async function meteredCall<T>(env:Env,model:string,input:unknown,scope:string,invoke:()=>Promise<T>,budgetScope=scope,options:MeterOptions={}):Promise<T> {
  if(!env.AZRAIL_METERING) {await options.beforeInvoke?.();return invoke();}
  const id=crypto.randomUUID(),started=Date.now(),strict=env.AZRAIL_METERING==="enforce";
  const price=await env.AZRAIL_D1.prepare("SELECT input_micro_usd_per_million AS i,output_micro_usd_per_million AS o FROM model_prices WHERE model=?")
    .bind(model).first<{i:number;o:number}>();
  if(strict && (!price || ![price.i,price.o].every(n=>Number.isSafeInteger(n)&&n>=0)))throw new Error(`Нет проверенного тарифа модели ${model}. Вызов заблокирован.`);
  const data=input&&typeof input==="object"?input as Record<string,unknown>:{};
  const generatesText=Array.isArray(data.messages)||typeof data.prompt==='string'||data.max_tokens!==undefined;
  const requested=Number(data.max_tokens);
  const outputCap=generatesText?(Number.isFinite(requested)&&requested>0?Math.min(32768,Math.floor(requested)):4096):0;
  // Embedding/image/audio inputs must not receive a text-generation parameter.
  if(generatesText)data.max_tokens=outputCap;
  const inputCap=new TextEncoder().encode(JSON.stringify(input)).byteLength;
  const reserved=price?Math.ceil((inputCap*price.i+outputCap*price.o)/1_000_000):0;
  if(!Number.isSafeInteger(reserved)||reserved<0)throw new Error("Некорректная оценка стоимости.");
  const scopes=[...new Set([budgetScope,...options.additionalBudgetScopes??[]])];
  const placeholders=scopes.map(()=>'?').join(',');
  if(strict){
    // Call record and ALL budgets are committed together. Failed logging cannot leak a reservation.
    const revisionClause=options.policyRevision===undefined?'':" AND EXISTS(SELECT 1 FROM model_routing_settings WHERE id=1 AND allow_third_party=1 AND revision=?)";
    const insert=env.AZRAIL_D1.prepare(`INSERT INTO model_calls(id,scope,model,status,started_at,reserved_micro_usd)
      SELECT ?,?,?,'running',?,? WHERE (SELECT COUNT(*) FROM spend_limits
        WHERE scope IN (${placeholders}) AND spent_micro_usd+?<=limit_micro_usd)=?${revisionClause} RETURNING id`)
      .bind(id,scope,model,started,reserved,...scopes,reserved,scopes.length,...(options.policyRevision===undefined?[]:[options.policyRevision]));
    const result=await env.AZRAIL_D1.batch([
      insert,
      env.AZRAIL_D1.prepare(`UPDATE spend_limits SET spent_micro_usd=spent_micro_usd+?
        WHERE scope IN (${placeholders}) AND EXISTS(SELECT 1 FROM model_calls WHERE id=?)`).bind(reserved,...scopes,id),
    ]);
    if(!result[0].results?.length)throw new Error("Денежный бюджет отсутствует, исчерпан или настройки оплаты изменились.");
  }else{
    await env.AZRAIL_D1.prepare("INSERT INTO model_calls(id,scope,model,status,started_at,reserved_micro_usd) VALUES(?,?,?,'running',?,?)")
      .bind(id,scope,model,started,reserved).run();
  }
  try{await options.beforeInvoke?.();}
  catch(err){
    const statements=[env.AZRAIL_D1.prepare("UPDATE model_calls SET status='cancelled',finished_at=?,error='not sent' WHERE id=?").bind(Date.now(),id)];
    if(strict)statements.push(env.AZRAIL_D1.prepare(`UPDATE spend_limits SET spent_micro_usd=MAX(0,spent_micro_usd-?) WHERE scope IN (${placeholders})`).bind(reserved,...scopes));
    await env.AZRAIL_D1.batch(statements);throw err;
  }
  let result:T;
  try{result=await invoke();}
  catch(err){
    await env.AZRAIL_D1.prepare("UPDATE model_calls SET status='uncertain',finished_at=?,error='provider failure; reservation retained' WHERE id=?").bind(Date.now(),id).run();throw err;
  }
  const usage=extractUsage(result),rawUsage=(result as {usage?:Record<string,unknown>}|null)?.usage;
  const validCount=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  const complete=rawUsage&&validCount(rawUsage.prompt_tokens??rawUsage.input_tokens)&&validCount(rawUsage.completion_tokens??rawUsage.output_tokens);
  const actual=price&&usage&&complete?Math.ceil((usage.promptTokens*price.i+usage.completionTokens*price.o)/1_000_000):null;
  const statements=[env.AZRAIL_D1.prepare("UPDATE model_calls SET status=?,finished_at=?,prompt_tokens=?,completion_tokens=?,actual_micro_usd=? WHERE id=?")
    .bind(actual===null?'unpriced':'completed',Date.now(),usage?.promptTokens??null,usage?.completionTokens??null,actual,id)];
  if(strict&&actual!==null)statements.push(env.AZRAIL_D1.prepare(`UPDATE spend_limits SET spent_micro_usd=MAX(0,spent_micro_usd+?) WHERE scope IN (${placeholders})`).bind(actual-reserved,...scopes));
  await env.AZRAIL_D1.batch(statements);return result;
}
export async function initializeMissionBudget(env:Env,mission:string):Promise<void> {
  const usd=Number(env.AZRAIL_MISSION_BUDGET_USD??"1");
  if(!Number.isFinite(usd)||usd<=0||usd>1000)throw new Error("Некорректный бюджет миссии.");
  await env.AZRAIL_D1.prepare("INSERT OR IGNORE INTO spend_limits(scope,limit_micro_usd) VALUES(?,?)").bind(`mission:${mission}`,Math.floor(usd*1_000_000)).run();
}
