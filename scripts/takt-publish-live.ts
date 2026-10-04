import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {repositoryBindings,preflightRepository} from '../development/repositories.ts';
import assert from 'node:assert/strict';
import {DevelopmentClient} from '../development/client.ts';
import {client} from '../wsl-worker/main.ts';
import {developmentOnce} from '../development/runner.ts';
if(!process.argv.includes('--publish-authorized'))throw Error('explicit_publication_authorization_required');
const visibility=process.env.DEVELOPMENT_REPOSITORY_VISIBILITY||'private';
if(visibility!=='private'&&visibility!=='public')throw Error('invalid_repository_visibility');
const worktrees=process.env.DEVELOPMENT_WORKTREES;
if(!worktrees)throw Error('explicit_disjoint_worktrees_required');
const [binding]=repositoryBindings([{repoId:'private-agent',root:process.cwd(),worktrees,owners:['local'],visibility:process.env.DEVELOPMENT_REPOSITORY_VISIBILITY||'private',publishAuthorized:true}]);
await preflightRepository(binding);
const tokens=JSON.parse(await readFile('.local/tokens.json','utf8')),base=process.env.CONTROL_URL||'http://127.0.0.1:8799/';
const viewer=new DevelopmentClient(base,tokens.viewer),worker=client(base,tokens.worker);
for(const dir of ['.local/takt-runs','.local/evidence'])await mkdir(dir,{recursive:true,mode:0o700});
const {id}=await viewer.submit({repoId:'private-agent',baseRef:'epic/development-runner',orchestratorProfileId:'programmatic',executionProfileId:'takt-simple',budgetMs:1800000,
 goal:'Small isolated synthetic acceptance task. Create tests/fixtures/takt-greeting.ts exporting greeting(): string which returns exactly "hello world". Add tests/takt-greeting.test.ts using node:test and node:assert/strict, importing ../tests/fixtures/takt-greeting.ts, and asserting that value. Modify no other files. This fixture verifies the TAKT-to-PrivateAgent publisher path and is not a product feature. Do not commit, push or create a PR.',
 acceptanceCriteria:['Only the two specified files are added.','npm run check and npm test pass.']},crypto.randomUUID());
await writeFile('.local/evidence/takt-publish-id.json',JSON.stringify({id,budgetMs:1800000,maxProviderCalls:20}),{mode:0o600});
console.log(JSON.stringify({id,budgetMs:1800000,maxProviderCalls:20,state:'submitted'}));
const sandbox={codexPackage:process.env.CODEX_PACKAGE!,authFile:process.env.CODEX_AUTH_FILE!,dependencies:resolve('node_modules')};
const announce=()=>worker('/api/development/runner-heartbeat',{available:true,executionProfile:'takt-simple'});
await announce();const online=setInterval(()=>{void announce().catch(()=>{});},10000),stop=new AbortController();
process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
try{await developmentOnce(worker,{...sandbox,repository:process.cwd(),worktrees,publishAuthorized:true,repositoryVisibility:visibility,takt:{...sandbox,taktRuntime:process.env.TAKT_RUNTIME!,taktInputs:resolve('examples/takt'),taktRuns:resolve('.local/takt-runs'),maxProviderCalls:20}},stop.signal);}
finally{clearInterval(online);await worker('/api/development/runner-heartbeat',{available:false,executionProfile:'takt-simple'});}
const status=await viewer.status(id);await writeFile('.local/evidence/takt-publish-live.json',JSON.stringify(status,null,2),{mode:0o600});console.log(JSON.stringify({id,state:status.state,error:status.error,result:status.result}));assert.equal(status.state,'succeeded');
