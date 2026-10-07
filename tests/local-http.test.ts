import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { Store, type Statement } from '../control-plane/store.ts';
import { job, migrate, migrationsDirectory, observeRecovery, openDatabase, savedStarts, startServer, temporaryDirectory, type LocalDatabase } from './fixtures/local-control.ts';

function credentials(owners=['a','b']) {
  const tokens:Record<string,string>=Object.fromEntries([...owners,'worker'].map(id=>[id,Buffer.from(randomBytes(32)).toString('base64url')]));
  const auth=JSON.stringify(Object.entries(tokens).map(([id,token])=>({id,owner:id==='worker'?'a':id,role:id==='worker'?'worker':'viewer',hash:createHash('sha256').update(token).digest('hex')})));
  return {tokens,auth};
}

for(const entry of ['startup','periodic','disabled'] as const)test('many-owner recovery through '+entry+' preserves API state and bounded reads',{timeout:15000},async t=>{
  const f=temporaryDirectory();let db,server;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);
    const observed=observeRecovery(db),owners=Array.from({length:21},(_,i)=>'owner-'+i),c=credentials(owners);
    t.mock.timers.enable({apis:['setInterval']});
    if(entry!=='startup')server=await startServer(observed.db,c.auth,{port:0,scheduleEnabled:entry==='periodic',scheduleIntervalMs:10});
    const saved=await savedStarts(db,201);
    const cancelled=saved[0];
    await new Store(db).cancel(cancelled.owner,cancelled.id);
    if(entry==='startup')server=await startServer(observed.db,c.auth,{port:0});
    else {t.mock.timers.tick(10);await new Promise<void>(resolve=>setImmediate(resolve));}
    const expected=entry==='disabled'?'starting':'queued';
    for(const owner of owners){
      const response=await api(server!.url,'/api/state',c.tokens[owner]);assert.equal(response.status,200);
      const state=await response.json() as {runs:{id:string;state:string;attempt:number}[]};
      assert.deepEqual(state.runs.map(run=>({id:run.id,state:run.state,attempt:run.attempt})).sort((a,b)=>a.id.localeCompare(b.id)),saved.filter(run=>run.owner===owner).map(run=>({id:run.id,state:run.id===cancelled.id?'cancelled':expected,attempt:0})).sort((a,b)=>a.id.localeCompare(b.id)));
    }
    const reads=observed.events.filter(event=>event.kind==='read');
    assert.ok(reads.every(event=>event.rows<=100));
    assert.equal(reads.reduce((n,event)=>n+event.rows,0),entry==='disabled'?0:200);
    assert.deepEqual(observed.pendingQueries,[]);
    if(entry!=='disabled')assert.equal(observed.events[0]?.kind,'read');
  } finally {t.mock.timers.reset();if(server)await server.stop();else db?.close();f.cleanup();}
});

for(const scenario of ['new','saved','skip'] as const)test('owner HTTP tick preserves acceptance response for '+scenario,{timeout:15000},async()=>{
  const f=await setup();
  try {
    const store=new Store(f.db,()=>1000000),id=await store.create('a','one',job);
    if(scenario!=='new')await store.tick(1000000,'a');
    const response=await api(f.server.url,'/api/tick',f.tokens.a,{at:scenario==='skip'?1060000:1000000});
    assert.equal(response.status,202);
    assert.deepEqual(await response.json(),{enqueued:scenario==='new'?1:0,skipped:scenario==='skip'?1:0,ids:[id+':0']});
    const status=await api(f.server.url,'/api/ticks/'+id+':0',f.tokens.a);assert.equal(status.status,200);
    assert.deepEqual(await status.json(),{id:id+':0',state:'queued'});
    assert.equal((await api(f.server.url,'/api/ticks/'+id+':0',f.tokens.b)).status,404);
    assert.equal((await store.list('a')).runs.find(run=>run.id===id+':0')!.attempt,0);
  } finally {await f.cleanup();}
});

