import {describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {workbenchMigrationPlan} from '../scripts/migration-plan.mjs';
const schema=readFileSync('schema.sql','utf8');
function plan(db:DatabaseSync) {
 return workbenchMigrationPlan((file:string)=>readFileSync(`migrations/${file}`,'utf8'),
  (table:string)=>new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map(row=>row.name)));
}
describe('workbench migration recovery',()=>{
 it('preserves legacy artifacts/drafts and counts their storage once after a repeated upgrade',()=>{
  const db=new DatabaseSync(':memory:');
  try {
   db.exec(schema.split('-- Workbench migration:')[0].replace(', project_id TEXT\n', '\n').replace(' project_id TEXT, plugin_revision INTEGER,\n',''));
   db.exec("INSERT INTO studio_artifacts VALUES('old-file','owner','file.txt','text/plain','old-key',12,1); INSERT INTO studio_drafts VALUES('owner','web',4,'{}',1)");
   expect(plan(db)).toContain('ALTER TABLE studio_artifacts');
   db.exec(plan(db));
   const retry=plan(db);expect(retry).not.toMatch(/^ALTER TABLE/m);db.exec(retry);
   expect(db.prepare('SELECT project_id,bytes FROM studio_artifacts').get()).toEqual({project_id:null,bytes:12});
   expect(db.prepare('SELECT revision FROM studio_drafts').get()?.revision).toBe(4);
   expect(db.prepare('SELECT COUNT(*) AS n,SUM(bytes) AS bytes FROM studio_storage_reservations').get()).toEqual({n:1,bytes:12});
   expect(db.prepare('SELECT COUNT(*) AS n FROM project_studio_drafts').get()?.n).toBe(0);
  }finally{db.close();}
 });
 it('can resume after just one ALTER and agrees with the fresh schema',()=>{
  const db=new DatabaseSync(':memory:');
  try {
   db.exec(schema.split('-- Workbench migration:')[0].replace(', project_id TEXT\n', '\n').replace(' project_id TEXT, plugin_revision INTEGER,\n',''));
   db.exec('ALTER TABLE connector_calls ADD COLUMN project_id TEXT');
   expect(plan(db)).not.toContain('ALTER TABLE connector_calls ADD COLUMN project_id');
   db.exec(plan(db));db.exec(schema);expect(plan(db)).not.toMatch(/^ALTER TABLE/m);
   expect(db.prepare("PRAGMA table_info('connector_calls')").all().map(row=>row.name)).toContain('plugin_revision');
  }finally{db.close();}
 });
});
