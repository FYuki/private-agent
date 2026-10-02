import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {authenticate} from '../control-plane/auth.ts';
import {command,resultFromEvents,runProcess,cleanEnv} from '../wsl-worker/providers.ts';
import {tmpdir} from 'node:os';
import {client,once} from '../wsl-worker/main.ts';
const token='test-'.repeat(10),auth=JSON.stringify([{owner:'a',role:'viewer',id:'v',hash:createHash('sha256').update(token).digest('hex')}]);
test('auth closed by default; local host and production TLS required',async()=>{
 await assert.rejects(authenticate(new Request('http://localhost/api/state'),'local',auth),/unauthorized/);
 const req=(url:string,t=token)=>new Request(url,{headers:{authorization:'Bearer '+t}});
 assert.equal((await authenticate(req('http://localhost/api/state'),'local',auth)).owner,'a');
 await assert.rejects(authenticate(req('http://evil.test/'),'local',auth),/localhost/);
 await assert.rejects(authenticate(req('http://example.test/'),'production',auth),/configured/);
 await assert.rejects(authenticate(req('https://example.test/'),'production',undefined),/configured/);
 await assert.rejects(authenticate(req('http://localhost/','wrong'.repeat(10)),'local',auth),/unauthorized/);
 assert.throws(()=>client('http://example.test/',token),/https/);
});
test('CLI fixed argv, no tools, auth filtering, fail on unsupported provider',()=>{
 const cfg={codex:'codex',pi:'pi',devinExtension:'/trusted/extension.ts'};
 assert(command('codex-luna',cfg).args.includes('forced_login_method="chatgpt"'));
 assert(command('pi-swe2',cfg).args.includes('--no-tools'));
 assert.throws(()=>command('shell' as any,cfg),/unsupported/);
 process.env.OPENAI_API_KEY='never-inherit';process.env.WORKER_TOKEN='never-inherit';assert.equal(cleanEnv().OPENAI_API_KEY,undefined);assert.equal(cleanEnv().WORKER_TOKEN,undefined);
});
test('structured CLI outcomes, empty/oversized/error/tool output rejected',()=>{
 const good=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'5'}})+'\n'+JSON.stringify({type:'turn.completed'});
 assert.equal(resultFromEvents('codex-luna',good),'5');
 for(const raw of ['','garbage',JSON.stringify({type:'error'}),good.replace('5','x'.repeat(17000)),JSON.stringify({item:{type:'command_execution'}})])assert.throws(()=>resultFromEvents('codex-luna',raw));
 const pi=JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'5'}]}})+'\n'+JSON.stringify({type:'agent_end'});assert.equal(resultFromEvents('pi-swe2',pi),'5');
});
test('actual subprocess timeout, output ceiling, cancellation and nonzero exit',async()=>{
 const call=(code:string,signal=new AbortController().signal,timeout=2000)=>runProcess(process.execPath,['-e',code],'',tmpdir(),signal,timeout);
 await assert.rejects(call('setInterval(()=>{},1000)',undefined,50),/timeout/);
 await assert.rejects(call('process.stdout.write("x".repeat(300000))'),/output_limit/);
 await assert.rejects(call('process.exit(3)'),/provider_failed/);
 const a=new AbortController();const task=call('setInterval(()=>{},1000)',a.signal);a.abort();await assert.rejects(task,/cancelled/);
});
test('runner reports failure and repeats completion without rerunning provider',async()=>{
 let calls=0,completions=0;const api=async(path:string,b:any)=>{if(path==='/api/claim')return {id:'id',provider:'codex-luna',prompt:'test',token:'token',issued_at:1000,deadline:61000};if(path.endsWith('/complete')){completions++;assert.equal(b.result,'5');if(completions===1)throw Error('network');return {ok:true};}return {};};
 await once(api,async()=>{calls++;return '5';});assert.equal(calls,1);assert.equal(completions,2);
});
