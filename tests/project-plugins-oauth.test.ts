import {afterEach,describe,expect,it,vi} from 'vitest';
import {sqliteD1} from './stubs/sqlite-d1';
import {hashToken} from '../src/lib/accounts';
import {canonical,seal,unseal} from '../src/unified/connector-vault';
import {connectorAccessToken} from '../src/unified/connector-oauth';
import {findPolicy} from '../src/unified/connector-policy';
import type {Env} from '../src/types';

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
async function fixture(refresh=true){
 const{db,sqlite}=sqliteD1();
 const config={id:'design',name:'Design',url:'https://mcp.example.com/mcp',auth:'oauth',readTools:[],blockedTools:[],dailyCalls:10,oauth:{clientId:'registered-client',authorizationUrl:'https://auth.example.com/authorize',tokenUrl:'https://auth.example.com/token',scopes:['files:read']}};
 const env={AZRAIL_D1:db,INTEGRATION_KEY:btoa('k'.repeat(32)),MCP_SERVERS:JSON.stringify([config]),MCP_OAUTH_SECRETS:JSON.stringify({design:'client-private-secret'})}as unknown as Env;
 const policy=findPolicy(env,'design'),binding='connector:alice:connection-1';
 const secret={token:'expired-token',expiresAt:Date.now()-1,oauthPolicyDigest:await hashToken(canonical(policy)),...(refresh?{refreshToken:'refresh-private-secret'}:{})};
 const c={id:'connection-1',account_id:'alice',secret_cipher:await seal(env,binding,secret),revision:1};
 sqlite.prepare('INSERT INTO connector_connections(id,account_id,endpoint_key,label,secret_cipher,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(c.id,c.account_id,'design','Design',c.secret_cipher,Date.now(),Date.now());
 const fetcher=vi.fn(async()=>Response.json({access_token:'new-access-token',refresh_token:'rotated-refresh-token',token_type:'Bearer',expires_in:3600}));vi.stubGlobal('fetch',fetcher);
 const stored=async()=>{const row=sqlite.prepare('SELECT secret_cipher FROM connector_connections WHERE id=?').get(c.id)as{secret_cipher:string};return unseal<Record<string,unknown>>(env,binding,row.secret_cipher);};
 return{env,sqlite,c,policy,fetcher,stored};
}

describe('Durable connector OAuth refresh',()=>{
 it('rotates encrypted access/refresh tokens with bounded exact-issuer requests',async()=>{const f=await fixture();expect(await connectorAccessToken(f.env,f.c,f.policy)).toBe('new-access-token');const [url,init]=f.fetcher.mock.calls[0]as unknown as[string,RequestInit];expect(url).toBe('https://auth.example.com/token');expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);const form=init.body as URLSearchParams;expect(form.get('grant_type')).toBe('refresh_token');expect(form.get('resource')).toBe('https://mcp.example.com/mcp');expect(form.get('client_secret')).toBe('client-private-secret');expect(form.get('refresh_token')).toBe('refresh-private-secret');const stored=await f.stored();expect(stored.refreshToken).toBe('rotated-refresh-token');expect(stored.token).toBe('new-access-token');expect(f.sqlite.prepare('SELECT secret_cipher FROM connector_connections').get()?.secret_cipher).not.toContain('rotated-refresh-token');expect(f.sqlite.prepare('SELECT COUNT(*) n FROM connector_oauth_refresh').get()?.n).toBe(0);});
 it('admits only one concurrent refresh and reuses its durable token for stale callers',async()=>{const f=await fixture();const results=await Promise.allSettled([connectorAccessToken(f.env,f.c,f.policy),connectorAccessToken(f.env,f.c,f.policy)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.fetcher).toHaveBeenCalledTimes(1);expect(await connectorAccessToken(f.env,f.c,f.policy)).toBe('new-access-token');expect(f.fetcher).toHaveBeenCalledTimes(1);});
 it('never retries a refresh with an uncertain remote outcome',async()=>{const f=await fixture();f.fetcher.mockImplementation(async()=>{throw new Error('connection lost after rotation');});await expect(connectorAccessToken(f.env,f.c,f.policy)).rejects.toThrow('повтор refresh token заблокирован');await expect(connectorAccessToken(f.env,f.c,f.policy)).rejects.toThrow('прервано');expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.sqlite.prepare('SELECT status FROM connector_oauth_refresh').get()?.status).toBe('reconnect_required');});
 it('does not send old refresh secrets after operator policy changes',async()=>{const f=await fixture();await expect(connectorAccessToken(f.env,f.c,{...f.policy,dailyCalls:9})).rejects.toThrow('Настройки OAuth изменились');expect(f.fetcher).not.toHaveBeenCalled();});
 it('does not restore credentials when connection was revoked during refresh',async()=>{const f=await fixture();f.fetcher.mockImplementationOnce(async()=>{f.sqlite.exec("UPDATE connector_connections SET disabled=1,secret_cipher='',revision=revision+1");return Response.json({access_token:'new-token',token_type:'Bearer',expires_in:3600});});await expect(connectorAccessToken(f.env,f.c,f.policy)).rejects.toThrow('обновить доступ');expect(f.sqlite.prepare('SELECT secret_cipher FROM connector_connections').get()?.secret_cipher).toBe('');});
 it('retains the existing refresh token when issuer does not rotate it',async()=>{const f=await fixture();f.fetcher.mockImplementationOnce(async()=>Response.json({access_token:'new-token',token_type:'Bearer',expires_in:3600}));await connectorAccessToken(f.env,f.c,f.policy);expect((await f.stored()).refreshToken).toBe('refresh-private-secret');});
 it('requires reconnect without a refresh token and makes no hidden request',async()=>{const f=await fixture(false);await expect(connectorAccessToken(f.env,f.c,f.policy)).rejects.toThrow('истёк');expect(f.fetcher).not.toHaveBeenCalled();});
 it('rejects oversized token responses without replay',async()=>{const f=await fixture();f.fetcher.mockImplementationOnce(async()=>new Response('x'.repeat(24001)));await expect(connectorAccessToken(f.env,f.c,f.policy)).rejects.toThrow('обновить доступ');await expect(connectorAccessToken(f.env,f.c,f.policy)).rejects.toThrow('прервано');expect(f.fetcher).toHaveBeenCalledTimes(1);});
});
