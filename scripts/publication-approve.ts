import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DevelopmentClient} from '../development/client.ts';
import {str} from '../shared/contracts.ts';

// Operator invokes this only after receiving approval for the exact request file.
const path=process.env.PUBLICATION_REQUEST_FILE||'',key=str(process.env.PUBLICATION_KEY,100);
if(resolve(path)!==path||await realpath(path)!==path)throw Error('untrusted_approval_path');
const stat=await lstat(path);if(!stat.isFile()||stat.size>20000)throw Error('invalid_approval_file');
const api=new DevelopmentClient(process.env.CONTROL_URL||'http://127.0.0.1:8787/',process.env.VIEWER_TOKEN||'');
const result=await api.approvePublication(JSON.parse(await readFile(path,'utf8')),key);
console.log(JSON.stringify({publicationId:result.id}));
