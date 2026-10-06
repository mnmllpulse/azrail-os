import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../types';
import { hashToken, type Principal } from '../lib/accounts';

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const cookieName = '__Host-pulse-session';
export function cookies(request: Request): Record<string,string> {
 return Object.fromEntries((request.headers.get('Cookie') ?? '').split(';').map(p => p.trim().split('=').slice(0,2)).filter(p=>p.length===2));
}
function cookie(name:string,value:string,seconds:number) {
 return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}
function random() { return crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''); }
export function trustedOrigin(request:Request,env:Env) {
 const origin=new URL(request.url).origin;
 return (env.PUBLIC_ORIGINS ?? '').split(',').map(s=>s.trim()).includes(origin);
}
async function metadata(env:Env) {
 if(!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) throw new Error('OIDC не настроен: нужны issuer и client ID.');
 const issuer=env.OIDC_ISSUER.replace(/\/$/,'');
 if(new URL(issuer).protocol!=='https:') throw new Error('OIDC issuer должен использовать HTTPS.');
 const r=await fetch(`${issuer}/.well-known/openid-configuration`,{signal:AbortSignal.timeout(8000)});
 if(!r.ok) throw new Error('OIDC discovery недоступен.');
 const d=await r.json() as Record<string,string>;
 if(d.issuer!==env.OIDC_ISSUER && d.issuer!==issuer) throw new Error('OIDC issuer mismatch.');
 for(const key of ['authorization_endpoint','token_endpoint','jwks_uri']) if(new URL(d[key]).protocol!=='https:') throw new Error('Небезопасный OIDC endpoint.');
 return d;
}
export async function sessionPrincipal(request:Request,env:Env):Promise<Principal|null> {
 const token=cookies(request)[cookieName];
 if(!token || !/^[a-f0-9]{64}$/.test(token)) return null;
 const row=await env.AZRAIL_D1.prepare(`SELECT a.id,a.name,a.role FROM web_sessions s JOIN access_accounts a ON a.id=s.account_id
 WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND a.expires_at>? AND a.disabled=0`)
 .bind(await hashToken(token),new URL(request.url).origin,Date.now(),Date.now()).first<Principal>();
 if(!row)return null;
 // Preserve a server-side downgrade. A legacy admin role must not grant global
 // access through the public OIDC application.
 if(!['viewer','editor','admin'].includes(row.role))return null;
 const role=row.role==='viewer'?'viewer':'editor';
 return {...row,role,operator:role!=='viewer'&&(env.OPERATOR_ACCOUNT_IDS??'').split(',').map(s=>s.trim()).includes(row.id)};
}
export async function authRoute(request:Request,env:Env):Promise<Response|null> {
 const url=new URL(request.url);
 if(!url.pathname.startsWith('/auth/'))return null;
 const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
 if(!trustedOrigin(request,env))return reply({error:'Домен не разрешён в PUBLIC_ORIGINS.'},403);
 if(url.pathname==='/auth/status')return reply({configured:!!env.OIDC_ISSUER&&!!env.OIDC_CLIENT_ID,account:await sessionPrincipal(request,env)});
 if(url.pathname==='/auth/logout' && request.method==='POST') {
  if(request.headers.get('Origin')!==url.origin)return reply({error:'Origin mismatch'},403);
  await env.AZRAIL_D1.prepare('DELETE FROM web_sessions WHERE token_hash=?').bind(await hashToken(cookies(request)[cookieName]??'')).run();
  return new Response(null,{status:204,headers:{'Set-Cookie':cookie(cookieName,'',0)}});
 }
 if(request.method!=='GET')return reply({error:'Method not allowed'},405);
 try {
  if(url.pathname==='/auth/callback' && (!url.searchParams.get('code') || !url.searchParams.get('state') || url.searchParams.get('state')!==cookies(request)['__Host-pulse-state']))return reply({error:'Недействительный вход. Начните заново.'},400);
  const d=await metadata(env), redirectURI=`${url.origin}/auth/callback`;
  if(url.pathname==='/auth/login') {
   const state=random(),verifier=random(),nonce=random();
   const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
   const challenge=btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
   await env.AZRAIL_D1.prepare('DELETE FROM oidc_states WHERE expires_at<?').bind(Date.now()).run();
   await env.AZRAIL_D1.prepare('INSERT INTO oidc_states VALUES(?,?,?,?,?)').bind(await hashToken(state),verifier,nonce,url.origin,Date.now()+600000).run();
   const target=new URL(d.authorization_endpoint);
   target.search=new URLSearchParams({client_id:env.OIDC_CLIENT_ID!,redirect_uri:redirectURI,response_type:'code',scope:'openid profile email',state,nonce,code_challenge:challenge,code_challenge_method:'S256'}).toString();
   return new Response(null,{status:302,headers:{Location:target.href,'Set-Cookie':cookie('__Host-pulse-state',state,600),'Cache-Control':'no-store'}});
  }
  if(url.pathname==='/auth/callback') {
   const state=url.searchParams.get('state')??'',code=url.searchParams.get('code');
   if(!state || state!==cookies(request)['__Host-pulse-state'] || !code)return reply({error:'Недействительный вход. Начните заново.'},400);
   const pending=await env.AZRAIL_D1.prepare('DELETE FROM oidc_states WHERE state_hash=? AND origin=? AND expires_at>? RETURNING verifier,nonce')
   .bind(await hashToken(state),url.origin,Date.now()).first<{verifier:string;nonce:string}>();
   if(!pending)return reply({error:'Ссылка входа истекла или уже использована.'},400);
   const form=new URLSearchParams({grant_type:'authorization_code',client_id:env.OIDC_CLIENT_ID!,code,redirect_uri:redirectURI,code_verifier:pending.verifier});
   // client_secret_post; configure this method on the IdP. Public clients use PKCE only.
   if(env.OIDC_CLIENT_SECRET)form.set('client_secret',env.OIDC_CLIENT_SECRET);
   const tr=await fetch(d.token_endpoint,{method:'POST',body:form,signal:AbortSignal.timeout(10000)});
   if(!tr.ok)return reply({error:'Провайдер отклонил вход.'},401);
   const tokens=await tr.json() as {id_token?:string};
   if(!tokens.id_token)return reply({error:'Провайдер не вернул ID token.'},401);
   if(!jwks.has(d.jwks_uri))jwks.set(d.jwks_uri,createRemoteJWKSet(new URL(d.jwks_uri),{timeoutDuration:8000}));
   const {payload}=await jwtVerify(tokens.id_token,jwks.get(d.jwks_uri)!,{issuer:d.issuer,audience:env.OIDC_CLIENT_ID,algorithms:['RS256','ES256'],requiredClaims:['exp','iat','sub','nonce'],maxTokenAge:'10m'});
   if(payload.nonce!==pending.nonce || typeof payload.sub!=='string' || (payload.azp!==undefined && payload.azp!==env.OIDC_CLIENT_ID) || (Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==env.OIDC_CLIENT_ID))return reply({error:'OIDC nonce mismatch.'},401);
   const id=`oidc_${(await hashToken(`${d.issuer}\n${payload.sub}`)).slice(0,48)}`;
   const name=String(payload.name??payload.preferred_username??'Пользователь').slice(0,100);
   // Random unusable API key hash: OIDC identities never get a shared owner key.
   await env.AZRAIL_D1.prepare(`INSERT INTO access_accounts(id,name,role,token_hash,expires_at) VALUES(?,?,'editor',?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,expires_at=excluded.expires_at`)
    .bind(id,name,await hashToken(random()),Date.now()+365*86400000).run();
   const account=await env.AZRAIL_D1.prepare('SELECT disabled FROM access_accounts WHERE id=?').bind(id).first<{disabled:number}>();
   if(account?.disabled)return reply({error:'Аккаунт отключён.'},403);
   const session=random();
   await env.AZRAIL_D1.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').bind(await hashToken(session),id,url.origin,Date.now()+12*3600000).run();
   const headers=new Headers({Location:'/', 'Cache-Control':'no-store'});
   headers.append('Set-Cookie',cookie(cookieName,session,43200));headers.append('Set-Cookie',cookie('__Host-pulse-state','',0));
   return new Response(null,{status:302,headers});
  }
  return reply({error:'Not found'},404);
 } catch { return reply({error:'Вход не завершён. Проверьте OIDC issuer, client и разрешённые callback URL.'},503); }
}
