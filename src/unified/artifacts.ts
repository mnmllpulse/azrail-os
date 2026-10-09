import type { Env } from '../types';
import { AccessError, hashToken } from '../lib/accounts';

export const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;
const DEFAULT_BYTE_LIMIT = 128 * 1024 * 1024;
const DEFAULT_FILE_LIMIT = 1000;
type ArtifactRow = {id:string;name:string;mime:string;bytes:number;project_id:string|null;created_at:number;r2_key:string};
type Reservation = {id:string;account_id:string;r2_key:string;bytes:number;status:string;request_digest:string|null};
type StorageHold = {id:string;key:string;account:string;bytes:number;createdAt:number};

export function artifactInfo(row:ArtifactRow) {
 return {id:row.id,name:row.name,mime:row.mime,bytes:row.bytes,url:`/api/studio/artifacts/${row.id}`,projectId:row.project_id,created_at:row.created_at};
}

/** Project assignment never claims another account's existing project, including for administrators. */
export async function artifactProject(env:Env,account:string,value:unknown):Promise<string|null> {
 if(value===null||value===undefined)return null;
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new AccessError('Некорректный projectId.',400);
 const owner=await env.AZRAIL_D1.prepare("SELECT account_id FROM resource_owners WHERE kind='project' AND resource_id=?").bind(value).first<{account_id:string}>();
 if(owner?.account_id!==account)throw new AccessError('Проект недоступен.',404);
 return value;
}

function limit(value:string|undefined,fallback:number):number {
 if(value===undefined)return fallback;
 if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new AccessError('Лимит хранилища настроен неверно.',503);
 return Number(value);
}

async function ensureStorageAccount(env:Env,account:string) {
 const maxBytes=limit(env.STUDIO_STORAGE_MAX_BYTES,DEFAULT_BYTE_LIMIT),maxFiles=limit(env.STUDIO_STORAGE_MAX_FILES,DEFAULT_FILE_LIMIT);
 await env.AZRAIL_D1.prepare(`INSERT INTO studio_storage_accounts(account_id,byte_limit,file_limit) VALUES(?,?,?)
  ON CONFLICT(account_id) DO UPDATE SET byte_limit=excluded.byte_limit,file_limit=excluded.file_limit`).bind(account,maxBytes,maxFiles).run();
 return {maxBytes,maxFiles};
}

export async function storageUsage(env:Env,account:string) {
 const limits=await ensureStorageAccount(env,account);
 const row=await env.AZRAIL_D1.prepare(`SELECT
  COALESCE(SUM(CASE WHEN status='committed' THEN bytes ELSE 0 END),0) AS usedBytes,
  COUNT(CASE WHEN status='committed' THEN 1 END) AS usedFiles,
  COALESCE(SUM(CASE WHEN status NOT IN ('committed','released') THEN bytes ELSE 0 END),0) AS reservedBytes,
  COUNT(CASE WHEN status NOT IN ('committed','released') THEN 1 END) AS reservedFiles,
  COUNT(CASE WHEN status IN ('reserved','uncertain') THEN 1 END) AS pendingFiles
  FROM studio_storage_reservations WHERE account_id=?`).bind(account).first();
 return {...row,...limits};
}

export async function listArtifacts(env:Env,account:string,projectId:string|null|undefined) {
 const filter=projectId===undefined?'':projectId===null?' AND a.project_id IS NULL':' AND a.project_id=?';
 const q=env.AZRAIL_D1.prepare(`SELECT a.* FROM studio_artifacts a JOIN studio_storage_reservations s ON s.id=a.id
  WHERE a.account_id=? AND s.status='committed'${filter} ORDER BY a.created_at DESC,a.id DESC LIMIT 100`);
 const result=await (projectId? q.bind(account,projectId):q.bind(account)).all<ArtifactRow>();
 return result.results.map(artifactInfo);
}

export async function readArtifact(env:Env,account:string,id:string):Promise<ArtifactRow|null> {
 return env.AZRAIL_D1.prepare(`SELECT a.* FROM studio_artifacts a JOIN studio_storage_reservations s ON s.id=a.id
  WHERE a.id=? AND a.account_id=? AND s.status='committed'`).bind(id,account).first<ArtifactRow>();
}

