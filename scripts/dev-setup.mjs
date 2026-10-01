import {randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile,access} from 'node:fs/promises';
try{await access('.dev.vars');throw Error('.dev.vars already exists; refusing to replace credentials');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir('.local',{recursive:true,mode:0o700});
const tokens={},principals=[];
for(const [id,role,owner] of [['viewer','viewer','local'],['worker','worker','local'],['other','worker','other']]){
 const token=randomBytes(32).toString('base64url');tokens[id]=token;principals.push({id,role,owner,group:owner,hash:createHash('sha256').update(token).digest('hex')});
}
await writeFile('.dev.vars',"AUTH_JSON='"+JSON.stringify(principals)+"'\n",{mode:0o600,flag:'wx'});
await writeFile('.local/tokens.json',JSON.stringify(tokens),{mode:0o600,flag:'wx'});
console.log('Local-only credentials written to ignored files; never use them in production.');
