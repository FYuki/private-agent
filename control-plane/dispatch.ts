import type {Store} from './store.ts';
export interface WorkflowBinding {
 create(options:{id:string;params:{runId:string}}):Promise<unknown>;
 get(id:string):Promise<{status():Promise<{status:string}>}>;
}
export async function dispatch(workflows:WorkflowBinding,store:Store,at:number,owner?:string){
 const admitted=await store.tick(at,owner),ids:string[]=[],failedStarts:string[]=[];
 for(const run of admitted.pending){
  const id=run.owner+'-'+run.id.replace(':','-');
  try{await workflows.create({id,params:{runId:run.id}});}catch(error){
    let status:string;
    try{status=(await (await workflows.get(id)).status()).status;}catch{throw error;}
    if(['errored','terminated','complete'].includes(status)){
      // A terminal Workflow cannot activate an outbox item again. Fail only an
      // unclaimed start; never change queued/running/completed external work.
      if(await store.failStarting(run.id))failedStarts.push(run.id);else ids.push(id);
      continue;
    }
    if(!['queued','running','waiting','paused','waitingForPause'].includes(status))throw error;
  }
  ids.push(id);
 }
 return {enqueued:admitted.enqueued,skipped:admitted.skipped,ids,failedStarts};
}
