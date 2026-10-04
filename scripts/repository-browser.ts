import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {developmentHtml,developmentScript} from '../control-plane/development-ui.ts';
import {repositoryChoices} from '../shared/repositories.ts';
import {DEVELOPMENT_DEFAULTS,DEVELOPMENT_PROFILES} from '../shared/development.ts';

// 合成HTTP応答だけでGUIの契約を確認する。task起票・モデル呼出し・外部公開はしない。
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/development.js'?'text/javascript':'text/html');res.end(req.url==='/development.js'?developmentScript:developmentHtml);});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH,headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));let submitted:any;
 await page.route('**/api/development/**',route=>{
  const url=route.request().url();
  if(url.endsWith('/config'))return route.fulfill({json:{repositories:repositoryChoices,repoId:'private-agent',baseRef:'epic/development-runner',defaults:DEVELOPMENT_DEFAULTS,profiles:DEVELOPMENT_PROFILES,capacity:{models:{"codex-sol":5,"codex-luna":30},sharedGroupLimit:35}}});
  if(route.request().method()==='POST'){submitted=route.request().postDataJSON();return route.fulfill({json:{id:'00000000-0000-4000-8000-000000000000'}});}
  return route.fulfill({json:{state:'succeeded',spec:submitted,result:JSON.stringify({outcome:'local_only',artifactId:'synthetic'})}});
 });
 await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port+'/development');
 await page.locator('#token').fill('synthetic-only');await page.locator('#login button').click();await page.locator('#workspace').waitFor({state:'visible'});
 assert.match(await page.locator('#capacity').innerText(),/Sol 5.*Luna 30.*共有 35/);
 await page.selectOption('#repository','local-GPT-live');assert.match(await page.locator('#target').innerText(),/epic\/transport-playback/);
 await page.locator('#goal').fill('synthetic only');await page.locator('#criteria').fill('synthetic result');await page.locator('#submit').click();
 await page.waitForFunction(()=>document.getElementById('result')?.textContent?.includes('local_only'));
 assert.equal(submitted.repoId,'local-GPT-live');assert.equal(submitted.executionProfileId,'takt-simple');assert.equal(await page.locator('#pr-link').isHidden(),true);
 await page.locator('#logout').click();assert.equal(await page.locator('#result').textContent(),'');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({mobile:true,repositoryChoice:true,localOnlyResult:true,logoutClears:true,synthetic:true,realTask:false}));
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
