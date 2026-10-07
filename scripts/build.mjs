import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

rmSync('dist',{recursive:true,force:true});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{stdio:'inherit'});
cpSync('control-plane/migrations','dist/control-plane/migrations',{recursive:true});
writeFileSync('dist/package.json',JSON.stringify({private:true,type:'module'}));
for (const file of readdirSync('dist',{recursive:true})) {
  if (file.endsWith('.js')) execFileSync(process.execPath,['--check',join('dist',file)],{stdio:'inherit'});
}