for(const owner of ['a','b'])test('authenticated HTTP tick recovers only '+owner+' saved starts',{timeout:15000},async()=>{
  const f=await setup();
  try {
    const store=new Store(f.db,()=>1000000),ids:Record<string,string>={};
    for(const selected of ['a','b'])ids[selected]=await store.create(selected,'one',job)+':0';
    await store.tick(1000000);
    const response=await api(f.server.url,'/api/tick',f.tokens[owner],{at:1000000});assert.equal(response.status,202);
    assert.deepEqual(await response.json(),{enqueued:0,skipped:0,ids:[ids[owner]]});
    for(const selected of ['a','b']){
      const status=await api(f.server.url,'/api/ticks/'+ids[selected],f.tokens[selected]);assert.equal(status.status,200);
      assert.deepEqual(await status.json(),{id:ids[selected],state:selected===owner?'queued':'starting'});
    }
  } finally {await f.cleanup();}
});
async function setup() {
  const f=temporaryDirectory();let db:LocalDatabase|undefined;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const c=credentials();
    const server=await startServer(db,c.auth,{port:0});
    return {...f,db,server,...c,cleanup:async()=>{try{await server.stop();}finally{f.cleanup();}}};
  } catch(error) {db?.close();f.cleanup();throw error;}
}
function api(url:string,path:string,token:string,body?:unknown) {
  return fetch(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json','idempotency-key':'synthetic'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
}

test('real loopback HTTP preserves UI routes authentication roles and owner isolation',{timeout:15000},async()=>{
  const f=await setup();
  try {
    for(const path of ['/','/app.js','/development','/development.js'])assert.equal((await fetch(f.server.url+path)).status,200);
    assert.equal((await fetch(f.server.url+'/api/state')).status,401);
    assert.equal((await api(f.server.url,'/api/state',f.tokens.worker)).status,403);
    const response=await api(f.server.url,'/api/jobs',f.tokens.a,job);assert.equal(response.status,201);
    const {id}=await response.json() as {id:string};
    assert.equal((await api(f.server.url,'/api/jobs/'+id+'/disable',f.tokens.b,{})).status,404);
    const a=await (await api(f.server.url,'/api/state',f.tokens.a)).json() as {jobs:unknown[]};
    const b=await (await api(f.server.url,'/api/state',f.tokens.b)).json() as {jobs:unknown[]};
    assert.equal(a.jobs.length,1);assert.deepEqual(b.jobs,[]);
    assert.equal((await api(f.server.url,'/api/jobs',f.tokens.worker,job)).status,403);
  } finally {await f.cleanup();}
});

test('real HTTP preserves Host and Origin rather than rewriting them',{timeout:15000},async()=>{
  const f=await setup();
  try {
    const badHost=await new Promise<number>((resolve,reject)=>{
      const req=request(f.server.url+'/api/state',{headers:{host:'evil.test',authorization:'Bearer '+f.tokens.a}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('host_response_timeout')));req.end();
    });
    assert.equal(badHost,403);
    const response=await fetch(f.server.url+'/api/jobs',{method:'POST',headers:{authorization:'Bearer '+f.tokens.a,'content-type':'application/json',origin:'http://evil.test','idempotency-key':'origin'},body:JSON.stringify(job)});
    assert.equal(response.status,403);assert.equal((await new Store(f.db).list('a')).jobs.length,0);
    const allowed=await fetch(f.server.url+'/api/jobs',{method:'POST',headers:{authorization:'Bearer '+f.tokens.a,'content-type':'application/json',origin:new URL(f.server.url).origin,'idempotency-key':'origin'},body:JSON.stringify(job)});
    assert.equal(allowed.status,201);
  } finally {await f.cleanup();}
});

test('chunked HTTP rejects oversized body before end of input and makes no inserts',{timeout:15000},async()=>{
  const f=await setup();
  try {
    const status=await new Promise<number>((resolve,reject)=>{
      const req=request(f.server.url+'/api/jobs',{method:'POST',headers:{authorization:'Bearer '+f.tokens.a,'content-type':'application/json','idempotency-key':'oversized'}},res=>{res.resume();resolve(res.statusCode!);req.destroy();});
      req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('body_limit_did_not_respond')));
      req.write(' '.repeat(12000));req.write(' '.repeat(12001));
      // Intentionally leave the request unfinished: buffering to EOF would hang.
    });
    assert.equal(status,413);assert.equal((await new Store(f.db).list('a')).jobs.length,0);
  } finally {await f.cleanup();}
});

