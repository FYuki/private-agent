import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const cloudflarePackage=name=>/^(?:@cloudflare\/|@workerd\/|wrangler$|workerd$|miniflare$)/i.test(name);
const manifest=JSON.parse(readFileSync('package.json','utf8'));
for(const name of Object.keys({...manifest.dependencies,...manifest.devDependencies}))assert.equal(cloudflarePackage(name),false,'Cloudflare dependency: '+name);
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
for(const path of Object.keys(lock.packages))assert.equal(cloudflarePackage(path.split('node_modules/').at(-1)),false,'Cloudflare lock entry: '+path);
for(const [name,command] of Object.entries(manifest.scripts))assert.doesNotMatch(command,/\b(?:wrangler|workerd|miniflare)\b/i,name);
assert.equal(existsSync('wrangler.jsonc'),false);
const forbidden=/(?:from\s*|import\s*\(?|require\s*\()\s*['"](?:cloudflare:|@cloudflare\/|wrangler|workerd|miniflare)|\b(?:D1Database|D1PreparedStatement|D1Meta|ScheduledController)\b/;
// Match runtime imports and binding types, not historical prose or TAKT workflow names.
for(const directory of ['control-plane','scripts','shared','agent','development','wsl-worker']) {
  for(const file of readdirSync(directory,{recursive:true})) {
    if(!/\.(?:ts|mjs)$/.test(file)||file==='check-local-dependencies.mjs')continue;
    const path=join(directory,file);
    assert.doesNotMatch(readFileSync(path,'utf8'),forbidden,path);
  }
}
assert.doesNotMatch(readFileSync('tsconfig.json','utf8'),/@cloudflare\//);
process.stdout.write('Local runtime and dependency graph verified\n');
