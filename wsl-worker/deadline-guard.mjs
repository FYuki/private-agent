// Linux only: the poller creates this supervisor as a detached process-group leader.
// hrtime is CLOCK_MONOTONIC on this host, shared across these local processes.
// This guard is deliberately independent of the poller's lifetime and wall clock.
import {spawn} from 'node:child_process';
const [rawDeadline,file,...args]=process.argv.slice(2);
let deadline;
try{deadline=BigInt(rawDeadline);}catch{process.exit(124);}
const remaining=()=>Number(deadline-process.hrtime.bigint())/1000000;
if(process.platform!=='linux'||!file||remaining()<=0)process.exit(124);
const killGroup=()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(124);}};
process.on('SIGTERM',killGroup);
process.on('SIGINT',()=>{try{if(child?.pid)process.kill(child.pid,'SIGINT');}catch{}setTimeout(killGroup,2000);});
// Broken pipes must not terminate the guard and leave its child unsupervised.
process.stdout.on('error',killGroup);
process.stderr.on('error',killGroup);
const timer=setTimeout(killGroup,Math.max(0,remaining()));
if(remaining()<=0)killGroup();
const child=spawn(file,args,{shell:false,detached:false,stdio:['pipe','pipe','pipe']});
if(remaining()<=0)killGroup();
process.stdin.pipe(child.stdin);
child.stdin.on('error',()=>{});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error',()=>{clearTimeout(timer);process.exit(127);});
child.on('close',code=>{clearTimeout(timer);process.exit(code??1);});
