import { Store } from '../../control-plane/store.ts';
import { limits, openDatabase } from './local-control.ts';

const [path,owner,worker]=process.argv.slice(2);
const db=await openDatabase(path);
process.send!({ready:true});
process.once('message',async()=>{
  try {
    const run=await new Store(db,()=>1000000).claim(owner,worker,'codex-luna','shared',limits);
    process.send!({run});
  } catch(error) {process.send!({error:String(error)});process.exitCode=1;}
  finally {db.close();process.disconnect!();}
});
