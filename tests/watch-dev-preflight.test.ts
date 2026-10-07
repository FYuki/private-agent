import test from 'node:test';
import assert from 'node:assert/strict';
import {watchAcceptanceRuns,verifyAcceptanceRuntime} from '../development/watch-dev-preflight.ts';

test('long T3 checkout requires an explicit short persistent run parent before setup',()=>{
 const parent='/home/test-user/.t3/worktrees/private-agent/fix-takt-watch-acceptance-20261007/.local/w';
 assert.throws(()=>watchAcceptanceRuns(parent,'abcd'),/watch_storage_path_too_long/);
 assert.equal(watchAcceptanceRuns('/home/test-user/.local/paw','abcd'),'/home/test-user/.local/paw/abcd');
 assert.throws(()=>watchAcceptanceRuns('/home/test-user/.local/paw','../other'),/invalid_run_leaf/);
});

test('runtime input must match the reviewed v3 bytes, not merely contain a plan candidate',()=>{
 assert.throws(()=>verifyAcceptanceRuntime(Buffer.from('version: 1\n')),/acceptance_runtime_hash_mismatch/);
});
