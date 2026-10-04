import assert from 'node:assert/strict';
import {mkdtemp,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {guardedRun,providerSandboxArgs} from '../development/takt-codex-wrapper.mjs';
if(process.argv[2]!=='--inside'){
 const dir=await mkdtemp('/tmp/private-agent-descendants-');
 const child=spawn('/usr/bin/bwrap',['--die-with-parent','--unshare-user','--unshare-pid','--unshare-net','--ro-bind','/','/','--bind',dir,dir,'--proc','/proc','--dev','/dev','--',process.execPath,fileURLToPath(import.meta.url),'--inside',dir],{stdio:'inherit'});
 child.on('exit',c=>{process.exitCode=c??1;});
}else{
 const dir=process.argv[3],pause=ms=>new Promise(r=>setTimeout(r,ms));
 async function probe(isolated,cancel=false){
  const prefix=cancel?'cancel':isolated?'fixed':'baseline',file=join(dir,prefix+'.txt');
  const writer=`const fs=require('fs');process.on('SIGINT',()=>{});const t=setInterval(()=>fs.appendFileSync(${JSON.stringify(file)},'x'),10);setTimeout(()=>{clearInterval(t);process.exit(0)},800);`;
  const parent=`const fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'});c.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(file)})){${cancel?'':'clearInterval(t);process.exit(0)'}}},5);setTimeout(()=>process.exit(2),1000).unref();`;
  const command=[process.execPath,'-e',parent],lock=join(dir,prefix+'.lock');
  console.log(JSON.stringify({probe:prefix,dir}));
  const run=guardedRun({file:isolated?'/usr/bin/bwrap':command[0],args:isolated?providerSandboxArgs(command):command.slice(1),lock,activity:join(dir,prefix+'.events'),env:{PATH:'/usr/bin:/bin'},stderr:process.stderr,stdin:Readable.from([]),stdout:new Writable({write(_c,_e,cb){cb();}}),callMs:cancel?150:4000,idleMs:4000});
  if(cancel)await assert.rejects(run,/provider_failed/);else await run;
  await assert.rejects(access(lock));const first=(await readFile(file)).length;await pause(200);const next=(await readFile(file)).length;
  if(isolated)assert.equal(next,first,'detached writer survived namespace close');else assert.ok(next>first,'baseline reproduction failed');
  await pause(850);return {first,next};
 }
 const baseline=await probe(false),fixed=await probe(true),cancelled=await probe(true,true);
 console.log(JSON.stringify({setsidWriterReproduced:true,stdioIgnored:true,baseline,fixed,cancelled,providerNamespaceStopsDescendants:true,lockReleasedAfterNamespaceClose:true}));
}
