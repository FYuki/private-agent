import { mkdir,writeFile,readFile,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { sandboxArgs,codexCommand,toolPermissions,type SandboxConfig } from '../development/sandbox.ts';
import { processOutput,finalMessage } from '../development/process.ts';

const config:SandboxConfig={codexPackage:process.env.CODEX_PACKAGE||'',authFile:process.env.CODEX_AUTH_FILE||'',dependencies:resolve('node_modules')};
const path=resolve('.local/development-preflight');await mkdir(path,{recursive:true,mode:0o700});await writeFile(path+'/.git','');
const signal=new AbortController().signal,deadline=()=>process.hrtime.bigint()+120000000000n;
const run=(mode:'plan'|'edit'|'test',command:string[],input='')=>processOutput('/usr/bin/bwrap',sandboxArgs(config,path,mode,command),path,input,signal,deadline(),{PATH:'/usr/bin:/bin',GH_TOKEN:'synthetic-canary',WORKER_TOKEN:'synthetic-canary'});
await run('edit',['/usr/bin/node','-e',`const fs=require('fs'),a=require('assert');a.equal(process.env.GH_TOKEN,undefined);a.equal(process.env.WORKER_TOKEN,undefined);a.equal(fs.existsSync('/home/asa/.config/gh'),false);a.throws(()=>fs.writeFileSync('/usr/private-agent-probe','x'));fs.symlinkSync('/usr/private-agent-probe','/workspace/escape');a.throws(()=>fs.writeFileSync('/workspace/escape','x'));`]);
await unlink(path+'/escape');
const server=createServer(s=>s.end());await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
try{
 const port=(server.address() as {port:number}).port;
 const synthetic=resolve('.local/development-preflight-auth.json');await writeFile(synthetic,'{"canary":"synthetic-only"}',{mode:0o600});
 const command=['/usr/bin/node','/opt/codex/bin/codex.js','sandbox',...toolPermissions('edit'),'--','/usr/bin/node','-e',`const fs=require('fs'),a=require('assert'),net=require('net');a.throws(()=>fs.readFileSync('/home/runner/.codex/auth.json'));a.throws(()=>fs.readFileSync('/proc/1/root/home/runner/.codex/auth.json'));const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(42));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(43),2000);`];
 await processOutput('/usr/bin/bwrap',sandboxArgs({...config,authFile:synthetic},path,'edit',command),path,'',signal,deadline(),{PATH:'/usr/bin:/bin'});
 await unlink(synthetic);
}finally{await new Promise<void>(r=>server.close(()=>r()));}
const auth=await run('plan',['/usr/bin/node','/opt/codex/bin/codex.js','login','status']);
if(process.argv.includes('--live')){
 const raw=await run('edit',codexCommand('edit'),'Synthetic development isolation check. Create only result.js containing exactly: export const result = 2 + 3; Do not access any credentials or external service. Do not run git, commit, push, or PR operations. Reply briefly when done.');
 finalMessage(raw);assert.match(await readFile(path+'/result.js','utf8'),/2\s*\+\s*3/);
}
console.log(JSON.stringify({sandbox:true,credentialsHidden:true,externalWriteDenied:true,symlinkEscapeDenied:true,toolNetworkDenied:true,loginStatusSucceeded:true,liveEdit:process.argv.includes('--live')}));
