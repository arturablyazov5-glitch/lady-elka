// Offline real Chrome QA; every publication request is intercepted, never sent to GitHub/Supabase.
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'/Users/rafael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const publicRoot=path.resolve('app/public');
const server=createServer(async(req,res)=>{
 try{const pathname=new URL(req.url,'http://offline').pathname;const file=path.resolve(publicRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(publicRoot+'/'))throw Error();
 const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const results=[];await mkdir('agent-context/task-button-qa',{recursive:true});
 for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:1000}});let posts=0,mode='success';
  await context.addInitScript(()=>localStorage.setItem('lady-elka-tour-completed','1'));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
   if(url.pathname==='/api/catalog')return route.fulfill({json:{products:[],settings:{revision:1,types:[{id:'green',name:'Зелёная'}],discount_pct:0,adjustment_pct:0},origin:base}});
   if(url.pathname==='/api/publish-status')return route.fulfill({json:{lastRun:{date:'2026-10-10T08:00:00Z',status:'success',conclusion:'skipped',url:'https://github.com/arturablyazov5-glitch/lady-elka-cloud-preview/actions/runs/123'}}});
   if(url.pathname==='/api/publish-site'){posts++;assert.equal(route.request().headers()['x-catalog-request'],'1');return mode==='limited'?route.fulfill({status:429,headers:{'Retry-After':'1'},json:{error:'Слишком часто. Повторите через 1 с.'}}):route.fulfill({status:202,json:{accepted:true,message:'Запрос принят. Пересборка занимает 5–10 минут.'}});}
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
   return route.continue();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  const skip=page.getByRole('button',{name:'Пропустить',exact:true});if(await skip.isVisible())await skip.click();
  await page.locator('#publish-status').filter({hasText:'Пропущена'}).waitFor();
  await page.locator('#publish-site').click();await page.getByRole('dialog',{name:'Обновить сайт?'}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'publish-cancel');await page.keyboard.press('Escape');assert.equal(posts,0);
  await page.locator('#publish-site').click();await page.locator('#publish-cancel').click();assert.equal(posts,0);
  await page.locator('#publish-site').click();await page.locator('#publish-confirm-submit').click();await page.locator('#publish-feedback[data-state="accepted"]').waitFor();assert.equal(posts,1);assert.equal(await page.locator('#publish-site').isDisabled(),true);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);assert.deepEqual(errors,[]);
  await page.screenshot({path:`agent-context/task-button-qa/${width}.png`,fullPage:false});
  await page.reload();mode='limited';if(await skip.isVisible())await skip.click();await page.locator('#publish-site').click();await page.locator('#publish-confirm-submit').click();await page.locator('#publish-feedback[data-state="limited"]').waitFor();assert.equal(posts,2);await page.waitForTimeout(1100);assert.equal(await page.locator('#publish-site').isDisabled(),false);
  results.push({width,confirmation:true,cancelAndEscape:true,accepted:true,rateLimit:true,overflow,errors});await context.close();
 }
 await writeFile('agent-context/task-button-qa/results.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
