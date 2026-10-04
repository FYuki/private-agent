import { DevelopmentClient } from './client.ts';
import { exact,object,str } from '../shared/contracts.ts';

const taskProperties={repoId:{type:'string',enum:['private-agent']},goal:{type:'string'},baseRef:{type:'string',enum:['epic/development-runner']},acceptanceCriteria:{type:'array',items:{type:'string'}},orchestratorProfileId:{type:'string'},executionProfileId:{type:'string'}};
export const developmentTools=[
 {name:'development_profiles',description:'利用可能な司令塔・実装profileと既定値を取得',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'development_submit',description:'owner専用の単発開発taskを冪等受付。モデル出力は外部writeの承認ではない',inputSchema:{type:'object',properties:{...taskProperties,idempotencyKey:{type:'string'}},required:['repoId','goal','baseRef','acceptanceCriteria','idempotencyKey'],additionalProperties:false}},
 {name:'development_status',description:'同じownerのtask状態・runner状態を取得',inputSchema:{type:'object',properties:{taskId:{type:'string'}},required:['taskId'],additionalProperties:false}},
 {name:'development_cancel',description:'同じownerのtaskへcancelを要求',inputSchema:{type:'object',properties:{taskId:{type:'string'}},required:['taskId'],additionalProperties:false}},
];
/** transportに権限判断を複製せず、GUIと同じ認証済みAPIへ転送する。 */
export async function callDevelopmentTool(client:DevelopmentClient,name:string,args:unknown) {
 const value=object(args);
 if(name==='development_profiles'){exact(value,[]);return client.profiles();}
 if(name==='development_submit'){
  const {idempotencyKey,...task}=value;
  return client.submit(task,str(idempotencyKey,100));
 }
 exact(value,['taskId']);const id=str(value.taskId,36);
 if(name==='development_status')return client.status(id);
 if(name==='development_cancel')return client.cancel(id);
 throw new Error('unknown_tool');
}
