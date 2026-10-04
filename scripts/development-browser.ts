import { chromium } from 'playwright-core';
import { readFile,mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.CONTROL_URL||'http://127.0.0.1:8787/',tokens=JSON.parse(await readFile('.local/tokens.json','utf8'));
if(!process.env.BROWSER_PATH)throw Error('existing_browser_path_required');
const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH,headless:true});
try{const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'development');await page.locator('#token').fill(tokens.viewer);await page.locator('#login button').click();await page.locator('#workspace').waitFor({state:'visible'});
 assert.equal(await page.locator('#orchestrator').inputValue(),'programmatic');assert.notEqual(await page.locator('#executor option[value="edit-claude"]').getAttribute('disabled'),null);
 await page.locator('#executor').selectOption('takt-simple');assert.equal(await page.locator('#orchestrator').inputValue(),'programmatic');
 await page.locator('#goal').fill('Synthetic browser lifecycle, no model execution');await page.locator('#criteria').fill('cancel succeeds');await page.locator('#submit').click();await page.waitForFunction(()=>!!(document.querySelector('#task-id') as HTMLInputElement).value);await page.locator('#cancel').click();await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='cancelled');
 await mkdir('.local/evidence',{recursive:true});await page.screenshot({path:'.local/evidence/development-mobile.png',fullPage:true});await page.locator('#logout').click();assert.equal(await page.locator('#result').textContent(),'');assert.equal(await page.locator('#workspace').isHidden(),true);assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:true,mobileViewport:true,profileSelection:true,submitCancel:true,logoutClears:true}));
}finally{await browser.close();}
