import {randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--directory'))throw Error('use --directory <new trusted directory>');
const directory=resolve(args.length?args[1]:'.local');
await mkdir(directory,{recursive:true,mode:0o700});
const targets=[join(directory,'control.json'),join(directory,'tokens.json'),resolve('.dev.vars')];
for(const path of targets){
 try{await lstat(path);throw Error('existing credentials; refusing to replace');}catch(error){if(error.code!=='ENOENT')throw error;}
}
const tokens={},principals=[];
for(const [id,role,owner] of [['viewer','viewer','local'],['worker','worker','local'],['other','worker','other']]){
 const token=randomBytes(32).toString('base64url');tokens[id]=token;principals.push({id,role,owner,group:owner,hash:createHash('sha256').update(token).digest('hex')});
}
const config={dbPath:join(directory,'control.sqlite'),authJson:JSON.stringify(principals),port:8787,scheduleEnabled:false,watchAcceptanceEnabled:false,limits:{models:{'codex-luna':1,'codex-sol':0,'pi-swe2':1,'agent-fixture':0},groups:{local:1,other:1}}};
await writeFile(join(directory,'control.json'),JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
await writeFile(join(directory,'tokens.json'),JSON.stringify(tokens),{mode:0o600,flag:'wx'});
console.log('Local credentials and configuration created; scheduling is disabled.');
