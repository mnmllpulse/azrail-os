import { workspacePrefix,publishWorkspace,logicalWorkspacePath,workspacePath } from "./workspace-head";
import type { Env } from "../types";
import { withProjectLock } from "./project-control";

async function sha(bytes:Uint8Array):Promise<string> {
  const sum=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(sum)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
interface Backup {version:1|2;projectId:string;createdAt:string;files:Array<{path:string;key:string;sha256:string;size:number}>}
export async function backupProject(env:Env,project:string) {
  return withProjectLock(env,project,crypto.randomUUID(),async()=>{
    const prefix=await workspacePrefix(env,project),id=crypto.randomUUID(),files:Backup["files"]=[];
    let cursor:string|undefined,total=0;
    do {
      const page=await env.AZRAIL_R2.list({prefix,cursor,limit:100});
      for(const obj of page.objects) {
        total+=obj.size;if(files.length>=1000||total>16*1024*1024)throw new Error("Предел копии: 1000 файлов / 16 МиБ.");
        const value=await env.AZRAIL_R2.get(obj.key);if(!value)throw new Error("Файл исчез во время копирования.");
        const bytes=new Uint8Array(await value.arrayBuffer()), key=`backups/${project}/${id}/${files.length}`;
        await env.AZRAIL_R2.put(key,bytes);
        files.push({path:logicalWorkspacePath(prefix,obj.key.slice(prefix.length)),key,sha256:await sha(bytes),size:bytes.length});
      }
      if(!page.truncated)break;
      if(!page.cursor||page.cursor===cursor)throw new Error("Неполный список файлов.");cursor=page.cursor;
    }while(true);
    const manifest:Backup={version:2,projectId:project,createdAt:new Date().toISOString(),files};
    const key=`backups/${project}/${id}/manifest.json`;await env.AZRAIL_R2.put(key,JSON.stringify(manifest));
    await env.AZRAIL_D1.prepare("INSERT INTO backup_manifests(id,project_id,r2_key,created_at,file_count) VALUES(?,?,?,?,?)").bind(id,project,key,Date.now(),files.length).run();
    return {id,files:files.length,bytes:total};
  });
}
/** Restore into a new project. Existing working files are never overwritten. */
export async function restoreBackup(env:Env,project:string,id:string,target:string) {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(target)||target===project)throw new Error("Нужен новый projectId для восстановления.");
  return withProjectLock(env,target,crypto.randomUUID(),async()=>{
    const existing=await env.AZRAIL_R2.list({prefix:await workspacePrefix(env,target),limit:1});
    if(existing.objects.length)throw new Error("Целевой проект должен быть пустым.");
    const row=await env.AZRAIL_D1.prepare("SELECT r2_key FROM backup_manifests WHERE id=? AND project_id=?").bind(id,project).first<{r2_key:string}>();
    if(!row)throw new Error("Копия не найдена.");
    const object=await env.AZRAIL_R2.get(row.r2_key);if(!object)throw new Error("Манифест отсутствует.");
    const m=JSON.parse(await object.text()) as Backup;
    if(![1,2].includes(m.version)||m.projectId!==project||!Array.isArray(m.files)||m.files.length>1000)throw new Error("Повреждённый манифест.");
    const values:Array<{path:string;bytes:Uint8Array}>=[];let total=0;
    for(const f of m.files) {
      if(!f.key.startsWith(`backups/${project}/${id}/`))throw new Error("Неверная область копии.");
      workspacePath(f.path);
      if(m.version===1 && /%[0-9a-f]{2}/i.test(f.path))
        throw new Error("Копия v1 содержит неоднозначно закодированные пути. Сначала проверьте имена и переведите манифест в v2.");
      const o=await env.AZRAIL_R2.get(f.key);if(!o)throw new Error("Файл копии отсутствует.");
      if(o.size>16*1024*1024)throw new Error("Слишком большой файл.");
      const bytes=new Uint8Array(await o.arrayBuffer());total+=bytes.length;
      if(total>16*1024*1024||bytes.length!==f.size||await sha(bytes)!==f.sha256)throw new Error("Копия не прошла проверку целостности.");
      values.push({path:f.path,bytes});
    }
    // All hashes validated before the first write.
    await publishWorkspace(env,target,values.map(f=>({path:f.path,content:f.bytes})));
    return {projectId:target,restored:values.length};
  });
}
