import {afterEach,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {sqliteD1} from './stubs/sqlite-d1';
import {workbenchMigrationPlan} from '../scripts/migration-plan.mjs';
import {parseGuardConfig} from '../scripts/check-staging.mjs';
const source=readFileSync('scripts/migrate.mjs','utf8').replace(/^import .*;\n/gm,'').replace('import.meta.url',JSON.stringify(new URL('../scripts/migrate.mjs',import.meta.url).href));
const databases:Array<{close():void}>=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function execute(apply:boolean,options:{remote?:boolean;config?:string;configText?:string;failExport?:boolean;failUpload?:boolean}={}){
  const {sqlite}=sqliteD1();sqlite.exec("DROP TABLE mission_hints; ALTER TABLE missions DROP COLUMN result_json; INSERT INTO missions(id,goal,status) VALUES('existing','keep this','completed');");
  databases.push(sqlite);
  const selected=resolve(options.config??'wrangler.free.example.toml');
  const written=new Map<string,string>(),calls:string[][]=[];
  const execFileSync=(_exe:string,args:string[])=>{
    const a=args.slice(1);calls.push(a);expect(a[a.indexOf('--config')+1]).toBe(selected);
    if(a[0]==='r2'){
      expect(a.slice(0,3)).toEqual(['r2','object','put']);
      if(options.failUpload)throw Error('R2 upload failed');
      return 'uploaded';
    }
    expect(a).toContain('AZRAIL_D1');
    expect(a).toContain(options.remote?'--remote':'--local');
    if(a[1]==='export'){
      if(options.failExport)throw Error('D1 export failed');
      return 'exported';
    }
    const command=a.indexOf('--command');if(command>=0)return JSON.stringify([{success:true,results:sqlite.prepare(a[command+1]).all()}]);
    const file=a.indexOf('--file');if(file>=0){sqlite.exec(written.get(a[file+1])!);return 'applied';}
    throw Error('unexpected subprocess');
  };
  let error:unknown;
  try{
    runInNewContext(source,{workbenchMigrationPlan,parseGuardConfig,execFileSync,readFileSync:(p:string,encoding:any)=>p===selected&&options.configText!==undefined?options.configText:readFileSync(p,encoding),writeFileSync:(p:string,s:string)=>written.set(p,s),mkdirSync(){},resolve,fileURLToPath:(u:URL)=>u.pathname,URL,process:{argv:['node','script',options.remote?'--remote':'--local','--config',selected,...(apply?['--apply']:[])],execPath:process.execPath},console:{log(){}}});
  }catch(caught){error=caught;}
  return {sqlite,calls,error};
}
describe('migration plan against real SQLite and isolated subprocesses',()=>{
  it('inspection produces a plan without applying it',()=>{const t=execute(false);expect(t.error).toBeUndefined();expect(t.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='mission_hints'").get()).toBeUndefined();expect(t.calls.some(c=>c.includes('--file'))).toBe(false);});
  it('applies missing columns and hint queue without losing existing missions',()=>{
    const t=execute(true);expect(t.error).toBeUndefined();expect(t.sqlite.prepare("SELECT goal FROM missions WHERE id='existing'").get()?.goal).toBe('keep this');expect(t.sqlite.prepare("SELECT COUNT(*) n FROM mission_hints").get()?.n).toBe(0);
    const backup=t.calls.findIndex(c=>c[1]==='export'),apply=t.calls.findIndex(c=>c.includes('--file'));expect(backup).toBeGreaterThan(-1);expect(apply).toBeGreaterThan(backup);
    expect(t.calls.some(c=>c[0]==='r2')).toBe(false);
  });
  it.each(['toml','json'])('copies a remote %s backup to the same selected environment before migration',format=>{
    const configText=format==='json'?JSON.stringify({r2_buckets:[{binding:'AZRAIL_R2',bucket_name:'azrail-artifacts-staging'}]}):'[[r2_buckets]]\nbinding="AZRAIL_R2"\nbucket_name="azrail-artifacts-staging"\n';
    const t=execute(true,{remote:true,config:`.work/selected-staging.${format}`,configText});
    expect(t.error).toBeUndefined();
    const backup=t.calls.findIndex(c=>c[1]==='export'),upload=t.calls.findIndex(c=>c[0]==='r2'),apply=t.calls.findIndex(c=>c[0]==='d1'&&c.includes('--file'));
    expect(upload).toBeGreaterThan(backup);expect(apply).toBeGreaterThan(upload);
    const uploaded=t.calls[upload];
    expect(uploaded[3]).toMatch(/^azrail-artifacts-staging\/ops\/backups\/d1-before-.*\.sql$/);
    expect(uploaded).toContain('--remote');
    expect(uploaded[uploaded.indexOf('--file')+1]).toBe(t.calls[backup][t.calls[backup].indexOf('--output')+1]);
    expect(t.sqlite.prepare("SELECT goal FROM missions WHERE id='existing'").get()?.goal).toBe('keep this');
  });
  it.each(['failExport','failUpload'] as const)('does not apply remote schema changes after %s',failure=>{
    const t=execute(true,{remote:true,config:'.work/selected-staging.toml',configText:'[[r2_buckets]]\nbinding="AZRAIL_R2"\nbucket_name="azrail-artifacts-staging"\n',[failure]:true});
    expect(String(t.error)).toContain(failure==='failExport'?'D1 export failed':'R2 upload failed');
    expect(t.calls.some(c=>c[0]==='d1'&&c.includes('--file'))).toBe(false);
    expect(t.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='mission_hints'").get()).toBeUndefined();
  });
  it('requires one backup bucket before inspecting a remote database for apply',()=>{
    const t=execute(true,{remote:true,config:'.work/selected-staging.toml',configText:'name="azrail-pulse-staging"\n'});
    expect(String(t.error)).toContain('Exactly one AZRAIL_R2 backup bucket');
    expect(t.calls).toEqual([]);
  });
  it('remote inspection does not export, upload, or apply',()=>{
    const t=execute(false,{remote:true});
    expect(t.error).toBeUndefined();
    expect(t.calls.every(c=>c[0]==='d1'&&c[1]==='execute'&&c.includes('--command'))).toBe(true);
  });
});
