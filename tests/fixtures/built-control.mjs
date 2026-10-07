import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [databaseModule,migrationModule,serverModule,migrations,path]=process.argv.slice(2);
const {SqliteDatabase}=await import(pathToFileURL(databaseModule));
const {migrate}=await import(pathToFileURL(migrationModule));
const {startServer}=await import(pathToFileURL(serverModule));
const db=new SqliteDatabase(path);let server;
try {
  await migrate(db,migrations);
  const token=randomBytes(32).toString('base64url');
  const authJson=JSON.stringify([{id:'viewer',owner:'a',role:'viewer',hash:createHash('sha256').update(token).digest('hex')}]);
  server=await startServer({db,authJson,limits:{models:{'codex-luna':1,'codex-sol':1,'pi-swe2':1},groups:{a:1}},host:'127.0.0.1',port:0});
  const response=await fetch(server.url+'/api/state',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{jobs:[],runs:[]});
} finally {if(server)await server.stop();else db.close();}
