import { developmentInput } from '../shared/development.ts';
import {publicationInput,uuid} from '../shared/publication.ts';
import { str } from '../shared/contracts.ts';

/** GUIと同じowner APIを使う。dot接続先は管理者設定で、公開bindや認証発行は行わない。 */
export class DevelopmentClient {
  private base: URL;
  constructor(base: string, private token: string, private options: {allowWatchTest?:boolean} = {}) {
    this.base=new URL(base);
    if(this.base.username||this.base.password||this.base.search||this.base.hash||this.base.pathname!=='/'||!(this.base.protocol==='https:'||(this.base.protocol==='http:'&&['127.0.0.1','[::1]'].includes(this.base.hostname))))throw new Error('invalid_control_url');
    str(token,128);
  }
  async request(path:string,body?:unknown,key?:string) {
    const response=await fetch(new URL(path,this.base),{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+this.token,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw new Error('control_'+response.status);
    return response.json() as Promise<any>;
  }
  submit(value:unknown,key:string){return this.request('/api/development/tasks',developmentInput(value,this.options),str(key,100));}
  status(id:string){this.id(id);return this.request('/api/development/tasks/'+id);}
  cancel(id:string){this.id(id);return this.request('/api/development/tasks/'+id+'/cancel',{});}
  approvePublication(value:unknown,key:string){return this.request('/api/development/publications',publicationInput(value),str(key,100));}
  publication(id:string){return this.request('/api/development/publications/'+uuid(id));}
  profiles(){return this.request('/api/development/config');}
  private id(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('invalid_task_id');}
}
