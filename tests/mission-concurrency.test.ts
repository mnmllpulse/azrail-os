import { it, expect } from "vitest";
import { sqliteD1 } from "./stubs/sqlite-d1";
import { createMission } from "../src/lib/mission-concurrency";
import type { Env } from "../src/types";
import { workbenchFixture } from './workbench-fixture';
import { authorizeRequest } from '../src/lib/accounts';
it("parallel missions in one project have only one winner",async()=>{
  const {db,sqlite}=sqliteD1();const env={AZRAIL_D1:db} as Env;
  const results=await Promise.all(Array.from({length:10},(_,i)=>createMission(env,`m${i}`,"p","goal")));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await createMission(env,"other","other-project","goal")).toBe(true);
  sqlite.exec("UPDATE missions SET status='completed' WHERE project_id='p'");
  expect(await createMission(env,"next","p","goal")).toBe(true);
});

it('admitted first mission appears in its owner catalogue and keeps workspace files',async()=>{
  const f=workbenchFixture(),token=f.account('alice');f.account('bob');
  const request=new Request('https://app.example.com/api/mission',{method:'POST'});
  await authorizeRequest(f.env,{id:'alice',name:'Alice',role:'editor'},request,{projectId:'new-p'});
  expect(await createMission(f.env,'first','new-p','  Мой сайт\n с музыкой  ')).toBe(true);
  await f.r2.put('projects/new-p/workspace/index.html','<h1>Created by mission</h1>');
  const listed=await f.call('', 'GET',undefined,token);
  expect(listed.body.projects).toEqual([expect.objectContaining({id:'new-p',name:'Мой сайт с музыкой'})]);
  expect((await f.call('/new-p/files','GET',undefined,token)).body.files).toEqual([expect.objectContaining({path:'index.html'})]);
  const bob=f.account('other');expect((await f.call('','GET',undefined,bob)).body.projects).toEqual([]);
  await expect(authorizeRequest(f.env,{id:'bob',name:'Bob',role:'editor'},request,{projectId:'new-p'})).rejects.toThrow('Ресурс недоступен');
});

it('rejected busy admission does not add metadata and existing metadata is preserved',async()=>{
  const {db,sqlite}=sqliteD1(),env={AZRAIL_D1:db} as Env;
  sqlite.exec("INSERT INTO missions(id,project_id,goal,status) VALUES('running','p','old','executing')");
  expect(await createMission(env,'rejected','p','new')).toBe(false);
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get()?.n).toBe(0);
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM mission_outbox').get()?.n).toBe(0);
  sqlite.exec("UPDATE missions SET status='completed'; INSERT INTO users(id,name) VALUES('system','system'); INSERT INTO projects(id,user_id,name,status) VALUES('p','system','My title','archived')");
  expect(await createMission(env,'accepted','p','replace title')).toBe(true);
  expect(sqlite.prepare("SELECT name,status FROM projects WHERE id='p'").get()).toMatchObject({name:'My title',status:'archived'});
});

it('catalogue persistence failure rolls back mission and delivery together',async()=>{
  const {db,sqlite}=sqliteD1();
  sqlite.exec("CREATE TRIGGER reject_project BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'project unavailable'); END");
  await expect(createMission({AZRAIL_D1:db} as Env,'m','p','goal')).rejects.toThrow('project unavailable');
  for(const table of ['missions','mission_outbox','projects','users'])expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
});
