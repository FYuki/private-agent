import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { SqliteDatabase } from '../control-plane/sqlite.ts';
import { migrate } from '../control-plane/migrations.ts';
import { resolveConfig } from '../control-plane/local.ts';
import { startServer } from '../control-plane/server.ts';
import { withCleanup, startProcess } from './resources.ts';

const directory=resolve('.local/integration-'+crypto.randomUUID().slice(0,8));
const parent=dirname(directory);
await mkdir(parent,{recursive:true,mode:0o700});
const parentStat=await lstat(parent);
if (!parentStat.isDirectory() || parentStat.uid!==process.getuid!() || (parentStat.mode&0o022) || await realpath(parent)!==parent) throw new Error('unsafe_store_directory');
await mkdir(directory,{mode:0o700});
execFileSync(process.execPath,['scripts/dev-setup.mjs','--directory',directory],{stdio:'inherit'});
const configPath=join(directory,'control.json');
const raw=JSON.parse(await readFile(configPath,'utf8'));
raw.watchAcceptanceEnabled=true;
raw.limits.models['codex-sol']=1;raw.limits.models['agent-fixture']=1;
await writeFile(configPath,JSON.stringify(raw),{mode:0o600});
execFileSync('npm',['run','db:local','--','--config',configPath],{stdio:'inherit'});
const config=resolveConfig(['--config',configPath,'--port','0']),db=new SqliteDatabase(config.dbPath);
try{await migrate(db,resolve('control-plane/migrations'));}catch(error){db.close();throw error;}
const server=await startServer({db,...config,host:'127.0.0.1'});
const results: {command:string;status:number|null}[]=[];
try {
  await withCleanup(async scope => {
    for(const script of ['integration','development-integration','publication-integration','takt-api-check','watch-api-check','realtime-check']) {
      const file='scripts/'+script+'.ts';
      const child=await startProcess(scope,process.execPath,['--import','tsx',file],{stdio:'inherit',env:{...process.env,CONTROL_CONFIG:configPath,CONTROL_TOKENS:join(directory,'tokens.json'),CONTROL_URL:server.url+'/',CONTROL_EVIDENCE_DIR:join(directory,'evidence')}});
      const status=await new Promise<number|null>((resolve,reject) => {child.once('error',reject);child.once('close',code=>resolve(code));});
      results.push({command:'node --import tsx '+file,status});
      if(status!==0)throw new Error('integration_failed: '+file);
    }
  });
} finally {
  await server.stop();
  await writeFile(join(directory,'results.json'),JSON.stringify({dbPath:config.dbPath,results},null,2),{mode:0o600});
  process.stdout.write('Integration evidence: '+directory+'\n');
}
