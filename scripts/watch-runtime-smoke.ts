import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {executeWatch} from '../development/watch-adapter.ts';
import {watchOrder} from '../development/watch-contract.ts';
const sandbox=spawnSync('/usr/bin/bwrap',['--unshare-user','--unshare-pid','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--','/usr/bin/true'],{stdio:'ignore'}).status===0;
if(!sandbox){console.log(JSON.stringify({watchRuntimeSmoke:'unavailable_pid_namespace',providerExecuted:false}));process.exit(0);}
await mkdir(resolve('.local/w'),{recursive:true,mode:0o700});
const dir=resolve('.local/w',crypto.randomUUID().slice(0,4));await mkdir(dir,{mode:0o700});
const repo=join(dir,'repo'),pkg=join(dir,'codex'),runs=join(dir,'r'),auth=join(dir,'fixture-auth.json');
for(const p of [repo,pkg,runs,join(pkg,'bin')])await mkdir(p);
await writeFile(auth,'{"fixture":true}',{mode:0o600});
// 明確な失敗stub。公式watch→SDK→内側sandboxの到達だけを検証し、実モデル成功と混同しない。
await writeFile(join(pkg,'bin/codex.js'),"process.stderr.write('synthetic_provider_failure\\n');process.exitCode=7;",{mode:0o600});
const git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@localhost',...args],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(['init','--initial-branch=epic/transport-playback']);git(['remote','add','origin','https://github.com/FYuki/local-GPT-live.git']);await writeFile(join(repo,'README.md'),'synthetic');git(['add','.']);git(['commit','-m','fixture']);
const id=crypto.randomUUID(),base=git(['rev-parse','HEAD']),order=watchOrder({id,repoId:'local-GPT-live',issue:1,requirements:'Synthetic failure fixture',acceptance:['Never call a real provider'],validation:['Host synthetic failure check'],workflow:'simple',baseRef:'epic/transport-playback'});
await assert.rejects(executeWatch({taktRuntime:resolve('runtime/takt'),taktInputs:resolve('examples/takt'),taktRuns:runs,codexPackage:pkg,authFile:auth,dependencies:resolve('node_modules'),maxProviderCalls:2},repo,base,'fixture',order,new AbortController().signal,process.hrtime.bigint()+90000000000n),/watch_task_failed/);
const events=(await readFile(join(runs,id,'private/activity.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
assert.ok(events.some(x=>x.event==='started'));assert.equal(events.at(-1).event,'closed');assert.equal(git(['rev-parse','HEAD']),base);
console.log(JSON.stringify({officialWatch:true,officialSdk:true,isolatedStubProvider:true,failureCollected:true,providerExecuted:false,remoteWrites:false,durableEvidenceDirectory:dir}));
