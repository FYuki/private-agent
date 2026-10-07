import { Store } from '../../control-plane/store.ts';
import { job, localDispatch, openDatabase } from './local-control.ts';

const [path,action]=process.argv.slice(2),db=await openDatabase(path),store=new Store(db,()=>1000000);
if(action==='seed'){
  const id=await store.create('a','one',job);await store.tick(1000000,'a');
  process.send!({id});
  setInterval(()=>{},1000);
}else if(action==='recover'){
  try {await localDispatch(store,1000000,'a');process.send!({runs:(await store.list('a')).runs});}
  finally {db.close();process.disconnect!();}
}else {db.close();throw Error('invalid_outbox_fixture_action');}