export async function linkArtifact(env:Env,account:string,id:string,projectId:string|null) {
 const row=await env.AZRAIL_D1.prepare(`UPDATE studio_artifacts SET project_id=? WHERE id=? AND account_id=?
  AND EXISTS(SELECT 1 FROM studio_storage_reservations WHERE id=? AND status='committed') RETURNING *`).bind(projectId,id,account,id).first<ArtifactRow>();
 if(!row)throw new AccessError('Файл не найден.',404);
 return artifactInfo(row);
}

async function releaseDeleted(env:Env,id:string,account:string) {
 // R2 deletion must have succeeded before this transaction releases any bytes.
 await env.AZRAIL_D1.batch([
  env.AZRAIL_D1.prepare(`DELETE FROM studio_artifacts WHERE id=? AND account_id=? AND EXISTS(
   SELECT 1 FROM studio_storage_reservations WHERE id=? AND status IN ('deleting','cleanup'))`).bind(id,account,id),
  env.AZRAIL_D1.prepare(`UPDATE studio_storage_reservations SET status='released',updated_at=? WHERE id=? AND account_id=?
   AND status IN ('deleting','cleanup') AND NOT EXISTS(SELECT 1 FROM studio_artifacts WHERE id=?)`).bind(Date.now(),id,account,id),
 ]);
}

export async function deleteArtifact(env:Env,account:string,id:string) {
 const row=await env.AZRAIL_D1.prepare(`UPDATE studio_storage_reservations SET status='deleting',updated_at=?
  WHERE id=? AND account_id=? AND status IN ('committed','deleting') RETURNING *`).bind(Date.now(),id,account).first<Reservation>();
 if(!row) {
  const old=await env.AZRAIL_D1.prepare('SELECT status FROM studio_storage_reservations WHERE id=? AND account_id=?').bind(id,account).first<{status:string}>();
  if(old?.status==='released')return {id,deleted:true};
  throw new AccessError('Файл не найден.',404);
 }
 await env.AZRAIL_R2.delete(row.r2_key);
 await releaseDeleted(env,id,account);
 return {id,deleted:true};
}

/** Safe to retry. Never reclaims uncertain/in-flight uploads merely because they are old. */
export async function cleanupArtifactStorage(env:Env,limit=50):Promise<{cleaned:number;failed:number}> {
 const rows=await env.AZRAIL_D1.prepare(`SELECT id,account_id,r2_key FROM studio_storage_reservations
  WHERE status IN ('cleanup','deleting') ORDER BY updated_at LIMIT ?`).bind(Math.min(100,Math.max(1,limit))).all<Reservation>();
 let cleaned=0,failed=0;
 for(const row of rows.results) {
  try {await env.AZRAIL_R2.delete(row.r2_key);await releaseDeleted(env,row.id,row.account_id);cleaned++;}
  catch {failed++;}
 }
 return {cleaned,failed};
}

/** Generation reserves its maximum output before spending a provider call. */
export async function reserveArtifactStorage(env:Env,account:string,bytes:number,requestKey:string|null=null,digest:string|null=null):Promise<StorageHold> {
 if(!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_ARTIFACT_BYTES)throw new AccessError('Некорректный резерв хранилища.',400);
 await ensureStorageAccount(env,account);
 const id=crypto.randomUUID(),key=`studio/${account}/${id}`,now=Date.now();
 // SQLite serializes this write: competing requests cannot both observe spare capacity.
 const reservation=await env.AZRAIL_D1.prepare(`INSERT INTO studio_storage_reservations
  (id,account_id,r2_key,bytes,status,request_key,request_digest,created_at,updated_at)
  SELECT ?,?,?,?,'reserved',?,?,?,? FROM studio_storage_accounts a WHERE a.account_id=?
   AND (SELECT COALESCE(SUM(bytes),0) FROM studio_storage_reservations WHERE account_id=a.account_id AND status!='released')+?<=a.byte_limit
   AND (SELECT COUNT(*) FROM studio_storage_reservations WHERE account_id=a.account_id AND status!='released')+1<=a.file_limit
   AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM studio_storage_reservations WHERE account_id=a.account_id AND request_key=?))
  ON CONFLICT DO NOTHING RETURNING id`).bind(id,account,key,bytes,requestKey,digest,now,now,account,bytes,requestKey,requestKey).first();
 if(!reservation) {
  if(requestKey&&await env.AZRAIL_D1.prepare('SELECT id FROM studio_storage_reservations WHERE account_id=? AND request_key=?').bind(account,requestKey).first())throw new AccessError('Загрузка с этим ключом уже выполняется. Повторите проверку с тем же ключом.',409);
  throw new AccessError('Достигнут лимит хранилища аккаунта. Удалите ненужные файлы.',413);
 }
 return {id,key,account,bytes,createdAt:now};
}

