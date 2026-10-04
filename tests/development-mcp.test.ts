import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEVELOPMENT_DEFAULTS } from '../shared/development.ts';
test('MCP stdio contract uses the authenticated owner API for submit/status/cancel',async()=>{
 const requests:{path:string;method:string;key:string|undefined;body:any}[]=[],id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const server=createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer synthetic-viewer');let raw='';for await(const chunk of req)raw+=String(chunk);requests.push({path:req.url!,method:req.method!,key:req.headers['idempotency-key'] as string|undefined,body:raw?JSON.parse(raw):null});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url?.endsWith('/config')?{defaults:DEVELOPMENT_DEFAULTS}:{id}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','development/mcp.ts'],env:{CONTROL_URL:'http://127.0.0.1:'+(server.address() as any).port,VIEWER_TOKEN:'synthetic-viewer'},stderr:'pipe'}),client=new Client({name:'contract-test',version:'1'});
 try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,4);
  for(const [name,args] of [['development_profiles',{}],['development_submit',{repoId:'private-agent',baseRef:'epic/development-runner',goal:'synthetic',acceptanceCriteria:['pass'],idempotencyKey:'stable'}],['development_status',{taskId:id}],['development_cancel',{taskId:id}]] as const){const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true);}
  assert.equal(requests[1].key,'stable');assert.equal(requests[1].body.orchestratorProfileId,DEVELOPMENT_DEFAULTS.orchestratorProfileId);assert.equal(requests[2].method,'GET');assert.equal(requests[3].path,'/api/development/tasks/'+id+'/cancel');
  assert.equal((await client.callTool({name:'development_submit',arguments:{repoId:'other'}})).isError,true);assert.equal(requests.length,4);
 }finally{await client.close();await new Promise<void>(r=>server.close(()=>r()));}
});
