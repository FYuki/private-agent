import {invoke} from '../wsl-worker/providers.ts';
import {provider} from '../shared/contracts.ts';
const p=provider(process.argv[2]);
try{
 const output=await invoke(p,'Synthetic acceptance check: 2 + 3 = ? Answer with the number only.',new AbortController().signal);
 console.log(JSON.stringify({provider:p,success:true,output}));
}catch(e){console.log(JSON.stringify({provider:p,success:false,error:(e as Error).message}));process.exitCode=1;}
