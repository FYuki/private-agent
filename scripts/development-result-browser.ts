import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const tokens=JSON.parse(await readFile('.local/tokens.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH,headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto((process.env.CONTROL_URL||'http://127.0.0.1:8799/')+'development');
 await page.locator('#token').fill(tokens.viewer);await page.locator('#login button').click();await page.locator('#workspace').waitFor({state:'visible'});
 const id='00000000-0000-4000-8000-000000000000',url='https://github.com/FYuki/private-agent/pull/5';
 await page.route('**/api/development/tasks/'+id,route=>route.fulfill({json:{id,state:'succeeded',result:JSON.stringify({prUrl:url,evidence:'synthetic browser response; not a TAKT publication result'})}}));
 await page.locator('#task-id').fill(id);await page.locator('#refresh').click();await page.locator('#pr-link').waitFor({state:'visible'});
 assert.equal(await page.locator('#pr-link').getAttribute('href'),url);
 await mkdir('.local/evidence',{recursive:true});await page.screenshot({path:'.local/evidence/development-result-mobile.png',fullPage:true});
 await page.locator('#logout').click();assert.equal(await page.locator('#pr-link').getAttribute('href'),null);assert.equal(await page.locator('#pr-link').isHidden(),true);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({mobileViewport:true,resultFixture:true,resultLinkVerified:true,logoutClears:true,realPublication:false}));
}finally{await browser.close();}
