import {selectRepository,preflightRepository,type RepositoryBinding} from './repositories.ts';
import {watchOrder} from './watch-contract.ts';
import {WatchStore} from './watch-store.ts';
import {TaktWatchClient} from './takt-watch-client.ts';
import {WatchSupervisor} from './watch-supervisor.ts';
import {contractWatchProcess} from './watch-config.ts';

/** Agent基盤の内部接続点。認証済みownerを管理者registryに束縛し、modelにrootを選ばせない。 */
export class WatchManager {
 private constructor(private owner:string,private binding:RepositoryBinding,private runtime:string,private configDir:string,private store:WatchStore,private queue:TaktWatchClient){}
 static async connect(owner:string,repoId:string,bindings:RepositoryBinding[],runtime:string,configDir:string,store:WatchStore){
  const binding=selectRepository(bindings,repoId,owner);await preflightRepository(binding);
  return new WatchManager(owner,binding,runtime,configDir,store,await TaktWatchClient.connect(runtime,binding.root,configDir));
 }
 submit(value:unknown){const order=watchOrder(value);if(order.repoId!==this.binding.repoId)throw Error('repository_mismatch');return this.store.submit(this.owner,order);}
 dispatch(id:string){return this.store.dispatch(this.owner,id,this.binding.repoId,this.queue);}
 collect(id:string){return this.store.reconcile(this.owner,id,this.binding.repoId,this.queue);}
 status(id:string){return this.store.status(this.owner,id);}
 requestCancel(id:string){return this.store.cancel(this.owner,id);}
 /** 初期sliceは空queueの起動監督試験のみ。本番online表示や既存service切替はしない。 */
 async startEmptyContract(supervisor:WatchSupervisor){
  if((await this.queue.list()).length)throw Error('contract_watch_requires_empty_queue');
  return supervisor.start(this.owner,await contractWatchProcess(this.runtime,this.binding.root,this.configDir));
 }
 close(){return this.queue.close();}
}
