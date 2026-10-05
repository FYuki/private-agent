import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DevelopmentClient} from '../development/client.ts';
import {repositoryBindings} from '../development/repositories.ts';
import {executePublication} from '../development/publication.ts';
import {uuid} from '../shared/publication.ts';

// One explicit approved publication, not a background task/model loop.
const id=uuid(process.env.PUBLICATION_ID),path=process.env.DEVELOPMENT_REGISTRY_FILE||'';
if(resolve(path)!==path||await realpath(path)!==path||!(await lstat(path)).isFile())throw Error('untrusted_registry_file');
const bindings=repositoryBindings(JSON.parse(await readFile(path,'utf8')));
const api=new DevelopmentClient(process.env.CONTROL_URL||'http://127.0.0.1:8787/',process.env.WORKER_TOKEN||'');
const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
const result=await executePublication(id,api.request.bind(api),bindings,stop.signal);
console.log(JSON.stringify({publicationId:id,...result}));
