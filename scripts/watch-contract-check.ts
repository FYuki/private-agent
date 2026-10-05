import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {prepareWatchConfig,contractWatchProcess,verifyWatchConfig} from '../development/watch-config.ts';
import {TaktWatchClient} from '../development/takt-watch-client.ts';
import {WatchStore} from '../development/watch-store.ts';
import {WatchSupervisor} from '../development/watch-supervisor.ts';
const runtime=resolve('runtime/takt'),dir=await mkdtemp(join(tmpdir(),'private-agent-watch-contract-')),root=join(dir,'queue'),config=join(dir,'config');
await mkdir(root);await prepareWatchConfig(config);
process.env.TAKT_CONFIG_DIR=config;
const official=(path:string)=>import(pathToFileURL(join(runtime,'node_modules/takt',path)).href);
const {getBuiltinWorkflow,resolveWorkflowCallTarget}=await official('dist/infra/config/loaders/workflowLoader.js');
const workflow=getBuiltinWorkflow('default',config),core=resolveWorkflowCallTarget(workflow,workflow.steps.find((s:any)=>s.name==='develop'),config);
const peer=resolveWorkflowCallTarget(core,core.steps.find((s:any)=>s.name==='peer-review'),config);
const reviewers=resolveWorkflowCallTarget(peer,peer.steps.find((s:any)=>s.name==='initial-reviewers'),config);
const review=reviewers.steps.find((s:any)=>s.parallel);
assert.equal(review.parallel.kind,'dynamic');assert.ok(review.parallel.fixed.length>0);assert.ok(review.parallel.pool.length>1);
assert.equal(peer.steps.find((s:any)=>s.name==='final-gate').rules[0].condition.label,'APPROVE');
const store=new WatchStore(join(dir,'state.db')),client=await TaktWatchClient.connect(runtime,root,config);
try{
 const id='00000000-0000-4000-8000-000000000011';
 store.submit('fixture',{id,repoId:'local-GPT-live',issue:1,requirements:'Synthetic contract fixture. Never execute this task.',acceptance:['Queue identity can be read'],validation:['No model call'],baseRef:'epic/transport-playback'});
 const first=await store.dispatch('fixture',id,'local-GPT-live',client),again=await store.dispatch('fixture',id,'local-GPT-live',client);
 assert.throws(()=>client.tell('../foreign','evidence'),/invalid_run_instruction/);
 assert.throws(()=>client.tell('missing',' '),/invalid_run_instruction/);
 assert.throws(()=>client.tell('missing','x'.repeat(8193)),/invalid_run_instruction/);
 await assert.rejects(client.tell('missing','Host fixture only'),/takt_mcp_result_rejected/);
 assert.equal(first.task_name,again.task_name);assert.equal((await client.list()).length,1);assert.equal(first.state,'enqueued');
 const yaml=await import(pathToFileURL(join(runtime,'node_modules/yaml/dist/index.js')).href);
 const tasks=yaml.parse(await readFile(join(root,'.takt/tasks.yaml'),'utf8'));
 const encoded=JSON.stringify(tasks);assert.match(encoded,/"workflow":"default"/);assert.match(encoded,/"auto_pr":false/);assert.match(encoded,/"worktree":true/);assert.match(encoded,/epic\/transport-playback/);
}finally{await client.close();store.close();}
// enqueue試験のrootへwatchを起動しない。別の空repoで起動・停止だけを確認する。
const idle=join(dir,'idle');await mkdir(idle);
const init=spawnSync('/usr/bin/git',['init','--initial-branch=epic/transport-playback',idle],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:config}});assert.equal(init.status,0);
const supervisor=new WatchSupervisor(join(dir,'supervisor.db'));
const sandboxAvailable=spawnSync('/usr/bin/bwrap',['--unshare-user','--unshare-pid','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--','/usr/bin/true'],{stdio:'ignore'}).status===0;
const spec=sandboxAvailable?await contractWatchProcess(runtime,idle,config):{file:process.execPath,args:[join(runtime,'node_modules/takt/dist/app/cli/index.js'),'watch'],cwd:idle,env:{PATH:'/usr/bin:/bin',HOME:config,TAKT_CONFIG_DIR:config,LANG:'C.UTF-8',TAKT_NO_TTY:'1',NO_UPDATE_NOTIFIER:'1'}};
try{
 await supervisor.start('fixture',spec);
 // 公式watchが空queue管理ディレクトリを生成するまで待つ。任意の既存serviceには接続しない。
 for(let i=0;i<100;i++){
  if(supervisor.status('fixture',idle)?.observed!=='alive')throw Error('official_watch_exited');
  try{await readFile(join(idle,'.takt/tasks.yaml'));break;}catch{}
  await new Promise(r=>setTimeout(r,20));
 }
 assert.equal(supervisor.status('fixture',idle)?.observed,'alive');
 if(sandboxAvailable)assert.equal((await supervisor.stop('fixture',idle,10000))?.observed,'exited');
 else await assert.rejects(supervisor.stop('fixture',idle,10000),/watch_stop_unconfirmed/);
}finally{supervisor.close();}
await writeFile(join(config,'config.yaml'),'branch_name_strategy: ai\nauto_pr: false\nconcurrency: 1\nauto_requeue_max_attempts: 0\n');
await assert.rejects(verifyWatchConfig(runtime,root,config),/unsafe_watch_config/);
console.log(JSON.stringify({officialMcpEnqueue:true,deduplicated:true,defaultDynamicReviewPool:review.parallel.pool.length,fixedReviewers:review.parallel.fixed.length,watchStart:true,watchStopConfirmed:sandboxAvailable,pidNamespace:sandboxAvailable,providerExecuted:false,productionActivated:false}));
