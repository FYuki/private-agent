import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {executeWatch} from '../development/watch-adapter.ts';
import {cancelWatchExecution,tellWatchExecution,executionDirectory} from '../development/watch-execution.ts';
import {watchOrder} from '../development/watch-contract.ts';
import {watchAcceptanceRuns} from '../development/watch-dev-preflight.ts';
import {WatchSupervisor} from '../development/watch-supervisor.ts';
const sandbox=spawnSync('/usr/bin/bwrap',['--unshare-user','--unshare-pid','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--','/usr/bin/true'],{stdio:'ignore'}).status===0;
if(!sandbox&&process.env.REQUIRE_PID_NAMESPACE==='1')throw Error('required_pid_namespace_unavailable');
if(!sandbox){console.log(JSON.stringify({watchRuntimeSmoke:'unavailable_pid_namespace',providerExecuted:false}));process.exit(0);}
const parent=resolve(process.env.WATCH_RUNS_PARENT||'.local/w');
const dir=watchAcceptanceRuns(parent,crypto.randomUUID().slice(0,4));
await mkdir(parent,{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});
const repo=join(dir,'repo'),pkg=join(dir,'codex'),runs=dir,auth=join(dir,'fixture-auth.json');
for(const p of [repo,pkg,join(pkg,'bin')])await mkdir(p);
await writeFile(auth,'{"fixture":true}',{mode:0o600});
// 明確な失敗stub。公式watch→SDK→内側sandboxの到達だけを検証し、実モデル成功と混同しない。
await writeFile(join(pkg,'bin/codex.js'),`const {execFileSync,spawnSync}=require('node:child_process');const {writeFileSync,globSync,readlinkSync,readFileSync}=require('node:fs');
const alias=globSync('/tmp/**/clones/*').find(p=>{try{return readlinkSync(p)==='/workspace';}catch{return false;}});
if(!alias||readFileSync(alias+'/README.md','utf8')!=='synthetic')throw Error('original_cwd_alias_missing');
const head=execFileSync('/usr/bin/git',['-C','/workspace','rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(head)||spawnSync('/usr/bin/git',['-C','/workspace','update-ref','refs/heads/forbidden',head]).status===0)throw Error('snapshot_not_readonly');
writeFileSync('/workspace/review-git-verified',head);setTimeout(()=>{process.stderr.write('synthetic_provider_failure\\n');process.exitCode=7;},5000);`,{mode:0o600});
const git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@localhost',...args],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(['init','--initial-branch=epic/transport-playback']);git(['remote','add','origin','https://github.com/FYuki/local-GPT-live.git']);await writeFile(join(repo,'README.md'),'synthetic');git(['add','.']);git(['commit','-m','fixture']);
const id=crypto.randomUUID(),base=git(['rev-parse','HEAD']),order=watchOrder({id,repoId:'local-GPT-live',issue:1,requirements:'Synthetic failure fixture',acceptance:['Never call a real provider'],validation:['Host synthetic failure check'],workflow:'private-agent-child-issue',baseRef:'epic/transport-playback'});
const config={taktRuntime:resolve('runtime/takt'),taktInputs:resolve('examples/takt'),taktRuns:runs,codexPackage:pkg,authFile:auth,dependencies:resolve('node_modules'),maxProviderCalls:2,watchLimits:{callMs:10000,wallMs:60000}};
// 最初のobserverを別processで終了させ、実行が生きたまま再接続する。
const observer=join(dir,'observer.mjs');
await writeFile(observer,`import {executeWatch} from ${JSON.stringify(new URL('../development/watch-adapter.ts',import.meta.url).href)};try{await executeWatch(${JSON.stringify(config)},${JSON.stringify(repo)},${JSON.stringify(base)},'fixture',${JSON.stringify(order)},AbortSignal.timeout(500),process.hrtime.bigint()+1000000000n);throw Error('expected_detach');}catch(e){if(e.message!=='watch_observation_detached')throw e;}`);
execFileSync(process.execPath,['--import','tsx',observer],{cwd:process.cwd(),stdio:'pipe'});
for(let i=0;;i++){try{await readFile(join(runs,id,'private/activity.ndjson'));break;}catch{if(i>200)throw Error('stub_not_started');await new Promise(r=>setTimeout(r,50));}}
const actor=JSON.parse(await readFile(join(executionDirectory(config,id),'process.json'),'utf8'));
const mcpChild=async()=>{
 const children=(await readFile(`/proc/${actor.pid}/task/${actor.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean);
 for(const pid of children){try{if((await readFile('/proc/'+pid+'/cmdline','utf8')).includes('/takt/dist/app/mcp/index.js'))return Number(pid);}catch{}}
 return undefined;
};
const oldMcp=await mcpChild();assert.ok(oldMcp);process.kill(oldMcp,'SIGKILL');
for(let i=0;;i++){const pid=await mcpChild();if(pid&&pid!==oldMcp)break;if(i>100)throw Error('mcp_not_reconnected');await new Promise(r=>setTimeout(r,50));}
await tellWatchExecution(config,id,'fixture','fixture-note','Synthetic host observation: no live model is used.');
await assert.rejects(tellWatchExecution(config,id,'fixture','fixture-note','changed'),/idempotency_conflict/);
await assert.rejects(executeWatch(config,repo,base,'other',order,new AbortController().signal,process.hrtime.bigint()+1000000000n),/identity_conflict/);
await assert.rejects(executeWatch(config,repo,base,'fixture',order,new AbortController().signal,process.hrtime.bigint()+90000000000n),/watch_task_failed/);
const events=(await readFile(join(runs,id,'private/activity.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
const clones=await readdir(join(runs,id,'clones'));assert.equal(clones.length,1);assert.equal(await readFile(join(runs,id,'clones',clones[0],'review-git-verified'),'utf8'),base);
assert.ok(events.some(x=>x.event==='started'));assert.equal(events.at(-1).event,'closed');assert.equal(git(['rev-parse','HEAD']),base);
assert.equal(JSON.parse(await readFile(join(executionDirectory(config,id),'result.json'),'utf8')).error,'watch_task_failed');
// 明示取消は独立実行所有者まで届く。監視切断との区別を公式watchの実processで検証する。
const cancelled=watchOrder({...order,id:crypto.randomUUID()});
await writeFile(join(pkg,'bin/codex.js'),"setInterval(()=>{},1000);",{mode:0o600});
await assert.rejects(executeWatch(config,repo,base,'fixture',cancelled,AbortSignal.timeout(500),process.hrtime.bigint()+1000000000n),/watch_observation_detached/);
for(let i=0;;i++){try{await readFile(join(runs,cancelled.id,'private/activity.ndjson'));break;}catch{if(i>200)throw Error('cancel_stub_not_started');await new Promise(r=>setTimeout(r,50));}}
await cancelWatchExecution(config,cancelled.id,'fixture');
await assert.rejects(executeWatch(config,repo,base,'fixture',cancelled,new AbortController().signal,process.hrtime.bigint()+15000000000n),/cancelled_or_deadline/);
const supervisor=new WatchSupervisor(join(runs,cancelled.id,'supervisor.db'));
try{assert.equal(supervisor.status('fixture',join(runs,cancelled.id,'repo'))?.observed,'exited');}finally{supervisor.close();}
console.log(JSON.stringify({officialWatch:true,officialSdk:true,isolatedStubProvider:true,observerProcessExited:true,mcpProcessKilledAndReconnected:true,reconnectedWithoutResubmission:true,instructionDelivered:true,explicitCancelStopped:true,failureCollected:true,providerExecuted:false,remoteWrites:false,durableEvidenceDirectory:dir}));
