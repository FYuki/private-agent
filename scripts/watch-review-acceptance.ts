// 明示的な受入入口。通常profileは実モデル受入まで閉じたまま、既存runner全体を通す。
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {selectRepository,preflightRepository} from '../development/repositories.ts';
import {verifyRepositoryMetadata} from '../development/publisher.ts';
import {repositoryPolicy} from '../shared/repositories.ts';
import {randomBytes,createHash} from 'node:crypto';
import {SqliteDatabase} from '../control-plane/sqlite.ts';
import {migrate} from '../control-plane/migrations.ts';
import {startServer} from '../control-plane/server.ts';
import {DevelopmentClient} from '../development/client.ts';
import {developmentOnce,type DevelopmentRunnerConfig} from '../development/runner.ts';
import {client} from '../wsl-worker/main.ts';
import {developmentInput} from '../shared/development.ts';
import {validateWatchStorage} from '../development/watch-adapter.ts';

if(process.argv.length!==5||process.argv[2]!=='--live-authorized')throw Error('usage: --live-authorized <private-config.json> <state-directory>');
const input=JSON.parse(await readFile(resolve(process.argv[3]),'utf8'));
const spec=developmentInput(input.task,{allowWatchTest:true});
if(spec.executionProfileId!=='takt-watch'||spec.watch?.workflow!=='private-agent-child-issue')throw Error('mandatory_review_workflow_required');
const config:DevelopmentRunnerConfig={...input.runner,watchEnabled:true,watchAcceptanceEnabled:true};
if(!config.takt)throw Error('takt_configuration_required');
validateWatchStorage(join(config.takt.taktRuns,'00000000-0000-4000-8000-000000000000','clones'));
// 起動前に判定できる配置/公開先の不一致でclaimを消費しない。
const binding=selectRepository(config.registry??[{repoId:'private-agent',root:config.repository,worktrees:config.worktrees,owners:['local'],visibility:config.repositoryVisibility??'private',publishAuthorized:config.publishAuthorized}],spec.repoId,'local');
await preflightRepository(binding);
const policy=repositoryPolicy(spec.repoId);
verifyRepositoryMetadata(JSON.parse(execFileSync('/usr/bin/gh',['api','repos/'+policy.github],{encoding:'utf8'})),binding.visibility,policy.githubId,binding.publishAuthorized);
const state=resolve(process.argv[4]);await mkdir(state,{recursive:true,mode:0o700});
if(await realpath(state)!==state)throw Error('untrusted_state_path');
await mkdir(config.takt.taktRuns,{recursive:true,mode:0o700});
const identityFile=join(state,'identity.json'),identity={input,tokens:{viewer:randomBytes(32).toString('base64url'),worker:randomBytes(32).toString('base64url')}};
let saved=identity;
try{await writeFile(identityFile,JSON.stringify(identity),{mode:0o600,flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;saved=JSON.parse(await readFile(identityFile,'utf8'));if(JSON.stringify(saved.input)!==JSON.stringify(input))throw Error('acceptance_identity_conflict');}
const auth=Object.entries(saved.tokens).map(([id,token])=>({id,role:id,owner:'local',group:'local',hash:createHash('sha256').update(token).digest('hex')}));
const db=new SqliteDatabase(join(state,'control.db'));await migrate(db,resolve('control-plane/migrations'));
const server=await startServer({db,authJson:JSON.stringify(auth),limits:{models:{'codex-sol':1,'codex-luna':0,'pi-swe2':0},groups:{local:1}},host:'127.0.0.1',port:0,watchAcceptanceEnabled:true});
const viewer=new DevelopmentClient(server.url+'/',saved.tokens.viewer,{allowWatchTest:true}),api=client(server.url+'/',saved.tokens.worker);
const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
try{
 const {id}=await viewer.submit(spec,'watch-review-acceptance');
 console.log(JSON.stringify({phase:'submitted',id,state,publication:config.publishAuthorized}));
 await api('/api/development/runner-heartbeat',{available:true,executionProfile:'takt-watch'});
 const before=await viewer.status(id);
 if(!['succeeded','failed','cancelled'].includes(before.state))await developmentOnce(api,config,stop.signal);
 const status=await viewer.status(id);
 const evidence={task:id,state:status.state,result:status.result,error:status.error,operations:status.operations};
 await writeFile(join(state,'evidence.json'),JSON.stringify(evidence,null,2),{mode:0o600});
 console.log(JSON.stringify(evidence));
 if(status.state!=='succeeded')process.exitCode=1;
}finally{await server.stop();}
