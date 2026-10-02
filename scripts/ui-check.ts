import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const executablePath=process.env.BROWSER_BIN;if(!executablePath)throw Error('BROWSER_BIN must point to an existing Chromium executable');
const browser=await chromium.launch({executablePath,headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});const errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.CONTROL_URL||'http://127.0.0.1:8787/');assert.equal(await page.locator('article').count(),0);
 const tokens=JSON.parse(await readFile('.local/tokens.json','utf8'));await page.locator('#token').fill(tokens.viewer);await page.locator('form button').click();
 await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.startsWith('更新:'));
 assert(await page.locator('article').count()>0);assert.equal(await page.locator('#token').inputValue(),'');
 if(process.env.EXPECT_GENERIC==='true'){
  assert(await page.locator('article').filter({hasText:'agent-fixture / alice'}).count()>0);
  assert(await page.locator('article').filter({hasText:'alice: 5'}).count()>0);
 }
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await mkdir('.local/evidence',{recursive:true});await page.screenshot({path:'.local/evidence/mobile.png',fullPage:true});
 await page.locator('#logout').click();assert.equal(await page.locator('article').count(),0);assert.deepEqual(errors,[]);
 console.log('Chromium mobile 390px: authenticated results, no horizontal overflow, no JS errors, logout clears results.');
}finally{await browser.close();}
