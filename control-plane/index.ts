import {WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep} from 'cloudflare:workers';
import {Store} from './store.ts';
import {authenticate} from './auth.ts';
import {Fault,LIMITS,exact,object,str,integer,provider,capacity} from '../shared/contracts.ts';
import {html,script} from './ui.ts';
import {MeasuredDatabase} from './measurement.ts';
import {dispatch} from './dispatch.ts';
type Tick={runId:string};
export interface Env {DB:D1Database; TICK:Workflow<Tick>; MODE:string;AUTH_JSON?:string;SCHEDULE_ENABLED:string;LIMITS_JSON:string}
export class ScheduleTick extends WorkflowEntrypoint<Env,Tick>{
  async run(event:WorkflowEvent<Tick>,step:WorkflowStep){
    return step.do('release-admitted-run',{retries:{limit:2,delay:'1 second',backoff:'constant'},timeout:'10 seconds'},async()=>{
      const db=new MeasuredDatabase(this.env.DB),start=performance.now();const result=await new Store(db).activate(event.payload.runId);
      return {...result,...(this.env.MODE==='local'?{measurement:{...db.metrics,wallMs:performance.now()-start,logicalSteps:1}}:{})};
    });
  }
}
const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
async function body(req:Request){
  if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Fault(415,'json_required');
  const reader=req.body?.getReader();if(!reader)throw new Fault(400,'body_required');let n=0;const chunks:Uint8Array[]=[];
  while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>24000){await reader.cancel();throw new Fault(413,'body_limit');}chunks.push(value);}
  const bytes=new Uint8Array(n);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return object(JSON.parse(new TextDecoder().decode(bytes)));}catch(e){if(e instanceof Fault)throw e;throw new Fault(400,'invalid_json');}
}
export default {
 async fetch(req:Request,env:Env):Promise<Response>{
  const db=new MeasuredDatabase(env.DB),start=performance.now();
  const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{...headers,...(env.MODE==='local'?{'x-local-measurement':JSON.stringify({...db.metrics,wallMs:performance.now()-start})}:{})}});
  try{
   const url=new URL(req.url),path=url.pathname;
   if(env.MODE==='local'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Fault(403,'localhost_only');
   // The unauthenticated shell contains no jobs, prompts, owner IDs or results.
   if(req.method==='GET'&&(path==='/'||path==='/app.js'))return new Response(path==='/'?html:script,{headers:{...headers,'content-type':path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8'}});
   const p=await authenticate(req,env.MODE,env.AUTH_JSON),store=new Store(db);
   if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)throw new Fault(403,'origin_denied');
   if(req.method==='GET'&&path==='/api/state'){if(p.role!=='viewer')throw new Fault(403,'role_denied');return json(await store.list(p.owner));}
   if(req.method==='GET'&&path.startsWith('/api/ticks/')){
     if(p.role!=='viewer'||env.MODE!=='local')throw new Fault(403,'role_denied');
     const id=path.slice('/api/ticks/'.length);if(!id.startsWith(p.owner+'-'))throw new Fault(404,'not_found');
     return json(await (await env.TICK.get(id)).status());
   }
   if(req.method!=='POST')throw new Fault(404,'not_found');
   const b=await body(req);
   if(path==='/api/claim'){
     if(p.role!=='worker')throw new Fault(403,'role_denied');exact(b,['provider','protocol']);
     if(b.protocol!=='absolute-deadline-v1')throw new Fault(400,'worker_upgrade_required');
     if(b.provider==='agent-fixture'&&env.MODE!=='local')throw new Fault(403,'fixture_local_only');
     let limits;try{limits=capacity(JSON.parse(env.LIMITS_JSON));}catch{throw new Fault(503,'capacity_not_configured');}
     return json(await store.claim(p.owner,p.id,b.provider===undefined?undefined:provider(b.provider),p.group||p.owner,limits));
   }
   const runRoute=path.match(/^\/api\/runs\/([a-f0-9-]+:\d+)\/(heartbeat|complete|cancel)$/);
   if(runRoute){
     const [,id,action]=runRoute;
     if(action==='cancel'){if(p.role!=='viewer')throw new Fault(403,'role_denied');exact(b,[]);return json(await store.cancel(p.owner,id));}
     if(p.role!=='worker')throw new Fault(403,'role_denied');
     if(action==='heartbeat'){exact(b,['token']);return json(await store.heartbeat(p.owner,p.id,id,str(b.token,64)));}
     exact(b,['token','result','error']);const token=str(b.token,64);
     if((b.result===null)===(b.error===null))throw new Fault(400,'one_outcome_required');
     const result=b.result===null?null:str(b.result,LIMITS.outputBytes);
     const errors=['provider_failed','timeout','output_limit','cancelled','cli_unavailable','invalid_provider_output','incomplete_provider_output','unexpected_tool_use','pi_devin_extension_required','invalid_text'];
     const error=b.error===null?null:str(b.error,100);if(error&&!errors.includes(error))throw new Fault(400,'invalid_error');
     return json(await store.finish(p.owner,p.id,id,token,result,error));
   }
   if(p.role!=='viewer')throw new Fault(403,'role_denied');
   if(path==='/api/jobs'){if(b.provider==='agent-fixture'&&env.MODE!=='local')throw new Fault(403,'fixture_local_only');const key=str(req.headers.get('idempotency-key'),128);return json({id:await store.create(p.owner,key,b)},201);}
   const disable=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/disable$/);
   if(disable){exact(b,[]);return json(await store.disable(p.owner,disable[1]));}
   if(path==='/api/tick'&&env.MODE==='local'){
     exact(b,['at']);const at=integer(b.at,0,Date.now()+60000);
     return json(await dispatch(env.TICK,store,at,p.owner),202);
   }
   throw new Fault(404,'not_found');
  }catch(e){return json({error:e instanceof Fault?e.message:'internal_error'},e instanceof Fault?e.status:500);}
 },
 async scheduled(event:ScheduledController,env:Env){
   if(env.SCHEDULE_ENABLED!=='true')return;
   await dispatch(env.TICK,new Store(env.DB),event.scheduledTime);
 }
};
