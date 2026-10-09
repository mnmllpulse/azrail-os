import type { Env } from '../types';
import { authenticate, AccessError, requireResource } from '../lib/accounts';
import {exportProjectZip} from './project-export';
import {readJsonRecord} from './request-json';
import { readBoundedBody } from '../lib/request-body';
import { parseALSBuffer } from './music';
import { accountCall } from './ledger';
import {draftRoute} from './drafts';
import {designRoute} from './design-contract';
import {artifactProject,deleteArtifact,linkArtifact,listArtifacts,readArtifact,saveArtifact,storageUsage,MAX_ARTIFACT_BYTES,reserveArtifactStorage,releaseEmptyArtifactReservation} from './artifacts';

const json=Response.json;
export async function studioRoute(request:Request,env:Env,onProviderDispatch?:()=>void):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname;
 if(!path.startsWith('/api/studio/'))return null;
 const auth=await authenticate(request,env);
 if(!auth.ok)return json({error:auth.error},{status:401});
 const account=auth.principal!.id;
 if(auth.principal!.role==='viewer'&&request.method!=='GET')throw new AccessError('Только чтение');
 if(path==='/api/studio/design-contract')return designRoute(request,env,auth.principal!);
 if(path.startsWith('/api/studio/drafts/'))return draftRoute(request,env,account);
 if(path==='/api/studio/projects'&&request.method==='GET')return json({projects:(await env.AZRAIL_D1.prepare(`SELECT o.resource_id AS id,
  (SELECT id FROM missions WHERE project_id=o.resource_id ORDER BY created_at DESC LIMIT 1) AS mission_id,
  (SELECT goal FROM missions WHERE project_id=o.resource_id ORDER BY created_at DESC LIMIT 1) AS title
  FROM resource_owners o WHERE o.kind='project' AND o.account_id=? ORDER BY o.rowid DESC LIMIT 100`).bind(account).all()).results});
 if(path==='/api/studio/project-zip'&&request.method==='GET') {
  const project=url.searchParams.get('projectId')??'';await requireResource(env,auth.principal!,'project',project);
  return exportProjectZip(env,project);
 }
 if(path==='/api/studio/capabilities')return json({
  image:!!env.AI,voice:!!env.AI,music:'local-wav-midi',video:'local-webm',als:true,
  sandbox:!!env.AZRAIL_SANDBOX,auth:'oidc',ledger:true,providerCosts:'See Cloudflare account; request ledger is not a Neuron meter',
 });
 if(path==='/api/studio/artifacts'&&request.method==='GET') {
  const value=url.searchParams.get('projectId');
  const project=value===null?undefined:value===''?null:await artifactProject(env,account,value);
  return json({artifacts:await listArtifacts(env,account,project)});
 }
 if(path==='/api/studio/storage'&&request.method==='GET')return json(await storageUsage(env,account));
 const match=path.match(/^\/api\/studio\/artifacts\/([a-f0-9-]{36})$/);
 if(match&&request.method==='GET') {
  const row=await readArtifact(env,account,match[1]);
  if(!row)return json({error:'Файл не найден'},{status:404});
  const file=await env.AZRAIL_R2.get(row.r2_key);if(!file)return json({error:'Объект отсутствует в R2'},{status:404});
  return new Response(file.body,{headers:{'Content-Type':row.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(match&&request.method==='PATCH') {
  const body=await readJsonRecord(request,2048);
  if(!Object.hasOwn(body,'projectId'))throw new AccessError('Укажите projectId или null.',400);
  const projectId=await artifactProject(env,account,body.projectId);
  return json(await linkArtifact(env,account,match[1],projectId));
 }
 if(match&&request.method==='DELETE')return json(await deleteArtifact(env,account,match[1]));
 if(path==='/api/studio/ledger'&&request.method==='GET') {
  const limits=await env.AZRAIL_D1.prepare("SELECT * FROM resource_budgets WHERE scope=?").bind(`platform:${new Date().toISOString().slice(0,10)}`).all();
  const models=await env.AZRAIL_D1.prepare(`SELECT c.model,c.status,c.actual_micro_usd,c.reserved_micro_usd,c.started_at
   FROM model_calls c WHERE c.scope IN (SELECT 'mission:'||m.id FROM missions m JOIN resource_owners o ON o.resource_id=m.project_id AND o.kind='project' WHERE o.account_id=?)
   OR c.scope IN (SELECT 'project:'||resource_id FROM resource_owners WHERE kind='project' AND account_id=?) ORDER BY c.started_at DESC LIMIT 100`).bind(account,account).all();
  return json({limits:limits.results,models:models.results,note:'Платформенный лимит запросов общий. Стоимость — только ваших проектов. Neurons и счёт Cloudflare сверяются отдельно.'});
 }
 if(request.method!=='POST')return json({error:'Маршрут не найден'},{status:404});
 if(path==='/api/studio/als')return json(await parseALSBuffer(await readBoundedBody(request,8*1024*1024)));
 if(path==='/api/studio/artifacts') {
  const projectId=await artifactProject(env,account,request.headers.get('X-Project-Id'));
  const bytes=await readBoundedBody(request,MAX_ARTIFACT_BYTES);
  const mime=request.headers.get('Content-Type')?.split(';')[0]??'application/octet-stream';
  let decoded:string;try{decoded=decodeURIComponent(request.headers.get('X-Filename')??'artifact.bin');}catch{throw new AccessError('Некорректная кодировка имени файла.',400);}
  const name=decoded.replace(/[\x00-\x1f/\\]/g,'_').slice(0,160).trim()||'artifact.bin';
  return json(await saveArtifact(env,account,name,mime,bytes,projectId,request.headers.get('Idempotency-Key')),{status:201});
 }
 if(path==='/api/studio/image') {
  const body=await readJsonRecord(request,20000);
  const prompt=typeof body.prompt==='string'?body.prompt.trim():'';if(!prompt||prompt.length>4000)return json({error:'Нужен запрос до 4 000 символов.'},{status:400});
  const projectId=await artifactProject(env,account,body.projectId);
  const storage=await reserveArtifactStorage(env,account,MAX_ARTIFACT_BYTES);
  let saving=false;
  try {
  const result=await accountCall(env,'@cf/black-forest-labs/flux-1-schnell',()=>{onProviderDispatch?.();return env.AI.run('@cf/black-forest-labs/flux-1-schnell',{prompt,steps:4});}) as {image?:string};
  if(typeof result?.image!=='string'||!result.image)throw new Error('Провайдер не вернул изображение');
  if(result.image.length>16*1024*1024)throw new Error('Ответ провайдера превышает лимит');
  const bytes=Uint8Array.from(atob(result.image),c=>c.charCodeAt(0));
  if(bytes.length>12*1024*1024)throw new Error('Ответ провайдера превышает лимит');
  // Verify a supported binary signature before labelling arbitrary bytes as media.
  // This is format detection, not a complete image decoder.
  const jpeg=bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const png=bytes.length>=33&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  const webp=bytes.length>=16&&new TextDecoder().decode(bytes.subarray(0,4))==='RIFF'&&new TextDecoder().decode(bytes.subarray(8,12))==='WEBP';
  if(!jpeg&&!png&&!webp)throw new Error('Провайдер вернул неизвестный формат изображения');
  const extension=jpeg?'jpg':png?'png':'webp',mime=jpeg?'image/jpeg':png?'image/png':'image/webp';
  saving=true;
  return json(await saveArtifact(env,account,`pulse-${crypto.randomUUID()}.${extension}`,mime,bytes,projectId,null,storage),{status:201});
  } catch(error) {
   if(!saving)await releaseEmptyArtifactReservation(env,storage);
   throw error;
  }
 }
 if(path==='/api/studio/voice') {
  const bytes=await readBoundedBody(request,4*1024*1024);
  if(!bytes.length)return json({error:'Аудиозапись пуста'},{status:400});
  const result=await accountCall(env,'@cf/openai/whisper',()=>{onProviderDispatch?.();return env.AI.run('@cf/openai/whisper',{audio:[...bytes]});});
  return json(result);
 }
 return json({error:'Маршрут не найден'},{status:404});
}
