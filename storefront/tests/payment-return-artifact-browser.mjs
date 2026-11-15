import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,extname,sep,join} from 'node:path';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON||import.meta.url)('playwright');
const root=process.env.LE_QA_ARTIFACT||'/Users/rafael/Documents/lady-elka-release-2026-10-13/site';
const endpoint='https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay-v2';
const payload={orderId:'LE-1791860000000-180-12345678',paymentMethod:'card',items:[{kind:'tree',productId:'1',variantId:'1:Зелёная:180',quantity:1,price:1000}]};
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const evidence=[];
try{
 for(const width of [390,1440]){
 const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});let checks=0;
 await context.addInitScript(({payload,endpoint})=>{if(location.origin!=='https://lady-elka.ru')return;sessionStorage.setItem('lady_elka_pending_order_v1',JSON.stringify({endpoint,payload}));localStorage.setItem('lady_elka_cart_v2',JSON.stringify(payload.items));},{payload,endpoint});
 await context.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.origin==='https://lady-elka.ru'){
 let file=resolve(root,'.'+u.pathname);if(!file.startsWith(resolve(root)+sep))return route.abort();if(u.pathname.endsWith('/'))file=join(file,'index.html');
 try{return route.fulfill({body:await readFile(file),contentType:mime[extname(file)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:'not found'});}
 }
 if(u.origin+u.pathname===endpoint&&u.search==='?action=order-status'){
 assert.deepEqual(route.request().postDataJSON(),payload);checks++;return route.fulfill({json:{ok:true,orderId:payload.orderId,paid:true,status:'paid'}});
 }
 return route.abort();
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('https://lady-elka.ru/spasibo/?oid='+payload.orderId);
 try{await page.getByRole('heading',{name:'Заказ оплачен',exact:true}).waitFor({timeout:10000});}catch(e){console.log({checks,errors,state:await page.evaluate(()=>({title:document.querySelector('h1')?.innerText,notice:document.querySelector('[data-payment-return]')?.innerText,payment:window.__LE_STOREFRONT_CONFIG__?.payment,pending:sessionStorage.getItem('lady_elka_pending_order_v1')}))});throw e;}
 const data=await page.evaluate(()=>({width:innerWidth,contentWidth:document.documentElement.scrollWidth,notice:document.querySelector('[data-payment-return]').innerText,cart:JSON.parse(localStorage.getItem('lady_elka_cart_v2')),region:document.querySelector('[data-payment-return]').getBoundingClientRect().toJSON()}));
 assert.equal(data.cart.length,0);assert.ok(data.contentWidth<=width);assert.equal(checks,1);
 await page.screenshot({path:root+'/../payment-return-'+width+'.png',fullPage:true});evidence.push(data);await context.close();
 }
 await writeFile('audit/pay-v2/payment-return-artifact-browser.json',JSON.stringify({time:new Date().toISOString(),providers:'synthetic, all network intercepted',evidence},null,2));console.log(JSON.stringify({passed:evidence.length,viewports:evidence.map(x=>x.width)}));
}finally{await browser.close();}
