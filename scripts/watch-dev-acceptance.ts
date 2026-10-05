// 明示的なdev専用入口。通常runnerのwatchガードを変更しない。新規のローカルD1/合成Gitだけを使用する。
import {mkdtemp,mkdir,writeFile,readFile,copyFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {DevelopmentClient} from '../development/client.ts';
import {client} from '../wsl-worker/main.ts';
import type {Run} from '../shared/contracts.ts';
import {executeWatch} from '../development/watch-adapter.ts';
import {saveArtifact,finishArtifact} from '../development/artifacts.ts';
import {fingerprint,operation,type Ledger} from '../development/operations.ts';
import {sandboxArgs} from '../development/sandbox.ts';
import {processOutput} from '../development/process.ts';
if(!process.argv.includes('--live-authorized'))throw Error('explicit_live_authorization_required');
const tag=process.env.WATCH_ACCEPTANCE_ID;if(!tag||!/^[a-z0-9-]{1,60}$/.test(tag))throw Error('explicit_unique_acceptance_id_required');
await mkdir(resolve('.local/watch-acceptance'),{recursive:true,mode:0o700});
const root=resolve('.local/watch-acceptance',tag);await mkdir(root,{mode:0o700}); // 既存IDは再実行しない。
const source=resolve('.local/adapter-v3/tests/takt-watch/fixtures/live-isolated-runtime.yaml');
let repo=join(root,'repo');
const input=join(root,'inputs'),runs=await mkdtemp('/tmp/paw-'),artifacts=join(root,'artifacts');
await writeFile(join(root,'run-location.json'),JSON.stringify({runs}));
for(const p of [input,repo,artifacts,join(repo,'shared'),join(repo,'tests'),join(repo,'node_modules')])await mkdir(p,{mode:0o700});
await copyFile('examples/takt/config.yaml',join(input,'config.yaml'));await copyFile(source,join(input,'runtime.yaml'));
const inputHash=createHash('sha256').update(await readFile(source)).digest('hex');
const config={taktRuntime:resolve('runtime/takt'),taktInputs:input,taktRuns:runs,codexPackage:await realpath(process.env.CODEX_PACKAGE||''),authFile:await realpath(process.env.CODEX_AUTH_FILE||''),dependencies:resolve('node_modules'),maxProviderCalls:59};
const stop=new AbortController(),deadline=process.hrtime.bigint()+3420000000000n;
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
const wrangler=JSON.parse(await readFile('wrangler.jsonc','utf8'));wrangler.main=resolve('control-plane/index.ts');wrangler.vars.LIMITS_JSON=JSON.stringify({models:{'codex-sol':1,'codex-luna':0,'pi-swe2':0},groups:{local:1}});wrangler.d1_databases[0].migrations_dir=resolve('control-plane/migrations');
await writeFile(join(root,'wrangler.json'),JSON.stringify(wrangler));await writeFile(join(root,'.dev.vars'),"AUTH_JSON='"+JSON.stringify(auth)+"'\n",{mode:0o600});
const cli=resolve('node_modules/wrangler/bin/wrangler.js'),common=['--config',join(root,'wrangler.json')],persist=join(root,'d1');
execFileSync(process.execPath,[cli,'d1','migrations','apply','private-agent-local','--local','--persist-to',persist,...common],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:'pipe'});
const port=18797,base='http://127.0.0.1:'+port+'/';
const server=spawn(process.execPath,[cli,'dev','--local','--ip','127.0.0.1','--port',String(port),'--persist-to',persist,...common],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe'],detached:true});
let output='';server.stdout.on('data',b=>{output=(output+b).slice(-20000);});server.stderr.on('data',b=>{output=(output+b).slice(-20000);});
const viewer=new DevelopmentClient(base,tokens.viewer),api=client(base,tokens.worker);let run:Run|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
try{
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('dev_server_exit');try{await viewer.profiles();break;}catch{if(i===99)throw Error('dev_server_unavailable');await new Promise(r=>setTimeout(r,200));}}
 assert.equal((await fetch(base+'api/state')).status,401);
 const goal='Change only shared/greeting.js and tests/greeting.test.js. greeting(name) must trim whitespace around a non-empty string name and return Hello, <trimmed name>. For missing, empty or whitespace-only name return Hello, world. Preserve named greetings. Add focused node:test tests for these cases. No dependencies or external communication. Host runs npm run check and npm test. Local commits are owned by official TAKT; never push or create PRs.';
 const spec={repoId:'private-agent',baseRef:'epic/development-runner',goal,acceptanceCriteria:['Named greeting remains compatible.','Whitespace is trimmed.','Missing, empty and whitespace-only names use world.','Only the two allowed JavaScript files change and tests pass.'],executionProfileId:'takt-watch',budgetMs:3420000,watch:{issue:1,workflow:'default',validation:['npm run check','npm test']}};
 const {id}=await viewer.submit(spec,tag);assert.equal((await viewer.submit(spec,tag)).id,id);
 await api('/api/development/runner-heartbeat',{available:true,executionProfile:'takt-watch'});
 run=await api('/api/claim',{protocol:'development-v1',taskKind:'development',provider:'codex-luna',executionProfile:'takt-watch'}) as Run;assert.equal(run.job_id,id);
 await git(['switch','-c','feature/development-task-'+id]);
 const leased=run;heartbeat=setInterval(()=>{void api('/api/runs/'+leased.id+'/heartbeat',{token:leased.token}).catch(()=>stop.abort());},10000);
 const ledger:Ledger=(name,fingerprint,result)=>api('/api/development/tasks/'+id+'/operation',{token:leased.token,name,fingerprint,...(result===undefined?{}:{result})}) as ReturnType<Ledger>;
 console.log(JSON.stringify({phase:'claimed',id,jobResources:compiled.jobResources,inputHash,budgetMs:3420000,maxCli:59,callWallMs:300000,publication:false}));
 let executionError='';
 const executed=await operation(ledger,'takt',{baseSha,spec,inputHash},async()=>{try{return await executeWatch(config,repo,baseSha,'local',{id,repoId:'private-agent',issue:1,dependencies:[],requirements:goal,acceptance:spec.acceptanceCriteria,validation:spec.watch.validation,workflow:'default',baseRef:spec.baseRef},stop.signal,deadline);}catch(e){executionError=(e as Error).message;throw e;}}).catch(e=>{throw Error(executionError||e.message);});
 await operation(ledger,'test',{headSha:executed.headSha},async()=>{
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
 if(run&&!['watch_stop_unconfirmed','provider_stop_unconfirmed'].includes(error))await api('/api/runs/'+run.id+'/complete',{token:run.token,result:null,error:'operation_blocked'}).catch(()=>{});
 throw e;
}finally{
 clearInterval(heartbeat);stop.abort();try{process.kill(-server.pid!,'SIGTERM');}catch{}
 await writeFile(join(root,'server.log'),output,{mode:0o600});
}