/** Only call before handing this reservation to saveArtifact (no R2 write began). */
export async function releaseEmptyArtifactReservation(env:Env,hold:StorageHold) {
 await env.AZRAIL_D1.prepare("UPDATE studio_storage_reservations SET status='released',updated_at=? WHERE id=? AND account_id=? AND status='reserved'").bind(Date.now(),hold.id,hold.account).run();
}

export async function saveArtifact(env:Env,account:string,name:string,mime:string,bytes:Uint8Array,projectId:string|null=null,requestKey:string|null=null,hold?:StorageHold) {
 if(bytes.length>MAX_ARTIFACT_BYTES)throw new AccessError('Файл превышает лимит 12 МиБ.',413);
 if(requestKey!==null&&!/^[A-Za-z0-9_-]{12,128}$/.test(requestKey))throw new AccessError('Некорректный Idempotency-Key.',400);
 if(hold&&(hold.account!==account||bytes.length>hold.bytes||requestKey!==null))throw new AccessError('Некорректный резерв хранилища.',400);
 const digest=requestKey?await hashToken(JSON.stringify([name,mime,projectId,Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))])):null;
 if(requestKey) {
  const existing=await env.AZRAIL_D1.prepare('SELECT * FROM studio_storage_reservations WHERE account_id=? AND request_key=?').bind(account,requestKey).first<Reservation>();
  if(existing) {
   if(existing.request_digest!==digest)throw new AccessError('Ключ уже используется для другого файла.',409);
   const saved=existing.status==='committed'?await readArtifact(env,account,existing.id):null;
   if(saved)return artifactInfo(saved);
   throw new AccessError('Загрузка уже выполняется, удалена или требует сверки. Проверьте файлы проекта.',409);
  }
 }
 const {id,key,createdAt:now}=hold??await reserveArtifactStorage(env,account,bytes.length,requestKey,digest);
 try {await env.AZRAIL_R2.put(key,bytes,{httpMetadata:{contentType:mime}});}
 catch(error) {
  // An ambiguous remote write must continue to count against the limit.
  await env.AZRAIL_D1.prepare("UPDATE studio_storage_reservations SET status='uncertain',updated_at=? WHERE id=? AND status='reserved'").bind(Date.now(),id).run();
  throw error;
 }
 try {
  await env.AZRAIL_D1.batch([
   env.AZRAIL_D1.prepare(`INSERT INTO studio_artifacts(id,account_id,name,mime,r2_key,bytes,created_at,project_id)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM studio_storage_reservations WHERE id=? AND status='reserved')`).bind(id,account,name,mime,key,bytes.length,now,projectId,id),
   env.AZRAIL_D1.prepare(`UPDATE studio_storage_reservations SET status='committed',bytes=?,updated_at=? WHERE id=? AND status='reserved'
    AND EXISTS(SELECT 1 FROM studio_artifacts WHERE id=?)`).bind(bytes.length,Date.now(),id,id),
  ]);
 } catch(error) {
  // A lost database response can conceal a committed transaction. Preserve that file.
  const committed=await readArtifact(env,account,id);
  if(committed)return artifactInfo(committed);
  const cleanup=await env.AZRAIL_D1.prepare("UPDATE studio_storage_reservations SET status='cleanup',updated_at=? WHERE id=? AND status='reserved' RETURNING id").bind(Date.now(),id).first();
  if(cleanup) {
   try {await env.AZRAIL_R2.delete(key);await releaseDeleted(env,id,account);} catch {/* Durable cleanup is retried by the scheduled handler. */}
  }
  throw error;
 }
 const saved=await readArtifact(env,account,id);
 if(!saved)throw new AccessError('Сохранение файла требует сверки.',503);
 return artifactInfo(saved);
}
