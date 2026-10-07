import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, type Database, type Statement } from '../../control-plane/store.ts';
import type { Capacity } from '../../shared/contracts.ts';

export interface LocalDatabase extends Database { close(): void }
export const migrationsDirectory = resolve('control-plane/migrations');
export const job = {name:'Synthetic',provider:'codex-luna',prompt:'2+3?',startAt:1000000,intervalSeconds:60,maxRuns:2,enabled:true};
export const limits: Capacity = {models:{'codex-luna':1,'codex-sol':1,'pi-swe2':1},groups:{shared:1,a:1,b:1}};

// The plan names these new modules; keep their test-facing seams in one fixture.
// No replacement database or HTTP implementation is supplied by this fixture.
export async function openDatabase(path: string): Promise<LocalDatabase> {
  const modulePath = '../../control-plane/sqlite.ts';
  const module = await import(modulePath) as {SqliteDatabase:new(path:string)=>LocalDatabase};
  return new module.SqliteDatabase(path);
}
export async function migrate(db: LocalDatabase, directory: string): Promise<void> {
  const modulePath = '../../control-plane/migrations.ts';
  const module = await import(modulePath) as {migrate(db:LocalDatabase,directory:string):void|Promise<void>};
  await module.migrate(db,directory);
}
export async function localDispatch(store: Store, at: number, owner?: string) {
  const modulePath = '../../control-plane/dispatch.ts';
  const module = await import(modulePath) as {dispatch(store:Store,at:number,owner?:string):Promise<{enqueued:number;skipped:number;ids:string[]}>};
  return module.dispatch(store,at,owner);
}
export async function savedStarts(db: LocalDatabase, count: number) {
  const store=new Store(db,()=>1000000);
  for(let i=0;i<count;i++)await store.create('owner-'+Math.floor(i/10),'saved-'+i,job);
  await store.tick(1000000);
  return (await store.q("SELECT id,owner FROM runs WHERE state='starting' ORDER BY id").all<{id:string;owner:string}>()).results;
}
export function observeRecovery(native: LocalDatabase) {
  const events: ({kind:'read';rows:number}|{kind:'activate'})[]=[];
  const pendingQueries: string[]=[];
  const statements=new WeakMap<Statement,Statement>();
  const db:LocalDatabase={
    prepare(sql:string):Statement {
      const statement=native.prepare(sql);
      const startingRead=/^SELECT id(?:,owner)? FROM runs WHERE state='starting'/.test(sql);
      if(sql.startsWith('SELECT id,owner FROM runs'))pendingQueries.push(sql);
      if(!startingRead&&!sql.startsWith("UPDATE runs SET state='queued'"))return statement;
      const wrapper:Statement={
        bind(...values){statement.bind(...values);return this;},
        first:<T>()=>statement.first<T>(),
        async all<T>(){const result=await statement.all<T>();if(startingRead)events.push({kind:'read',rows:result.results.length});return result;},
        run(){if(sql.startsWith("UPDATE runs SET state='queued'"))events.push({kind:'activate'});return statement.run();},
      };
      statements.set(wrapper,statement);
      return wrapper;
    },
    batch:list=>native.batch(list.map(statement=>statements.get(statement)??statement)),close:()=>native.close(),
  };
  return {db,events,pendingQueries};
}
export async function startServer(db: LocalDatabase, authJson: string, options: {port:number;scheduleEnabled?:boolean;scheduleIntervalMs?:number}) {
  const modulePath = '../../control-plane/server.ts';
  const module = await import(modulePath) as {startServer(options:{db:LocalDatabase;authJson:string;limits:Capacity;host:string;port:number;scheduleEnabled?:boolean;scheduleIntervalMs?:number}):Promise<{url:string;stop():Promise<void>}>};
  return module.startServer({db,authJson,limits,host:'127.0.0.1',...options});
}
export function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(),'local-control-'));
  return {directory,path:join(directory,'control.sqlite'),cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
