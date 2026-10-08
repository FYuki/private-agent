import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
// v3 official.mjsのbinding修正を移植。公式config cacheは専用process内に閉じ込める。
const [runtime,root,config,clones,taskName,runSlug,workflow]=process.argv.slice(2);
for(const p of [runtime,root,config,clones])if(resolve(p)!==p||realpathSync(p)!==p)throw Error('untrusted_binding_path');
if(!/^[a-zA-Z0-9_-]{1,255}$/.test(runSlug)||!['default','simple','private-agent-child-issue'].includes(workflow))throw Error('invalid_binding_identity');
const pkg=JSON.parse(readFileSync(join(runtime,'node_modules/takt/package.json'),'utf8'));
const lock=JSON.parse(readFileSync(join(runtime,'package-lock.json'),'utf8')).packages?.['node_modules/takt'];
if(pkg.version!=='0.68.0'||lock?.integrity!=='sha512-92yoikSQ6kyj/PYMrefONIOKkNW9CdiJrAl2REPdsmdKp3M3XUMZnxDOjCtf1mAnOMadJpVGlGa5sYuaI1hjcw==')throw Error('takt_pin_mismatch');
const bounded=(p,max)=>{const s=lstatSync(p);if(!s.isFile()||s.nlink!==1||s.size>max||realpathSync(p)!==p)throw Error('untrusted_binding_file');return readFileSync(p,'utf8');};
bounded(join(root,'.takt/tasks.yaml'),1048576);
process.env.TAKT_CONFIG_DIR=config;
const mod=p=>import(pathToFileURL(join(runtime,'node_modules/takt/dist',p)).href);
const [{TaskRunner},{assertTaskStateWorktreeOwnership},{readRunContextOrderContent},{buildRunPaths},{buildTaskInstruction}]=await Promise.all([
 mod('infra/task/index.js'),mod('features/tasks/taskStateWorktreeOwnership.js'),mod('core/workflow/run/order-content.js'),mod('core/workflow/run/run-paths.js'),mod('infra/task/instruction.js')]);
const states=new TaskRunner(root).listTaskStateItems();if(states.length!==1)throw Error('watch_task_ambiguous');const state=states[0];
const order=readFileSync(0,'utf8');if(!order||Buffer.byteLength(order)>65536)throw Error('invalid_order');
if(state.name!==taskName||state.runSlug!==runSlug||state.status!=='completed'||state.workflow!==workflow||state.summary!==order.split('\n')[0]||!state.branch||!state.worktreePath?.startsWith(clones+'/')||realpathSync(state.worktreePath)!==state.worktreePath)throw Error('watch_completion_mismatch');
if(typeof state.taskDir!=='string'||!/^\.takt\/tasks\/[a-zA-Z0-9_-]+$/.test(state.taskDir))throw Error('untrusted_order_directory');
assertTaskStateWorktreeOwnership(root,state);
if(bounded(join(root,state.taskDir,'order.md'),65536)!==order)throw Error('queued_order_changed');
const paths=buildRunPaths(state.worktreePath,runSlug);
if(bounded(paths.contextTaskOrderAbs,65536)!==order||readRunContextOrderContent(state.worktreePath,runSlug)!==order)throw Error('run_order_changed');
console.log(JSON.stringify({taskName,runSlug,clone:state.worktreePath,branch:state.branch,executionTask:buildTaskInstruction(paths.contextTaskRel,paths.contextTaskOrderRel)}));
