// host管理者用。既存実行への接続だけを行い、新規TAKT/モデル実行を開始しない。
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {cancelWatchExecution,observeWatchExecution,tellWatchExecution,executionDirectory,type WatchExecutionRequest} from '../development/watch-execution.ts';
const [directory,action,key]=process.argv.slice(2);
if(!directory||!['wait','cancel','tell'].includes(action)||(action==='tell'&&!key))throw Error('usage: execution-directory wait|cancel|tell [instruction-key]');
const resolvedDirectory=resolve(directory);
const request:WatchExecutionRequest=JSON.parse(await readFile(join(resolvedDirectory,'request.json'),'utf8'));
if(executionDirectory(request.config,request.order.id)!==resolvedDirectory)throw Error('watch_execution_identity_conflict');
if(action==='cancel'){
 await cancelWatchExecution(request.config,request.order.id,request.owner);
 console.log(JSON.stringify({cancelRequested:true,stopConfirmed:false}));
}else if(action==='tell'){
 let content='';for await(const bytes of process.stdin){content+=bytes.toString();if(Buffer.byteLength(content)>8192)throw Error('instruction_limit');}
 const receipt=await tellWatchExecution(request.config,request.order.id,request.owner,key,content);
 console.log(JSON.stringify({deliveryAccepted:true,consumptionConfirmed:false,receipt}));
}else{
 const result=await observeWatchExecution(resolvedDirectory,new AbortController().signal,process.hrtime.bigint()+60000000000n);
 console.log(JSON.stringify({task:request.order.id,headSha:result.headSha,workflowStatus:result.status,publication:false}));
}