test('completed oversized HTTP body is rejected and subsequent valid input still succeeds',{timeout:15000},async()=>{
  const f=await setup();
  try {
    const response=await fetch(f.server.url+'/api/jobs',{method:'POST',headers:{authorization:'Bearer '+f.tokens.a,'content-type':'application/json','idempotency-key':'completed-oversized'},body:' '.repeat(24001),signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,413);assert.equal((await new Store(f.db).list('a')).jobs.length,0);
    assert.equal((await api(f.server.url,'/api/jobs',f.tokens.a,job)).status,201);
  }finally{await f.cleanup();}
});

test('disconnected partial request makes no insert and server still accepts valid input',{timeout:15000},async()=>{
  const f=await setup();
  try {
    await new Promise<void>((resolve,reject)=>{
      const address=new URL(f.server.url),socket=connect(Number(address.port),address.hostname);
      socket.setTimeout(5000,()=>socket.destroy(Error('partial_request_timeout')));
      socket.once('error',reject);socket.once('connect',()=>{
        socket.end('POST /api/jobs HTTP/1.1\r\nHost: '+address.host+'\r\nAuthorization: Bearer '+f.tokens.a+'\r\nContent-Type: application/json\r\nIdempotency-Key: incomplete\r\nContent-Length: 1000\r\n\r\n{"name":');
      });socket.resume();socket.once('close',()=>resolve());
    });
    assert.equal((await new Store(f.db).list('a')).jobs.length,0);
    assert.equal((await api(f.server.url,'/api/jobs',f.tokens.a,job)).status,201);
  } finally {await f.cleanup();}
});

test('server startup recovers saved starting without enabling periodic scheduling',{timeout:15000},async()=>{
  const f=temporaryDirectory();let db,server;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db);
    const now=Date.now(),saved=await store.create('a','saved',{...job,startAt:now});await store.tick(now,'a');
    await store.create('a','unticked',{...job,startAt:now});
    server=await startServer(db,credentials().auth,{port:0});
    const runs=(await store.list('a')).runs;
    assert.equal(runs.length,1);assert.equal(runs[0].id,saved+':0');assert.equal(runs[0].state,'queued');
  } finally {if(server)await server.stop();else db?.close();f.cleanup();}
});

test('periodic dispatch requires explicit local opt in',{timeout:15000},async t=>{
  const f=temporaryDirectory();let db,server;
  try {
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const store=new Store(db);
    await store.create('a','one',{...job,startAt:Date.now()});
    t.mock.timers.enable({apis:['setInterval']});
    server=await startServer(db,credentials().auth,{port:0});
    t.mock.timers.tick(120000);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal((await store.list('a')).runs.length,0);
    await server.stop();server=undefined;db=await openDatabase(f.path);
    const enabled=new Store(db);
    server=await startServer(db,credentials().auth,{port:0,scheduleEnabled:true,scheduleIntervalMs:10});
    t.mock.timers.tick(10);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal((await enabled.list('a')).runs[0].state,'queued');
  } finally {t.mock.timers.reset();if(server)await server.stop();else db?.close();f.cleanup();}
});

test('graceful stop drains an active database request before closing its connection',{timeout:15000},async()=>{
  const f=temporaryDirectory();let native,server;let release!:()=>void;
  const blocked=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve);let closed=false;
  try {
    native=await openDatabase(f.path);await migrate(native,migrationsDirectory);const db=native;
    const delayed:LocalDatabase={
      prepare(sql:string):Statement {
        const statement=db.prepare(sql);
        if(!sql.includes('SELECT id,name,provider'))return statement;
        return {bind(...values){statement.bind(...values);return this;},first:<T>()=>statement.first<T>(),run:()=>statement.run(),async all<T>(){entered();await blocked;assert.equal(closed,false);return statement.all<T>();}};
      },batch:(statements)=>db.batch(statements),close(){closed=true;db.close();},
    };
    const c=credentials();server=await startServer(delayed,c.auth,{port:0});
    const response=api(server.url,'/api/state',c.tokens.a);
    await Promise.race([started,response.then(()=>{throw Error('request_did_not_reach_database');})]);
    const stop=server.stop();await Promise.resolve();assert.equal(closed,false);
    release();assert.equal((await response).status,200);await stop;assert.equal(closed,true);
    await assert.rejects(api(server.url,'/api/state',c.tokens.a));
  } finally {release();if(server&&!closed)await server.stop();else if(!server)native?.close();f.cleanup();}
});

test('listen failure closes the acquired database connection',{timeout:15000},async()=>{
  const f=temporaryDirectory(),occupied=createServer();let db;let server:Awaited<ReturnType<typeof startServer>>|undefined;let closed=false;
  try {
    await new Promise<void>((resolve,reject)=>{occupied.once('error',reject);occupied.listen(0,'127.0.0.1',resolve);});
    const address=occupied.address();assert.ok(address&&typeof address!=='string');
    db=await openDatabase(f.path);await migrate(db,migrationsDirectory);const native=db;
    const owned:LocalDatabase={prepare:sql=>native.prepare(sql),batch:statements=>native.batch(statements),close(){closed=true;native.close();}};
    await assert.rejects(async()=>{server=await startServer(owned,credentials().auth,{port:address.port});});
    assert.equal(closed,true);
  } finally {
    if(server)await server.stop();else if(db&&!closed)db.close();
    await new Promise<void>((resolve,reject)=>occupied.close(error=>error?reject(error):resolve()));f.cleanup();
  }
});
