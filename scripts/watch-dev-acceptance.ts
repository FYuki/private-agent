import {watchHeartbeat} from '../development/watch-heartbeat.ts';
// 明示的なdev専用入口。通常runnerのwatchガードを変更しない。新規のSQLite/合成Gitだけを使用する。
import {mkdir,writeFile,readFile,copyFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {DevelopmentClient} from '../development/client.ts';
import {client} from '../wsl-worker/main.ts';
import type {Run} from '../shared/contracts.ts';
import {WatchSupervisor} from '../development/watch-supervisor.ts';
import {executeWatch} from '../development/watch-adapter.ts';
import {saveArtifact,finishArtifact} from '../development/artifacts.ts';
import {fingerprint,operation,type Ledger} from '../development/operations.ts';
import {sandboxArgs} from '../development/sandbox.ts';
import {processOutput} from '../development/process.ts';
import {cancelWatchExecution,watchExecutionSettled} from '../development/watch-execution.ts';
import {watchAcceptanceRuns,verifyAcceptanceRuntime} from '../development/watch-dev-preflight.ts';
import {SqliteDatabase} from '../control-plane/sqlite.ts';
import {migrate} from '../control-plane/migrations.ts';
import {startServer} from '../control-plane/server.ts';
// @ts-ignore dependency-free provider settlement boundary
import {verifyProviderSettlement} from '../development/watch-provider-budget.mjs';
const stub=process.argv.includes('--stub-provider');
if(stub&&process.argv.includes('--live-authorized'))throw Error('ambiguous_acceptance_mode');
if(!stub&&!process.argv.includes('--live-authorized'))throw Error('explicit_live_authorization_required');
const tag=process.env.WATCH_ACCEPTANCE_ID;if(!tag||!/^[a-z0-9-]{1,60}$/.test(tag))throw Error('explicit_unique_acceptance_id_required');
const maxCli=stub?2:Number(process.env.WATCH_MAX_CLI),budgetMs=stub?90000:Number(process.env.WATCH_BUDGET_MS);
if(!Number.isSafeInteger(maxCli)||maxCli<1||maxCli>60||!Number.isSafeInteger(budgetMs)||budgetMs<60000||budgetMs>3600000)throw Error('explicit_bounded_live_budget_required');
const runParent=resolve(process.env.WATCH_RUNS_PARENT||'.local/w');
const runs=watchAcceptanceRuns(runParent,crypto.randomUUID().slice(0,4));
const source=resolve('.local/adapter-v3/tests/takt-watch/fixtures/live-isolated-runtime.yaml');
const runtimeBytes=await readFile(source),inputHash=verifyAcceptanceRuntime(runtimeBytes);
if(!stub&&(!process.env.CODEX_PACKAGE||!process.env.CODEX_AUTH_FILE))throw Error('explicit_codex_paths_required');
await mkdir(resolve('.local/watch-acceptance'),{recursive:true,mode:0o700});
const root=resolve('.local/watch-acceptance',tag);await mkdir(root,{mode:0o700}); // 既存IDは再実行しない。
const dbPath=join(root,'control.sqlite');
let repo=join(root,'repo');
await mkdir(runParent,{recursive:true,mode:0o700});
const input=join(root,'inputs'),artifacts=join(root,'artifacts');
await mkdir(runs,{mode:0o700}); // 短く永続するWSL native path。衝突時は上書きしない。
await writeFile(join(root,'run-location.json'),JSON.stringify({runs,dbPath}));
for(const p of [input,repo,artifacts,join(repo,'shared'),join(repo,'tests'),join(repo,'node_modules')])await mkdir(p,{mode:0o700});
await copyFile('examples/takt/config.yaml',join(input,'config.yaml'));await writeFile(join(input,'runtime.yaml'),runtimeBytes);
if(stub){
 await mkdir(join(root,'stub/bin'),{recursive:true,mode:0o700});
 await writeFile(join(root,'stub/bin/codex.js'),"if(process.argv.slice(2).join(' ')==='login status'){process.stdout.write('synthetic login\\n');}else{process.stderr.write('synthetic_provider_failure\\n');process.exitCode=7;}");
 await writeFile(join(root,'stub-auth.json'),'{"fixture":true}',{mode:0o600});
}
const config={taktRuntime:resolve('runtime/takt'),taktInputs:input,taktRuns:runs,codexPackage:await realpath(stub?join(root,'stub'):process.env.CODEX_PACKAGE!),authFile:await realpath(stub?join(root,'stub-auth.json'):process.env.CODEX_AUTH_FILE!),dependencies:resolve('node_modules'),maxProviderCalls:maxCli,watchLimits:{callMs:300000,wallMs:budgetMs}};
const stop=new AbortController(),deadline=process.hrtime.bigint()+BigInt(budgetMs)*1000000n;
const command=(file:string,args:string[],cwd=repo)=>processOutput(file,args,cwd,'',stop.signal,deadline,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
const git=(args:string[])=>command('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Acceptance','-c','user.email=acceptance@localhost',...args]);
await writeFile(join(repo,'package.json'),JSON.stringify({private:true,type:'module',scripts:{check:'node --check shared/greeting.js',test:'node --test tests/greeting.test.js'}}));
await writeFile(join(repo,'.gitignore'),'.takt/\nnode_modules/\n');
await writeFile(join(repo,'shared/greeting.js'),'export function greeting(name) { return `Hello, ${name}`; }\n');
await writeFile(join(repo,'tests/greeting.test.js'),"import {test} from 'node:test';import assert from 'node:assert/strict';import {greeting} from '../shared/greeting.js';test('named',()=>assert.equal(greeting('Ada'),'Hello, Ada'));\n");
await git(['init','--initial-branch=epic/development-runner']);await git(['remote','add','origin','https://github.com/FYuki/private-agent.git']);await git(['add','.']);await git(['commit','-m','Synthetic acceptance baseline']);
const baseSha=(await git(['rev-parse','HEAD'])).trim();
const checkout=join(root,'worktree');await git(['worktree','add','--detach',checkout,baseSha]);repo=checkout;await mkdir(join(repo,'node_modules'));
// ログイン状態と制限sandboxをモデル起動前に検証（認証本文・生応答は出さない）。
await command('/usr/bin/bwrap',sandboxArgs(config,repo,'plan',['/usr/bin/node','/opt/codex/bin/codex.js','login','status']));
const prepared=join(root,'compiled');await mkdir(prepared);await command(process.execPath,['development/watch-runtime-prepare.mjs',config.taktRuntime,input,prepared,join(root,'clones'),'default'],process.cwd());
const compiled=JSON.parse(await readFile(join(prepared,'watch-compiled.json'),'utf8'));assert.ok(compiled.candidates.some((x:any)=>x.model==='gpt-6.1-sol'));assert.deepEqual(compiled.jobResources,{'codex-sol':1});
const tokens={viewer:Buffer.from(randomBytes(32)).toString('base64url'),worker:Buffer.from(randomBytes(32)).toString('base64url')};
const auth=Object.entries(tokens).map(([id,token])=>({id,role:id,owner:'local',group:'local',hash:createHash('sha256').update(token).digest('hex')}));
const db=new SqliteDatabase(dbPath);
try{await migrate(db,resolve('control-plane/migrations'));}catch(error){db.close();throw error;}
const server=await startServer({db,authJson:JSON.stringify(auth),limits:{models:{'codex-sol':1,'codex-luna':0,'pi-swe2':0},groups:{local:1}},host:'127.0.0.1',port:0,watchAcceptanceEnabled:true});
const base=server.url+'/';
const viewer=new DevelopmentClient(base,tokens.viewer,{allowWatchTest:true}),api=client(base,tokens.worker);let run:Run|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
try{
 await viewer.profiles();
 assert.equal((await fetch(base+'api/state')).status,401);
 const goal='Change only shared/greeting.js and tests/greeting.test.js. greeting(name) must trim whitespace around a non-empty string name and return Hello, <trimmed name>. For missing, empty or whitespace-only name return Hello, world. Preserve named greetings. Add focused node:test tests for these cases. No dependencies or external communication. Host runs npm run check and npm test. Local commits are owned by official TAKT; never push or create PRs.';
 const spec={repoId:'private-agent',baseRef:'epic/development-runner',goal,acceptanceCriteria:['Named greeting remains compatible.','Whitespace is trimmed.','Missing, empty and whitespace-only names use world.','Only the two allowed JavaScript files change and tests pass.'],executionProfileId:'takt-watch',budgetMs,watch:{issue:1,workflow:'default',validation:['npm run check','npm test']}};
 const {id}=await viewer.submit(spec,tag);assert.equal((await viewer.submit(spec,tag)).id,id);
 await api('/api/development/runner-heartbeat',{available:true,executionProfile:'takt-watch'});
 run=await api('/api/claim',{protocol:'development-v1',taskKind:'development',provider:'codex-luna',executionProfile:'takt-watch'}) as Run;assert.equal(run.job_id,id);
 await git(['switch','-c','feature/development-task-'+id]);
 const leased=run,tick=watchHeartbeat(async()=>await api('/api/runs/'+leased.id+'/heartbeat',{token:leased.token}) as {cancelRequested?:boolean},()=>cancelWatchExecution(config,leased.job_id,'local'),phase=>console.error(JSON.stringify({phase:phase+'_retry_pending'})));
 heartbeat=setInterval(()=>{void tick();},10000);
 const ledger:Ledger=(name,fingerprint,result)=>api('/api/development/tasks/'+id+'/operation',{token:leased.token,name,fingerprint,...(result===undefined?{}:{result})}) as ReturnType<Ledger>;
 await writeFile(join(root,'request.json'),JSON.stringify({id,spec,inputHash,budgetMs,maxCli,callWallMs:300000,dbPath,stub,publication:false},null,2),{mode:0o600});
 console.log(JSON.stringify({phase:'claimed',id,jobResources:compiled.jobResources,inputHash,budgetMs,maxCli,callWallMs:300000,stub,publication:false}));
 let executionError='';
 const executed=await operation(ledger,'takt',{baseSha,spec,inputHash},async()=>{try{return await executeWatch(config,repo,baseSha,'local',{id,repoId:'private-agent',issue:1,dependencies:[],requirements:goal,acceptance:spec.acceptanceCriteria,validation:spec.watch.validation,workflow:'default',baseRef:spec.baseRef},stop.signal,deadline);}catch(e){executionError=(e as Error).message;throw e;}}).catch(e=>{throw Error(executionError||e.message);});
 await operation(ledger,'test',{headSha:executed.headSha},async()=>{
  const paths=new Set<string>();
  for(const commit of executed.commitRange.commits)for(const path of (await git(['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',commit])).split('\0').filter(Boolean))paths.add(path);
  assert.deepEqual([...paths].sort(),['shared/greeting.js','tests/greeting.test.js']);
  for(const args of [['/usr/bin/npm','run','check'],['/usr/bin/npm','test'],['/usr/bin/node','--input-type=module','-e',"import assert from 'node:assert/strict';import {greeting} from './shared/greeting.js';for(const [x,y] of [['Ada','Hello, Ada'],[' Ada ','Hello, Ada'],[undefined,'Hello, world'],['','Hello, world'],['  ','Hello, world']])assert.equal(greeting(x),y);"]])await command('/usr/bin/bwrap',sandboxArgs(config,repo,'test',args));return {passed:true,independentAssertions:5};
 });
 const contentHash=fingerprint(await git(['diff',baseSha,executed.headSha]));
 const artifact=await operation(ledger,'artifact',{id,head:executed.headSha},()=>saveArtifact(artifacts,{version:1,taskId:id,owner:'local',repoId:'private-agent',baseRef:spec.baseRef,baseSha,headSha:executed.headSha,branch:'feature/development-task-'+id,contentHash,validation:'private-agent-v1',checks:[['/usr/bin/npm','run','check'],['/usr/bin/npm','run','test']],mode:'local_only',execution:{manifestHash:executed.manifestHash,inputHash},commitRange:executed.commitRange}));
 const result=await finishArtifact(artifact,'local_only',async()=>{throw Error('publication_forbidden');});
 await api('/api/runs/'+leased.id+'/complete',{token:leased.token,result:JSON.stringify({...result,review:'pending'}),error:null});
 await api('/api/runs/'+leased.id+'/complete',{token:leased.token,result:JSON.stringify({...result,review:'pending'}),error:null});
 const status=await viewer.status(id);assert.equal(status.state,'succeeded');assert.equal(createHash('sha256').update(await readFile(join(input,'runtime.yaml'))).digest('hex'),inputHash);
 await writeFile(join(root,'evidence.json'),JSON.stringify({state:status.state,task:id,baseSha,headSha:executed.headSha,artifactId:artifact.artifactId,inputHash,operations:status.operations,independentAssertions:5,publication:false,normalRunnerEnabled:false},null,2));
 console.log(JSON.stringify({phase:'succeeded',task:id,artifactId:artifact.artifactId}));
}catch(e){
 const error=(e as Error).message;await writeFile(join(root,'failure.json'),JSON.stringify({error,task:run?.job_id,inputHash,modelSuccess:false}));
 if(run&&await watchExecutionSettled(config,run.job_id,'local'))await api('/api/runs/'+run.id+'/complete',{token:run.token,result:null,error:'operation_blocked'}).catch(()=>{});
 throw e;
}finally{
 clearInterval(heartbeat);stop.abort();
 // /tmp消失や親session終了より前に、必ず永続rootへ終了メタデータを記録する。
 try{
 let provider:{starts?:number;closed?:number;unconfirmed?:number;missing?:boolean;settled?:boolean}={missing:true},watch:{state?:string;observed?:string}={};
 if(run){
  const owned=join(runs,run.job_id);
  try{const events=(await readFile(join(owned,'private/activity.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));provider={starts:events.filter(x=>x.event==='started').length,closed:events.filter(x=>x.event==='closed').length,unconfirmed:events.filter(x=>x.event==='stop_unconfirmed').length,settled:false};verifyProviderSettlement(events,maxCli);provider.settled=true;}catch{}
  try{const supervisor=new WatchSupervisor(join(owned,'supervisor.db'));try{const row=supervisor.status('local',join(owned,'repo'));watch={state:row?.state,observed:row?.observed};}finally{supervisor.close();}}catch{}
 }
 const status=run?await viewer.status(run.job_id).catch(()=>null):null;
 await writeFile(join(root,'settlement.json'),JSON.stringify({task:run?.job_id,runs,dbPath,provider,watch,state:status?.state??null,stub,inputUnchanged:createHash('sha256').update(await readFile(join(input,'runtime.yaml'))).digest('hex')===inputHash},null,2),{mode:0o600});
 }finally{
 await server.stop();
 await writeFile(join(root,'server.log'),JSON.stringify({dbPath,stopped:true}),{mode:0o600});
 }
}
