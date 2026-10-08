import type {Env} from '../types';
import {AccessError,hashToken} from '../lib/accounts';
import {cookies,trustedOrigin} from './oidc';
import {findPolicy,type ConnectorPolicy} from './connector-policy';
import {seal,unseal,canonical} from './connector-vault';
const cookieName='__Host-pulse-connector';
const cookie=(value:string,age:number)=>`${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const random=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
export async function startConnectorOAuth(request:Request,env:Env,account:string,endpointKey:string) {
 if(!trustedOrigin(request,env))throw new AccessError('Домен не разрешён.');
 const count=await env.AZRAIL_D1.prepare('SELECT COUNT(*) AS n FROM connector_connections WHERE account_id=? AND disabled=0').bind(account).first<{n:number}>();if((count?.n??0)>=30)throw new AccessError('Лимит: 30 подключений на аккаунт.',429);
 const p=findPolicy(env,endpointKey);if(p.auth!=='oauth'||!p.oauth)throw new AccessError('OAuth сервиса не настроен.',400);
 const state=random(),verifier=random(),origin=new URL(request.url).origin,hash=await hashToken(state);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));const challenge=btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 await env.AZRAIL_D1.prepare('DELETE FROM connector_oauth_states WHERE expires_at<?').bind(Date.now()).run();
 const created=await env.AZRAIL_D1.prepare('INSERT INTO connector_oauth_states SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM connector_oauth_states WHERE account_id=?)<20 RETURNING state_hash').bind(hash,account,p.id,origin,await hashToken(canonical(p)),await seal(env,`oauth:${account}:${hash}`,{verifier}),Date.now()+600000,account).first();
 if(!created)throw new AccessError('Слишком много незавершённых подключений. Повторите через 10 минут.',429);
 const target=new URL(p.oauth.authorizationUrl);target.search=new URLSearchParams({client_id:p.oauth.clientId,response_type:'code',redirect_uri:origin+'/api/connectors/oauth/callback',scope:p.oauth.scopes.join(' '),resource:p.url,state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
 return Response.json({url:target.href},{headers:{'Set-Cookie':cookie(state,600)}});
}
export async function finishConnectorOAuth(request:Request,env:Env,account:string) {
 const url=new URL(request.url),state=url.searchParams.get('state')??'',code=url.searchParams.get('code');
 if(!trustedOrigin(request,env)||!code||code.length>4096||! /^[a-f0-9]{64}$/.test(state)||state!==cookies(request)[cookieName])throw new AccessError('Подключение не подтверждено этим браузером. Начните заново.',400);
 const hash=await hashToken(state);const row=await env.AZRAIL_D1.prepare('DELETE FROM connector_oauth_states WHERE state_hash=? AND account_id=? AND origin=? AND expires_at>? RETURNING *').bind(hash,account,url.origin,Date.now()).first<{endpoint_key:string;policy_digest:string;verifier_cipher:string}>();
 if(!row)throw new AccessError('Ссылка подключения истекла или уже использована.',400);
 const p=findPolicy(env,row.endpoint_key);if(!p.oauth||await hashToken(canonical(p))!==row.policy_digest)throw new AccessError('Настройки сервиса изменились. Начните подключение заново.',409);
 const pending=await unseal<{verifier:string}>(env,`oauth:${account}:${hash}`,row.verifier_cipher);
 const body=new URLSearchParams({grant_type:'authorization_code',client_id:p.oauth.clientId,code,redirect_uri:url.origin+'/api/connectors/oauth/callback',code_verifier:pending.verifier,resource:p.url});
 const token=await exchangeToken(env,p,body);
 const id=crypto.randomUUID(),now=Date.now();const cipher=await seal(env,`connector:${account}:${id}`,{...token,oauthPolicyDigest:row.policy_digest});
 const inserted=await env.AZRAIL_D1.prepare('INSERT INTO connector_connections(id,account_id,endpoint_key,label,secret_cipher,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM connector_connections WHERE account_id=? AND disabled=0)<30 RETURNING id').bind(id,account,p.id,p.name,cipher,now,now,account).first();
 if(!inserted)throw new AccessError('Лимит: 30 подключений на аккаунт. Отключите ненужный сервис и повторите вход.',429);
 return new Response(null,{status:303,headers:{Location:'/?connected=1','Set-Cookie':cookie('',0)}});
}

interface ConnectorSecret {token:string;expiresAt?:number;refreshToken?:string;oauthPolicyDigest?:string}
async function exchangeToken(env:Env,p:ConnectorPolicy,body:URLSearchParams):Promise<ConnectorSecret> {
 if(!p.oauth)throw new AccessError('OAuth сервиса не настроен.',503);
 let secrets:Record<string,string>;try{secrets=JSON.parse(env.MCP_OAUTH_SECRETS??'{}');if(!secrets||Array.isArray(secrets)||typeof secrets!=='object'||Object.values(secrets).some(v=>typeof v!=='string'||v.length>8192))throw new Error();}catch{throw new AccessError('OAuth секреты настроены неверно.',503);}if(secrets[p.id])body.set('client_secret',secrets[p.id]);
 const response=await fetch(p.oauth.tokenUrl,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok){await response.body?.cancel();throw new AccessError('Сервис отклонил подключение. Повторите вход.',401);}
 if(!response.body)throw new AccessError('Пустой ответ сервиса.',502);
 const reader=response.body.getReader();let bytes=0,text='';const decoder=new TextDecoder();try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>24000)throw new AccessError('Ответ авторизации превышает лимит.',502);text+=decoder.decode(r.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
 let token:{access_token?:string;token_type?:string;expires_in?:number;refresh_token?:string};try{token=JSON.parse(text);}catch{throw new AccessError('Некорректный ответ авторизации.',502);}
 if(!token||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192||/[\r\n]/.test(token.access_token)||typeof token.token_type!=='string'||token.token_type.toLowerCase()!=='bearer')throw new AccessError('Неподдерживаемый ответ авторизации.',502);
 if(token.refresh_token!==undefined&&(typeof token.refresh_token!=='string'||!token.refresh_token||token.refresh_token.length>8192||/[\r\n]/.test(token.refresh_token)))throw new AccessError('Некорректный refresh token.',502);
 const lifetime=Number(token.expires_in??3600);if(!Number.isFinite(lifetime)||lifetime<=0)throw new AccessError('Токен сервиса истёк.',401);
 return {token:token.access_token,expiresAt:Date.now()+Math.min(lifetime,31536000)*1000,...(token.refresh_token?{refreshToken:token.refresh_token}:{})};
}

/** Refresh-token rotation is claimed durably before contacting the issuer.
 * A crash or uncertain response requires reconnecting; it never replays a
 * possibly consumed refresh token. Credentials remain encrypted in D1. */
export async function connectorAccessToken(env:Env,c:{id:string;account_id:string;secret_cipher:string;revision:number},p:ConnectorPolicy):Promise<string> {
 const binding=`connector:${c.account_id}:${c.id}`;
 const secret=await unseal<ConnectorSecret>(env,binding,c.secret_cipher);
 if(!secret.expiresAt||secret.expiresAt>Date.now())return secret.token;
 if(p.auth!=='oauth'||!p.oauth||!secret.refreshToken)throw new AccessError('Токен сервиса истёк. Подключите сервис заново.',401);
 if(secret.oauthPolicyDigest!==await hashToken(canonical(p)))throw new AccessError('Настройки OAuth изменились. Подключите сервис заново.',409);
 const attempt=crypto.randomUUID();
 const claimed=await env.AZRAIL_D1.prepare(`INSERT INTO connector_oauth_refresh(connection_id,attempt_id,status,started_at)
 SELECT ?,?,'refreshing',? WHERE EXISTS(SELECT 1 FROM connector_connections WHERE id=? AND account_id=? AND revision=? AND secret_cipher=? AND disabled=0)
 ON CONFLICT DO NOTHING RETURNING attempt_id`).bind(c.id,attempt,Date.now(),c.id,c.account_id,c.revision,c.secret_cipher).first();
 if(!claimed){
  const current=await env.AZRAIL_D1.prepare('SELECT secret_cipher FROM connector_connections WHERE id=? AND account_id=? AND revision=? AND disabled=0').bind(c.id,c.account_id,c.revision).first<{secret_cipher:string}>();
  if(current&&current.secret_cipher!==c.secret_cipher){const updated=await unseal<ConnectorSecret>(env,binding,current.secret_cipher);if(updated.expiresAt&&updated.expiresAt>Date.now())return updated.token;}
  throw new AccessError('Обновление доступа выполняется или было прервано. Повторите позже; после прерывания подключите сервис заново.',409);
 }
 try{
  const body=new URLSearchParams({grant_type:'refresh_token',client_id:p.oauth.clientId,refresh_token:secret.refreshToken,resource:p.url});
  const updated=await exchangeToken(env,p,body);
  const cipher=await seal(env,binding,{...updated,refreshToken:updated.refreshToken??secret.refreshToken,oauthPolicyDigest:secret.oauthPolicyDigest});
  const saved=await env.AZRAIL_D1.prepare('UPDATE connector_connections SET secret_cipher=?,updated_at=? WHERE id=? AND account_id=? AND revision=? AND secret_cipher=? AND disabled=0 RETURNING id').bind(cipher,Date.now(),c.id,c.account_id,c.revision,c.secret_cipher).first();
  if(!saved)throw new AccessError('Подключение изменено во время обновления доступа.',409);
  await env.AZRAIL_D1.prepare('DELETE FROM connector_oauth_refresh WHERE connection_id=? AND attempt_id=?').bind(c.id,attempt).run();
  return updated.token;
 }catch{
  await env.AZRAIL_D1.prepare("UPDATE connector_oauth_refresh SET status='reconnect_required' WHERE connection_id=? AND attempt_id=?").bind(c.id,attempt).run();
  throw new AccessError('Не удалось надёжно обновить доступ. Подключите сервис заново; повтор refresh token заблокирован.',401);
 }
}
