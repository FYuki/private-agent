import test from 'node:test';
import assert from 'node:assert/strict';
import {developmentOnce} from '../development/runner.ts';
test('paused watch runtime cannot claim a D1 lease or launch a provider',async()=>{
 let calls=0;const api=async()=>{calls++;throw Error('must_not_call');};
 await assert.rejects(developmentOnce(api,{repository:'/unused',worktrees:'/unused',codexPackage:'/unused',authFile:'/unused',dependencies:'/unused',publishAuthorized:false,watchEnabled:true},new AbortController().signal),/watch_runtime_validation_pending/);
 assert.equal(calls,0);
});
