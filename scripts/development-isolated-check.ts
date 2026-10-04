import {sandboxArgs} from '../development/sandbox.ts';
import {processOutput} from '../development/process.ts';
import {resolve} from 'node:path';
if(!process.env.ACCEPTANCE_WORKTREE)throw Error('explicit_acceptance_worktree_required');
const directory=resolve(process.env.ACCEPTANCE_WORKTREE),config={codexPackage:process.env.CODEX_PACKAGE!,authFile:process.env.CODEX_AUTH_FILE!,dependencies:resolve('node_modules')};
for(const name of ['check','test']){
 const output=await processOutput('/usr/bin/bwrap',sandboxArgs(config,directory,'test',['/usr/bin/npm','run',name]),directory,'',new AbortController().signal,process.hrtime.bigint()+120000000000n,{PATH:'/usr/bin:/bin'});
 console.log(JSON.stringify({isolatedHostGate:name,passed:true,outputBytes:output.length}));
}
