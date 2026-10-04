import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const tokens=JSON.parse(await readFile('.local/tokens.json','utf8')),status=JSON.parse(await readFile('.local/evidence/takt-publish-live.json','utf8'));
const outcome=JSON.parse(status.result),{id}=JSON.parse(await readFile('.local/evidence/takt-publish-id.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH,headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto((process.env.CONTROL_URL||'http://127.0.0.1:8799/')+'development');
 await page.locator('#token').fill(tokens.viewer);await page.locator('#login button').click();await page.locator('#workspace').waitFor({state:'visible'});
 await page.locator('#task-id').fill(id);await page.locator('#refresh').click();await page.locator('#pr-link').waitFor({state:'visible'});
 assert.equal(await page.locator('#pr-link').getAttribute('href'),outcome.prUrl);assert.equal(await page.locator('#status').textContent(),'succeeded');
 await page.screenshot({path:'.local/evidence/takt-publish-mobile.png',fullPage:true});
 await page.locator('#logout').click();assert.equal(await page.locator('#pr-link').getAttribute('href'),null);assert.equal(await page.locator('#pr-link').isHidden(),true);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({mobileViewport:true,actualTask:id,actualPrUrl:outcome.prUrl,resultLinkVerified:true,logoutClears:true}));
}finally{await browser.close();}
