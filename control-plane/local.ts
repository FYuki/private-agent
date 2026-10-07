import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { capacity, exact, object, str, integer } from '../shared/contracts.ts';
import { SqliteDatabase } from './sqlite.ts';
import { migrate } from './migrations.ts';
import { startServer } from './server.ts';

export function resolveConfig(args: string[]) {
  let configPath = '.local/control.json', dbPath: string | undefined, port: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const [flag,value] = args.slice(index,index+2);
    if (value === undefined) throw new Error('option_value_required');
    if (flag === '--config') configPath = str(value,4096);
    else if (flag === '--db') dbPath = str(value,4096);
    else if (flag === '--port') port = integer(Number(value),0,65535);
    else throw new Error('unknown_local_option');
  }
  const config = object(JSON.parse(readFileSync(configPath,'utf8')));
  exact(config,['dbPath','authJson','limits','port','scheduleEnabled','watchAcceptanceEnabled']);
  for (const flag of ['scheduleEnabled','watchAcceptanceEnabled']) if (config[flag] !== undefined && typeof config[flag] !== 'boolean') throw new Error('invalid_local_flag');
  const authJson = str(config.authJson,64000);
  if (!Array.isArray(JSON.parse(authJson)) || !JSON.parse(authJson).length) throw new Error('authentication_not_configured');
  return {dbPath:resolve(dbPath ?? str(config.dbPath,4096)),port:port ?? integer(config.port ?? 8787,0,65535),authJson,limits:capacity(config.limits),scheduleEnabled:config.scheduleEnabled === true,watchAcceptanceEnabled:config.watchAcceptanceEnabled === true};
}

async function main() {
  const [command,...args] = process.argv.slice(2);
  if (!['serve','migrate'].includes(command)) throw new Error('local_command_required');
  const config = resolveConfig(args), db = new SqliteDatabase(config.dbPath);
  try { await migrate(db,fileURLToPath(new URL('./migrations',import.meta.url))); }
  catch (error) { db.close(); throw error; }
  if (command === 'migrate') { db.close(); return; }
  const server = await startServer({db,...config,host:'127.0.0.1'});
  process.stdout.write(JSON.stringify({url:server.url,dbPath:config.dbPath})+'\n');
  const stop = () => { void server.stop().catch(error => {process.stderr.write(String(error)+'\n');process.exitCode=1;}); };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {process.stderr.write(String(error)+'\n');process.exitCode=1;});
}
