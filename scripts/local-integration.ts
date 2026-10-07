import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveConfig } from '../control-plane/local.ts';

export async function integrationConfig() {
  const configPath=resolve(process.env.CONTROL_CONFIG ?? '.local/control.json');
  const config=resolveConfig(['--config',configPath]);
  const tokens=JSON.parse(await readFile(process.env.CONTROL_TOKENS ?? join(dirname(configPath),'tokens.json'),'utf8')) as {viewer:string;worker:string;other:string};
  const base=process.env.CONTROL_URL ?? 'http://127.0.0.1:'+config.port+'/';
  const evidence=resolve(process.env.CONTROL_EVIDENCE_DIR ?? join(dirname(configPath),'evidence'));
  await mkdir(evidence,{recursive:true,mode:0o700});
  return {tokens,base,evidence,dbPath:config.dbPath};
}
