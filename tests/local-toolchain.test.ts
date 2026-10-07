import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from './fixtures/local-control.ts';

const cloudflarePackage=(name:string)=>/^(?:@cloudflare\/|@workerd\/|wrangler$|workerd$|miniflare$)/i.test(name);

test('local package commands and full dependency graph require no Cloudflare runtime',()=>{
  execFileSync('npm',['run','check:local'],{timeout:10000,stdio:'pipe'});
  const manifest=JSON.parse(readFileSync('package.json','utf8')) as {dependencies:Record<string,string>;devDependencies:Record<string,string>;scripts:Record<string,string>};
  for(const name of Object.keys({...manifest.dependencies,...manifest.devDependencies}))assert.equal(cloudflarePackage(name),false,'Cloudflare dependency: '+name);
  const lock=JSON.parse(readFileSync('package-lock.json','utf8')) as {packages:Record<string,unknown>};
  for(const path of Object.keys(lock.packages)){
    const name=path.split('node_modules/').at(-1)!;assert.equal(cloudflarePackage(name),false,'Cloudflare lock entry: '+path);
  }
  for(const name of ['dev','db:local','build']){
    assert.ok(manifest.scripts[name]);
    assert.doesNotMatch(manifest.scripts[name],/\b(?:wrangler|workerd|miniflare)\b/i);
  }
});

test('local build generates runnable JavaScript and includes migration SQL',{timeout:60000},()=>{
  // Fail before running the old Wrangler command; this step never invokes deploy.
  const manifest=JSON.parse(readFileSync('package.json','utf8')) as {scripts:{build:string}};
  assert.doesNotMatch(manifest.scripts.build,/\bwrangler\b/i);
  execFileSync('npm',['run','build'],{timeout:45000,stdio:'pipe'});
  assert.ok(existsSync('dist'));
  const files=readdirSync('dist',{recursive:true}).filter((name):name is string=>typeof name==='string');
  const javascript=files.filter(name=>name.endsWith('.js'));
  assert.ok(javascript.length>0,'build must emit executable JavaScript');
  for(const file of javascript)execFileSync(process.execPath,['--check',join('dist',file)],{timeout:5000,stdio:'pipe'});
  for(const name of readdirSync('control-plane/migrations').filter(name=>name.endsWith('.sql'))){
    const emitted=files.find(file=>file.endsWith('/'+name));assert.ok(emitted,'missing built migration '+name);
    assert.equal(readFileSync(join('dist',emitted),'utf8'),readFileSync(join('control-plane/migrations',name),'utf8'));
  }
  const f=temporaryDirectory();
  try {
    const isolated=join(f.directory,'build');cpSync('dist',isolated,{recursive:true});
    const modulePath=(name:string)=>{
      const file=files.find(file=>file.endsWith('/'+name)||file===name);assert.ok(file,'build entry missing: '+name);return resolve(isolated,file);
    };
    const databaseModule=modulePath('sqlite.js'),migrationModule=modulePath('migrations.js'),serverModule=modulePath('server.js');
    execFileSync(process.execPath,[resolve('tests/fixtures/built-control.mjs'),databaseModule,migrationModule,serverModule,join(dirname(migrationModule),'migrations'),f.path],{timeout:10000,stdio:'pipe',env:{PATH:process.env.PATH}});
    assert.ok(existsSync(f.path));
  } finally {f.cleanup();}
});
