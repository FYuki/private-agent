import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema,ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DevelopmentClient } from './client.ts';
import { callDevelopmentTool,developmentTools } from './mcp-tools.ts';

const client=new DevelopmentClient(process.env.CONTROL_URL||'http://127.0.0.1:8787/',process.env.VIEWER_TOKEN||'');
const server=new Server({name:'private-agent-development',version:'0.1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:developmentTools}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
 try{return {content:[{type:'text',text:JSON.stringify(await callDevelopmentTool(client,request.params.name,request.params.arguments??{}))}]};}
 catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error&&/^(control_\d+|invalid_task_id|unknown_tool|repository_not_allowed|base_ref_not_allowed|unknown_development_profile|claude_profile_not_verified)$/.test(error.message)?error.message:'development_request_rejected'}]};}
});
await server.connect(new StdioServerTransport());
