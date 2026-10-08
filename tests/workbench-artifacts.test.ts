import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/core/azrail-sandbox',()=>({Sandbox:class{}}));
import worker from '../src/unified/entry';
import {sqliteD1} from './stubs/sqlite-d1';
import {createAccount,hashToken} from '../src/lib/accounts';
import {cleanupArtifactStorage,storageUsage} from '../src/unified/artifacts';
import type {Env} from '../src/types';

afterEach(()=>vi.restoreAllMocks());
async function fixture() {
 const {db,sqlite}=sqliteD1(),objects=new Map<string,Uint8Array>();
 const migration=readFileSync(new URL('../migrations/010-workbench-artifacts.sql',import.meta.url),'utf8');
 if(!sqlite.prepare("PRAGMA table_info('studio_artifacts')").all().some(c=>c.name==='project_id'))sqlite.exec('ALTER TABLE studio_artifacts ADD COLUMN project_id TEXT');
 sqlite.exec(migration);
 const put=vi.fn(async(key:string,value:Uint8Array)=>{objects.set(key,value);return {};}),del=vi.fn(async(key:string)=>{objects.delete(key);});
 const env={AZRAIL_D1:db,AUTH_MODE:'oidc',PUBLIC_ORIGINS:'https://app.test',UNIFIED_LEDGER:'true',DAILY_PROVIDER_CALLS:'5',
  AZRAIL_R2:{put,delete:del,get:vi.fn(async(key:string)=>objects.has(key)?{body:objects.get(key)}:null),list:vi.fn(async()=>({objects:[],truncated:false}))},
  AI:{run:vi.fn(async()=>({image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='}))}} as unknown as Env;
 const a=await createAccount(env,'Alice','editor'),b=await createAccount(env,'Bob','editor');
 for(const [token,account]of [['a',a.id],['b',b.id]])sqlite.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(await hashToken(token.repeat(64)),account,'https://app.test',Date.now()+3600000);
 for(const [id,account]of [['p1',a.id],['p2',a.id],['private',b.id]])sqlite.prepare('INSERT INTO resource_owners VALUES(?,?,?)').run('project',id,account);
 const request=(path:string,init:RequestInit={},token='a')=>worker.fetch(new Request('https://app.test'+path,{...init,headers:{Cookie:`__Host-pulse-session=${token.repeat(64)}`,Origin:'https://app.test',...init.headers}}),env,{} as ExecutionContext);
 const call=(path:string,body?:unknown,method=body===undefined?'GET':'POST',token='a')=>request(path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':'workbench-image-request'},body:body===undefined?undefined:JSON.stringify(body)},token);
 const upload=(bytes=new Uint8Array([1,2,3]),project?:string,key?:string,token='a')=>request('/api/studio/artifacts',{method:'POST',body:bytes,headers:{'X-Filename':'test.bin','Content-Type':'application/octet-stream',...(project===undefined?{}:{'X-Project-Id':project}),...(key?{'Idempotency-Key':key}:{})}},token);
 return {env,sqlite,objects,put,del,a,b,request,call,upload,migration};
}

describe('Project artifacts and storage accounting',()=>{
 it('scopes uploads and listings to owned projects while retaining unassigned files',async()=>{
  const f=await fixture(),a=await (await f.upload(undefined,'p1')).json() as any,b=await (await f.upload()).json() as any;
  expect(a.projectId).toBe('p1');expect(b.projectId).toBeNull();expect(a.url).toBe(`/api/studio/artifacts/${a.id}`);
  expect((await (await f.call('/api/studio/artifacts?projectId=p1')).json() as any).artifacts.map((x:any)=>x.id)).toEqual([a.id]);
  expect((await (await f.call('/api/studio/artifacts?projectId=')).json() as any).artifacts.map((x:any)=>x.id)).toEqual([b.id]);
  expect((await (await f.call('/api/studio/artifacts')).json() as any).artifacts).toHaveLength(2);
  expect((await f.call('/api/studio/artifacts?projectId=private')).status).toBe(404);
  expect((await f.upload(undefined,'private')).status).toBe(404);expect(f.put).toHaveBeenCalledTimes(2);
  expect((await f.call(`/api/studio/artifacts/${a.id}`,undefined,'GET','b')).status).toBe(404);
 });
 it('links an existing artifact without duplicating its object and rejects foreign assignment or ownership',async()=>{
  const f=await fixture(),a=await (await f.upload()).json() as any;
  for(let n=0;n<2;n++)expect((await (await f.call(a.url,{projectId:'p1'},'PATCH')).json() as any).projectId).toBe('p1');
  expect(f.put).toHaveBeenCalledTimes(1);expect(f.objects.size).toBe(1);
  expect((await f.call(a.url,{projectId:'private'},'PATCH')).status).toBe(404);
  expect((await f.call(a.url,{projectId:'private'},'PATCH','b')).status).toBe(404);
  expect((await f.call(a.url,{},'PATCH')).status).toBe(400);
  expect((await (await f.call(a.url,{projectId:null},'PATCH')).json() as any).projectId).toBeNull();
 });
 it('deletes idempotently and releases bytes and files only after R2 confirms deletion',async()=>{
  const f=await fixture(),a=await (await f.upload()).json() as any;
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:3,usedFiles:1,reservedBytes:0});
  f.del.mockRejectedValueOnce(Error('R2 unavailable'));
  expect((await f.call(a.url,undefined,'DELETE')).status).toBe(503);
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:0,reservedBytes:3,reservedFiles:1});
  expect((await f.call(a.url)).status).toBe(404);
  expect((await f.call(a.url,undefined,'DELETE','b')).status).toBe(404);
  expect((await f.call(a.url,undefined,'DELETE')).status).toBe(200);
  expect((await f.call(a.url,undefined,'DELETE')).status).toBe(200);
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:0,usedFiles:0,reservedBytes:0,reservedFiles:0});
  expect(f.objects.size).toBe(0);
 });
 it('reserves before R2 and admits only one concurrent upload within the byte/file limit',async()=>{
  const f=await fixture();f.env.STUDIO_STORAGE_MAX_BYTES='3';f.env.STUDIO_STORAGE_MAX_FILES='1';
  let finish!:()=>void,started!:()=>void;const began=new Promise<void>(r=>{started=r;});const wait=new Promise<void>(r=>{finish=r;});
  f.put.mockImplementationOnce(async(key,bytes)=>{started();await wait;f.objects.set(key,bytes);return {};});
  const first=f.upload();await began;
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({reservedBytes:3,reservedFiles:1,usedFiles:0});
  expect((await f.upload()).status).toBe(413);expect(f.put).toHaveBeenCalledTimes(1);
  finish();expect((await first).status).toBe(201);
  // Each account receives its own quota.
  expect((await f.upload(undefined,undefined,undefined,'b')).status).toBe(201);
 });
 it('enforces file count for empty uploads and honors lowered/zero limits immediately',async()=>{
  const f=await fixture();f.env.STUDIO_STORAGE_MAX_FILES='1';
  expect((await f.upload(new Uint8Array())).status).toBe(201);
  expect((await f.upload(new Uint8Array())).status).toBe(413);
  f.env.STUDIO_STORAGE_MAX_FILES='10';f.env.STUDIO_STORAGE_MAX_BYTES='0';
  expect((await f.upload()).status).toBe(413);
  f.env.STUDIO_STORAGE_MAX_BYTES='invalid';expect((await f.upload()).status).toBe(503);
  expect(f.put).toHaveBeenCalledTimes(1);
 });
 it('replays uploads with a stable request key and rejects changed content or project',async()=>{
  const f=await fixture(),key='upload-request-0001';
  const one=await (await f.upload(undefined,'p1',key)).json(),two=await (await f.upload(undefined,'p1',key)).json();expect(two).toEqual(one);
  expect((await f.upload(new Uint8Array([7]),'p1',key)).status).toBe(409);
  expect((await f.upload(undefined,'p2',key)).status).toBe(409);
  expect(f.put).toHaveBeenCalledTimes(1);expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:3,usedFiles:1});
 });
 it('blocks concurrent retries of the same upload key before a second object write',async()=>{
  const f=await fixture();let finish!:()=>void,started!:()=>void;const began=new Promise<void>(r=>{started=r;}),wait=new Promise<void>(r=>{finish=r;});
  f.put.mockImplementationOnce(async(key,bytes)=>{started();await wait;f.objects.set(key,bytes);return {};});
  const first=f.upload(undefined,'p1','upload-concurrent-0001');await began;
  expect((await f.upload(undefined,'p1','upload-concurrent-0001')).status).toBe(409);
  finish();expect((await first).status).toBe(201);expect(f.put).toHaveBeenCalledTimes(1);
 });
 it('does not age-reclaim uncertain R2 writes or run them again on retry',async()=>{
  const f=await fixture();f.put.mockRejectedValueOnce(Error('Unknown R2 outcome'));
  expect((await f.upload(undefined,'p1','upload-uncertain-0001')).status).toBe(503);
  f.sqlite.exec('UPDATE studio_storage_reservations SET updated_at=0');
  expect(await cleanupArtifactStorage(f.env)).toEqual({cleaned:0,failed:0});
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({reservedBytes:3,pendingFiles:1});
  expect((await f.upload(undefined,'p1','upload-uncertain-0001')).status).toBe(409);expect(f.put).toHaveBeenCalledTimes(1);
 });
 it('cleans up confirmed R2 writes when metadata commit fails; retries failed cleanup without double release',async()=>{
  const f=await fixture();const batch=f.env.AZRAIL_D1.batch.bind(f.env.AZRAIL_D1);
  vi.spyOn(f.env.AZRAIL_D1,'batch').mockRejectedValueOnce(Error('D1 unavailable')).mockImplementation(batch);
  f.del.mockRejectedValueOnce(Error('R2 delete unavailable'));
  expect((await f.upload()).status).toBe(503);expect(f.objects.size).toBe(1);
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({reservedBytes:3,reservedFiles:1});
  expect(await cleanupArtifactStorage(f.env)).toEqual({cleaned:1,failed:0});
  expect(await cleanupArtifactStorage(f.env)).toEqual({cleaned:0,failed:0});
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({reservedBytes:0,reservedFiles:0});expect(f.objects.size).toBe(0);
 });
 it('keeps the committed artifact if the D1 transaction response is lost',async()=>{
  const f=await fixture();const batch=f.env.AZRAIL_D1.batch.bind(f.env.AZRAIL_D1);
  vi.spyOn(f.env.AZRAIL_D1,'batch').mockImplementationOnce(async statements=>{await batch(statements);throw Error('Response lost');});
  expect((await f.upload()).status).toBe(201);expect(f.del).not.toHaveBeenCalled();expect(f.objects.size).toBe(1);
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:3,usedFiles:1,reservedFiles:0});
 });
 it('backfills legacy artifacts once without linking or losing them',async()=>{
  const f=await fixture(),id=crypto.randomUUID();
  f.sqlite.prepare('INSERT INTO studio_artifacts(id,account_id,name,mime,r2_key,bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(id,f.a.id,'legacy.txt','text/plain','legacy/key',15,1);
  f.sqlite.exec(f.migration);f.sqlite.exec(f.migration);
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:15,usedFiles:1});
  const rows=(await (await f.call('/api/studio/artifacts?projectId=')).json() as any).artifacts;expect(rows[0]).toMatchObject({id,projectId:null,bytes:15});
  f.env.STUDIO_STORAGE_MAX_BYTES='15';expect((await f.upload()).status).toBe(413);
 });
 it('validates project ownership before an image provider call and keeps image replay project-scoped',async()=>{
  const f=await fixture();expect((await f.call('/api/studio/image',{prompt:'draw',projectId:'private'})).status).toBe(404);expect(f.env.AI.run).not.toHaveBeenCalled();
  const first=await f.call('/api/studio/image',{prompt:'draw',projectId:'p1'});expect(first.status).toBe(201);const image=await first.json() as any;expect(image.projectId).toBe('p1');
  const replay=await f.call('/api/studio/image',{prompt:'draw',projectId:'p1'});expect(await replay.json()).toEqual(image);expect(f.env.AI.run).toHaveBeenCalledTimes(1);expect(f.put).toHaveBeenCalledTimes(1);
  expect((await f.call('/api/studio/image',{prompt:'draw',projectId:'p2'})).status).toBe(409);
 });
 it('reserves image capacity before a paid provider call and settles only actual output bytes',async()=>{
  const f=await fixture();f.env.STUDIO_STORAGE_MAX_BYTES=String(12*1024*1024-1);
  expect((await f.call('/api/studio/image',{prompt:'draw',projectId:'p1'})).status).toBe(413);expect(f.env.AI.run).not.toHaveBeenCalled();
  f.env.STUDIO_STORAGE_MAX_BYTES=String(12*1024*1024);
  const result=await f.call('/api/studio/image',{prompt:'draw',projectId:'p1'});expect(result.status).toBe(201);
  const artifact=await result.json() as any;expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:artifact.bytes,usedFiles:1,reservedBytes:0,reservedFiles:0});
 });
 it('releases unused image storage on malformed provider output while keeping paid request identity',async()=>{
  const f=await fixture();vi.mocked(f.env.AI.run).mockResolvedValue({image:btoa('not an image')} as never);
  expect((await f.call('/api/studio/image',{prompt:'draw'})).status).toBe(409);
  expect(await storageUsage(f.env,f.a.id)).toMatchObject({usedBytes:0,reservedBytes:0,reservedFiles:0});
  expect((await f.call('/api/studio/image',{prompt:'draw'})).status).toBe(409);expect(f.env.AI.run).toHaveBeenCalledTimes(1);expect(f.put).not.toHaveBeenCalled();
 });
 it('rejects viewers before uploads, assignment, deletion, and draft writes',async()=>{
  const f=await fixture(),artifact=await (await f.upload()).json() as any;f.sqlite.prepare("UPDATE access_accounts SET role='viewer' WHERE id=?").run(f.a.id);
  expect((await f.upload()).status).toBe(403);expect((await f.call(artifact.url,{projectId:'p1'},'PATCH')).status).toBe(403);expect((await f.call(artifact.url,undefined,'DELETE')).status).toBe(403);
  expect((await f.call('/api/studio/drafts/music?projectId=p1',{baseRevision:0,values:{}},'PUT')).status).toBe(403);
 });
});

