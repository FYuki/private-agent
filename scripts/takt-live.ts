import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {executeTakt} from '../development/takt-adapter.ts';
import {processOutput} from '../development/process.ts';
const root=resolve('.local/takt-live'),id=crypto.randomUUID(),worktree=join(root,id);
await mkdir(worktree,{recursive:true});await mkdir(join(worktree,'node_modules'));await mkdir(join(worktree,'shared'));
await writeFile(join(worktree,'package.json'),JSON.stringify({private:true,type:'module',scripts:{test:'node --test tests/*.test.js'}}));
await writeFile(join(worktree,'shared/greeting.js'),'export const greeting = () => "hello";\n');
for(const args of [['init','--initial-branch=synthetic'],['add','package.json','shared/greeting.js'],['-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','commit','-m','Synthetic input']])await processOutput('/usr/bin/git',args,worktree,'',new AbortController().signal,process.hrtime.bigint()+10000000000n,{PATH:'/usr/bin:/bin'});
const runs=resolve('.local/takt-runs');await mkdir(runs,{recursive:true,mode:0o700});
const config={codexPackage:process.env.CODEX_PACKAGE!,authFile:process.env.CODEX_AUTH_FILE!,dependencies:resolve('node_modules'),taktRuntime:resolve('.local/takt-runtime'),taktInputs:resolve('.local/takt-inputs'),taktRuns:runs};
const task='Small synthetic implementation task. Change shared/greeting.js greeting() return value from hello to hello world. Add one node:test JavaScript test in tests/greeting.test.js asserting hello world. Run npm test. No dependencies, commits, push, PR or external communication. No other source changes.';
try {const result=await executeTakt(config,worktree,task,'0'.repeat(40),id,new AbortController().signal,process.hrtime.bigint()+1200000000000n);console.log(JSON.stringify({id,result}));}catch(e){console.error(JSON.stringify({id,error:(e as Error).message}));process.exitCode=1;}
