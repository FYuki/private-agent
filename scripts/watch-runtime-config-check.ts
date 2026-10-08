import {mkdtemp,mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'watch-runtime-config-'));for(const name of ['default','simple','private-agent-child-issue']){
 const output=join(dir,name);await mkdir(output);
 execFileSync(process.execPath,['development/watch-runtime-prepare.mjs',resolve('runtime/takt'),resolve('examples/takt'),output,join(dir,'clones'),name],{stdio:'pipe'});
 const compiled=JSON.parse(await readFile(join(output,'watch-compiled.json'),'utf8'));
 assert.equal(compiled.maxProviderProcesses,60);assert.deepEqual(compiled.jobResources,{'codex-sol':1});assert.ok(compiled.candidates.length>5);assert.ok(compiled.candidates.every((x:any)=>x.executed===false));
 if(name==='private-agent-child-issue'){assert.ok(compiled.references.quality);assert.ok(compiled.candidates.some((x:any)=>x.target.endsWith('/quality-review')));}
 if(name==='default'){assert.ok(compiled.references.peer);assert.ok(compiled.candidates.some((x:any)=>x.target.includes('ai-antipattern')));}
}
console.log(JSON.stringify({officialDefaultAndSimple:true,providerExecuted:false}));

// 入力原本を変えず、6.1 Sol planの許可とLuna planのD1契約不一致を検査する。
const inputs=join(dir,'inputs');await mkdir(inputs);await copyFile('examples/takt/config.yaml',join(inputs,'config.yaml'));
const original=await readFile('examples/takt/runtime.yaml','utf8');
assert.ok(original.includes('model: gpt-6-sol'),'model replacement source missing');
await writeFile(join(inputs,'runtime.yaml'),original.replace('model: gpt-6-sol','model: gpt-6.1-sol'));
const sol=join(dir,'sol61');await mkdir(sol);
execFileSync(process.execPath,['development/watch-runtime-prepare.mjs',resolve('runtime/takt'),inputs,sol,join(dir,'clones'),'default'],{stdio:'pipe'});
assert.ok(JSON.parse(await readFile(join(sol,'watch-compiled.json'),'utf8')).candidates.some((x:any)=>x.model==='gpt-6.1-sol'));
assert.ok(original.includes('plan:\n        profile: sol-xhigh'),'plan replacement source missing');
await writeFile(join(inputs,'runtime.yaml'),original.replace('plan:\n        profile: sol-xhigh','plan:\n        profile: luna-xhigh'));
const luna=join(dir,'luna');await mkdir(luna);
assert.throws(()=>execFileSync(process.execPath,['development/watch-runtime-prepare.mjs',resolve('runtime/takt'),inputs,luna,join(dir,'clones'),'default'],{stdio:'pipe'}),/plan_job_family_mismatch/);
