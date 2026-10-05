import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {realpath,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {TAKT_PIN} from './takt-contract.ts';
import type {WatchQueue,TaktTask} from './watch-contract.ts';

/** 管理者が指定した固定root/runtimeだけへ接続。API入力でcwd/command/環境変数を変えない。 */
export async function verifyWatchRuntime(runtime:string,root:string,configDir:string){
 for(const p of [runtime,root,configDir])if(resolve(p)!==p||await realpath(p)!==p)throw Error('untrusted_watch_path');
 const pkg=JSON.parse(await readFile(join(runtime,'node_modules/takt/package.json'),'utf8'));
 const lock=JSON.parse(await readFile(join(runtime,'package-lock.json'),'utf8')).packages?.['node_modules/takt'];
 if(pkg.version!==TAKT_PIN.version||lock?.version!==TAKT_PIN.version||lock?.integrity!==TAKT_PIN.integrity)throw Error('takt_pin_mismatch');
}
export class TaktWatchClient implements WatchQueue {
 private constructor(private client:Client,private transport:StdioClientTransport,private root:string){}
 static async connect(runtime:string,root:string,configDir:string){
  const {verifyWatchConfig}=await import('./watch-config.ts');await verifyWatchConfig(runtime,root,configDir);
  const transport=new StdioClientTransport({command:process.execPath,args:[join(runtime,'node_modules/takt/dist/app/mcp/index.js')],cwd:root,env:{PATH:'/usr/bin:/bin',HOME:configDir,TAKT_CONFIG_DIR:configDir,LANG:'C.UTF-8',NO_UPDATE_NOTIFIER:'1'},stderr:'pipe'});
  const client=new Client({name:'private-agent-watch',version:'1.0.0'});await client.connect(transport);transport.stderr?.on('data',()=>{});return new TaktWatchClient(client,transport,root);
 }
 async close(){await this.client.close();await this.transport.close();}
 private async call(name:string,args:Record<string,unknown>){
  const result=await this.client.callTool({name,arguments:{...args,cwd:this.root}},undefined,{timeout:30000});
  const content=(result.content as {type:string;text?:string}[]).filter(x=>x.type==='text').map(x=>x.text??'').join('\n');
  if(result.isError||Buffer.byteLength(content)>1024*1024)throw Error('takt_mcp_result_rejected');
  return JSON.parse(content);
 }
 enqueue(input:Parameters<WatchQueue['enqueue']>[0]){return this.call('takt_enqueue_task',input);}
 async list():Promise<TaktTask[]>{return (await this.call('takt_list_tasks',{})).tasks;}
 /** host内部専用。配送受付は消費・成功・公開承認の証拠ではない。 */
 tell(runSlug:string,content:string){if(!/^[a-zA-Z0-9_-]{1,255}$/.test(runSlug)||!content.trim()||Buffer.byteLength(content)>8192)throw Error('invalid_run_instruction');return this.call('takt_tell_run',{runSlug,content});}
 run(runSlug:string){if(!/^[a-zA-Z0-9_-]{1,255}$/.test(runSlug))throw Error('invalid_run_slug');return this.call('takt_get_run',{runSlug});}
}