describe('Project-scoped studio drafts',()=>{
 it('keeps legacy and each project draft independent with compare-and-swap writes',async()=>{
  const f=await fixture(),legacy='/api/studio/drafts/music',one=legacy+'?projectId=p1',two=legacy+'?projectId=p2';
  for(const [url,text]of [[legacy,'legacy'],[one,'first'],[two,'second']])expect((await f.call(url,{baseRevision:0,values:{'studio-text':text}},'PUT')).status).toBe(200);
  expect((await (await f.call(legacy)).json() as any).values['studio-text']).toBe('legacy');
  expect((await (await f.call(one)).json() as any).values['studio-text']).toBe('first');
  expect((await (await f.call(two)).json() as any).values['studio-text']).toBe('second');
  const responses=await Promise.all([f.call(one,{baseRevision:1,values:{'studio-text':'winner-a'}},'PUT'),f.call(one,{baseRevision:1,values:{'studio-text':'winner-b'}},'PUT')]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);expect((await (await f.call(one)).json() as any).revision).toBe(2);
  expect((await f.call(one,{baseRevision:0,values:{}},'PUT')).status).toBe(409);
 });
 it('never exposes or overwrites drafts across accounts; validates project and fields',async()=>{
  const f=await fixture(),url='/api/studio/drafts/image?projectId=p1';
  expect((await f.call(url,undefined,'GET','b')).status).toBe(404);expect((await f.call(url,{baseRevision:0,values:{}},'PUT','b')).status).toBe(404);
  expect((await f.call('/api/studio/drafts/image?projectId=missing')).status).toBe(404);expect((await f.call('/api/studio/drafts/image?projectId=')).status).toBe(400);
  expect((await f.call(url,{baseRevision:0,values:{unsupported:'value'}},'PUT')).status).toBe(400);
  expect((await f.call(url,{baseRevision:0,values:{'studio-text':'a'.repeat(4001)}},'PUT')).status).toBe(400);
  expect((await (await f.call(url)).json() as any)).toMatchObject({projectId:'p1',revision:0,values:{}});
 });
});
