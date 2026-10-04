import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processOutput,finalMessage } from '../development/process.ts';
test('development subprocess cancellation waits for close and stops child writes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'development-cancel-')),file=join(directory,'marker');const abort=new AbortController();
 try{const pending=processOutput(process.execPath,['-e',`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(file)},'x'),10);`],directory,'',abort.signal,process.hrtime.bigint()+3000000000n,{PATH:process.env.PATH});const outcome=assert.rejects(pending,/cancelled/);
 for(let n=0;n<100;n++){try{await readFile(file);break;}catch{await new Promise(r=>setTimeout(r,10));}}
 abort.abort();await outcome;const before=await readFile(file,'utf8');await new Promise(r=>setTimeout(r,100));assert.equal(await readFile(file,'utf8'),before);
 }finally{abort.abort();await rm(directory,{recursive:true,force:true});}
});
test('development model output requires a completed bounded final answer',()=>{
 assert.equal(finalMessage('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed"}'),'done');
 assert.throws(()=>finalMessage('{"type":"turn.completed"}'),/invalid/);assert.throws(()=>finalMessage('{"type":"turn.failed"}'),/model_failed/);
});
