import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {sqliteD1} from './stubs/sqlite-d1';
const source=readFileSync('scripts/migrate.mjs','utf8').replace(/^import .*;\n/gm,'').replace('import.meta.url',JSON.stringify(new URL('../scripts/migrate.mjs',import.meta.url).href));
function execute(apply:boolean){
  const {sqlite}=sqliteD1();sqlite.exec("DROP TABLE mission_hints; ALTER TABLE missions DROP COLUMN result_json; INSERT INTO missions(id,goal,status) VALUES('existing','keep this','completed');");
  const written=new Map<string,string>(),calls:string[][]=[];
  const execFileSync=(_exe:string,args:string[])=>{
    const a=args.slice(1);calls.push(a);expect(a).toContain('AZRAIL_D1');expect(a).toContain(resolve('wrangler.free.example.toml'));
    if(a[1]==='export')return 'exported';
    const command=a.indexOf('--command');if(command>=0)return JSON.stringify([{success:true,results:sqlite.prepare(a[command+1]).all()}]);
    const file=a.indexOf('--file');if(file>=0){sqlite.exec(written.get(a[file+1])!);return 'applied';}
    throw Error('unexpected subprocess');
  };
  runInNewContext(source,{execFileSync,readFileSync,writeFileSync:(p:string,s:string)=>written.set(p,s),mkdirSync(){},resolve,fileURLToPath:(u:URL)=>u.pathname,URL,process:{argv:['node','script','--local','--config','wrangler.free.example.toml',...(apply?['--apply']:[])],execPath:process.execPath},console:{log(){}}});
  return {sqlite,calls};
}
describe('migration plan against real SQLite and isolated subprocesses',()=>{
  it('inspection produces a plan without applying it',()=>{const t=execute(false);expect(t.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='mission_hints'").get()).toBeUndefined();expect(t.calls.some(c=>c.includes('--file'))).toBe(false);});
  it('applies missing columns and hint queue without losing existing missions',()=>{
    const t=execute(true);expect(t.sqlite.prepare("SELECT goal FROM missions WHERE id='existing'").get()?.goal).toBe('keep this');expect(t.sqlite.prepare("SELECT COUNT(*) n FROM mission_hints").get()?.n).toBe(0);
    const backup=t.calls.findIndex(c=>c[1]==='export'),apply=t.calls.findIndex(c=>c.includes('--file'));expect(backup).toBeGreaterThan(-1);expect(apply).toBeGreaterThan(backup);
  });
});
