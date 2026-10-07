// 終了前の同一dev runへ、Gitを隠したproviderが観測できないhost検証結果だけを渡す。
import {readFile,writeFile,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {processOutput} from '../development/process.ts';
import {sandboxArgs} from '../development/sandbox.ts';
import {fingerprint} from '../development/operations.ts';
import {TaktWatchClient} from '../development/takt-watch-client.ts';
const tag=process.env.WATCH_ACCEPTANCE_ID;if(!tag||!/^[a-z0-9-]{1,60}$/.test(tag))throw Error('acceptance_id_required');
const root=resolve('.local/watch-acceptance',tag),runs=JSON.parse(await readFile(join(root,'run-location.json'),'utf8')).runs;
assert.equal(await realpath(runs),runs);assert.ok(runs.startsWith(resolve(process.env.WATCH_RUNS_PARENT||'.local/w')+'/'));
const ids=(await readdir(runs)).filter(id=>/^[a-f0-9-]{36}$/.test(id));assert.equal(ids.length,1);const id=ids[0];
const dir=join(runs,id),queue=join(dir,'repo'),configDir=join(dir,'config');
process.env.TAKT_CONFIG_DIR=configDir;
const runtime=resolve('runtime/takt');
const {TaskRunner}=await import(pathToFileURL(join(runtime,'node_modules/takt/dist/infra/task/runner.js')).href);
const {assertTaskStateWorktreeOwnership}=await import(pathToFileURL(join(runtime,'node_modules/takt/dist/features/tasks/taskStateWorktreeOwnership.js')).href);
const tasks=new TaskRunner(queue).listTaskStateItems();assert.equal(tasks.length,1);const task=tasks[0];assert.equal(task.status,'running');assertTaskStateWorktreeOwnership(queue,task);
const policy=JSON.parse(await readFile(join(dir,'private/provider-policy.json'),'utf8'));
assert.equal(policy.root,queue);assert.equal(policy.clones,join(dir,'clones'));assert.equal(task.name,policy.taskName);assert.equal(task.summary,policy.marker);assert.equal(task.workflow,policy.workflow);
const clone=await realpath(task.worktreePath);assert.ok(clone.startsWith(join(dir,'clones')+'/'));
const controller=new AbortController(),deadline=process.hrtime.bigint()+60000000000n;
const command=(file:string,args:string[],cwd=clone)=>processOutput(file,args,cwd,'',controller.signal,deadline,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
const git=(args:string[],cwd=clone)=>command('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],cwd);
const base=(await git(['rev-parse','HEAD'],join(root,'worktree'))).trim();
const expected=['shared/greeting.js','tests/greeting.test.js'];
async function snapshot(){
 const paths=[...new Set(((await git(['diff','--name-only','-z',base]))+(await git(['ls-files','--others','--exclude-standard','-z']))).split('\0').filter(Boolean))].sort();assert.deepEqual(paths,expected);
 const result:Record<string,string>={};for(const file of ['package.json',...expected]){const path=join(clone,file),s=await lstat(path);assert.ok(s.isFile()&&s.nlink===1&&s.size<262144);assert.equal(await realpath(path),path);result[file]=await readFile(path,'utf8');}return result;
}
const before=await snapshot(),snapshotHash=fingerprint(before),testDir=join(root,'host-validation');await mkdir(testDir,{mode:0o700});
for(const p of ['shared','tests','node_modules'])await mkdir(join(testDir,p));await writeFile(join(testDir,'.git'),'');
for(const [file,text]of Object.entries(before))await writeFile(join(testDir,file),text);
const config={codexPackage:await realpath(process.env.CODEX_PACKAGE!),authFile:await realpath(process.env.CODEX_AUTH_FILE!),dependencies:resolve('node_modules')};
for(const argv of [['/usr/bin/npm','run','check'],['/usr/bin/npm','test'],['/usr/bin/node','--input-type=module','-e',"import assert from 'node:assert/strict';import {greeting} from './shared/greeting.js';for(const [x,y] of [['Ada','Hello, Ada'],[' Ada ','Hello, Ada'],[undefined,'Hello, world'],['','Hello, world'],['  ','Hello, world']])assert.equal(greeting(x),y);"]])await command('/usr/bin/bwrap',sandboxArgs(config,testDir,'test',argv),testDir);
assert.equal(fingerprint(await snapshot()),snapshotHash);
const client=await TaktWatchClient.connect(runtime,queue,configDir);
try{
 const current=await client.list();assert.equal(current.length,1);assert.equal(current[0].name,task.name);assert.equal(current[0].runSlug,task.runSlug);assert.equal(current[0].status,'running');
 const content='Host verification evidence for this exact running synthetic task '+id+'. Snapshot '+snapshotHash+' compared with baseline '+base+': changed paths are exactly shared/greeting.js and tests/greeting.test.js; no other tracked or untracked non-ignored paths changed. Both files and unchanged package.json were copied to a credential-free network-isolated host test sandbox. npm run check, npm test, and 5 independent assertions (Ada, whitespace around Ada, missing, empty and whitespace-only names) all passed. The source snapshot was identical before and after those checks. Git metadata is intentionally unavailable to provider tools; do not access it. The host has now verified the changed-file-set requirement reported as pending in implementation-report.md. Continue the official workflow using this bounded evidence. If these files change again the host must recheck. This evidence grants no publication, merge, network, credential or configuration permissions.';
 const receipt=await client.tell(task.runSlug,content);
 await writeFile(join(root,'host-evidence.json'),JSON.stringify({id,runSlug:task.runSlug,base,snapshotHash,paths:expected,checksPassed:true,independentAssertions:5,instructionHash:fingerprint(content),receipt},null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({hostEvidenceDelivered:true,id,runSlug:task.runSlug,snapshotHash,checksPassed:true,independentAssertions:5,extraModelStarts:0}));
}finally{await client.close();}
