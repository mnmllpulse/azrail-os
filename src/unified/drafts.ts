import type {Env} from '../types';
import {AccessError} from '../lib/accounts';
import {readJsonRecord} from './request-json';
import {artifactProject} from './artifacts';
const fields:Record<string,Record<string,number>>={image:{'studio-text':4000},music:{'studio-text':4000,bpm:32,bars:32},video:{'studio-text':90}};
export async function draftRoute(request:Request,env:Env,account:string):Promise<Response> {
 const url=new URL(request.url),id=url.pathname.split('/').at(-1)!;
 if(!Object.hasOwn(fields,id))return Response.json({error:'Студия не поддерживает текстовые черновики.'},{status:404});
 const projectId=await artifactProject(env,account,url.searchParams.get('projectId'));
 const table=projectId?'project_studio_drafts':'studio_drafts';
 const scope=projectId?'account_id=? AND project_id=? AND studio_id=?':'account_id=? AND studio_id=?';
 const args=projectId?[account,projectId,id]:[account,id];
 if(request.method==='GET') {
  const row=await env.AZRAIL_D1.prepare(`SELECT revision,values_json,updated_at FROM ${table} WHERE ${scope}`).bind(...args).first<{revision:number;values_json:string;updated_at:number}>();
  return Response.json({projectId,revision:row?.revision??0,values:row?JSON.parse(row.values_json):{},updatedAt:row?.updated_at??null});
 }
 if(request.method!=='PUT')return Response.json({error:'Метод недоступен'},{status:405});
 const body=await readJsonRecord(request,20000) as {baseRevision:number;values:Record<string,unknown>};
 if(!Number.isSafeInteger(body.baseRevision)||body.baseRevision<0||!body.values||Array.isArray(body.values)||typeof body.values!=='object')throw new AccessError('Некорректный черновик.',400);
 for(const [key,value]of Object.entries(body.values))if(!Object.hasOwn(fields[id],key)||typeof value!=='string'||value.length>fields[id][key])throw new AccessError('Недопустимое поле черновика.',400);
 const json=JSON.stringify(body.values),now=Date.now();
 const row=body.baseRevision===0
 ?await env.AZRAIL_D1.prepare(`INSERT INTO ${table} (${projectId?'account_id,project_id,studio_id':'account_id,studio_id'},revision,values_json,updated_at) VALUES(${args.map(()=>'?').join(',')},1,?,?) ON CONFLICT DO NOTHING RETURNING revision`).bind(...args,json,now).first()
 :await env.AZRAIL_D1.prepare(`UPDATE ${table} SET values_json=?,updated_at=?,revision=revision+1 WHERE ${scope} AND revision=? RETURNING revision`).bind(json,now,...args,body.baseRevision).first();
 if(!row)return Response.json({error:'Черновик изменён в другой вкладке. Загрузите сохранённую версию перед следующей записью.'},{status:409});
 return Response.json({...row,projectId,updatedAt:now});
}
