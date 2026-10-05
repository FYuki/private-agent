import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'watch-runtime-config-'));for(const name of ['default','simple']){
 const output=join(dir,name);await mkdir(output);
 execFileSync(process.execPath,['development/watch-runtime-prepare.mjs',resolve('runtime/takt'),resolve('examples/takt'),output,join(dir,'clones'),name],{stdio:'pipe'});
 const compiled=JSON.parse(await readFile(join(output,'watch-compiled.json'),'utf8'));
 assert.equal(compiled.maxProviderProcesses,1);assert.ok(compiled.candidates.length>5);assert.ok(compiled.candidates.every((x:any)=>x.executed===false));
 if(name==='default'){assert.ok(compiled.references.peer);assert.ok(compiled.candidates.some((x:any)=>x.target.includes('ai-antipattern')));}
}
console.log(JSON.stringify({officialDefaultAndSimple:true,providerExecuted:false}));
