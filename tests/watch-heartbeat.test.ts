import test from 'node:test';
import assert from 'node:assert/strict';
import {watchHeartbeat} from '../development/watch-heartbeat.ts';
test('heartbeat communication failure retries without sending cancellation',async()=>{
 let calls=0,cancelled=0;const errors:string[]=[];
 const tick=watchHeartbeat(async()=>{if(++calls===1)throw Error('offline');return {};},async()=>{cancelled++;},phase=>errors.push(phase));
 await tick();await tick();assert.equal(calls,2);assert.equal(cancelled,0);assert.deepEqual(errors,['heartbeat']);
});
test('failed explicit cancellation delivery is retried even while heartbeat is unavailable',async()=>{
 let calls=0,cancelled=0;const errors:string[]=[];
 const tick=watchHeartbeat(async()=>{if(++calls>1)throw Error('offline');return {cancelRequested:true};},async()=>{if(++cancelled===1)throw Error('not_ready');},phase=>errors.push(phase));
 await tick();await tick();await tick();assert.equal(cancelled,2);assert.deepEqual(errors,['cancel','heartbeat','heartbeat']);
});
