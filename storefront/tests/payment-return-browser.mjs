// Real browser + current checkout/return modules + deployed-entry source + PostgreSQL fixtures.
// All providers synthetic. External traffic is denied before network.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {payDatabase} from '../../supabase/functions/pay/tests/helpers.mjs';
import {preparePayV2,names} from '../../scripts/prepare-pay-v2.mjs';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON||import.meta.url)('playwright');
await preparePayV2();const database=await payDatabase();let serve;
const original={Deno:globalThis.Deno,fetch:globalThis.fetch};
const token='synthetic-test-worker-'.padEnd(64,'x');
const env={LE_V2_ADMISSION:'enabled',LE_V2_WORKER_TOKEN:token,TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'123',ALFA_API_USER:'synthetic',ALFA_API_PASS:'synthetic',ALFA_API_BASE:'https://bank.test/payment/rest',SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic'};
globalThis.Deno={env:{get:k=>env[k]},serve:fn=>serve=fn,createHttpClient:()=>({})};
const backend=await build({entryPoints:['supabase/functions/pay-v2/index.ts'],bundle:true,platform:'node',format:'esm',write:false});await import('data:text/javascript;base64,'+Buffer.from(backend.outputFiles[0].text).toString('base64')+'#browser');
const origin='http://127.0.0.1:4176',bankOrders=new Map();const messages=[],registrations=[];let statusDown=false;
globalThis.fetch=async(url,options={})=>{
 const u=new URL(String(url));
 if(u.host==='db.test'){
 const path=u.pathname.slice('/rest/v1/'.length)+u.search;assert.match(path,/^(?:rpc\/)?le_v2_/);
 return database.request(path.replace(/^(rpc\/)?([a-z0-9_]+)(?=\?|$)/,(_,rpc='',name)=>rpc+Object.keys(names).find(k=>names[k]===name)),options);
 }
 if(u.pathname.endsWith('/trees.csv'))return new Response('id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,1000\n');
 if(u.pathname.endsWith('/decor.csv'))return new Response('id,title,active,category,variants,price\n');
 if(u.pathname.endsWith('/promos.csv'))return new Response('promocode,ruble-offer,percent-offer,gift-offer\n');
 if(u.pathname.endsWith('/register.do')){
 const form=new URLSearchParams(options.body),oid=form.get('orderNumber'),id='00000000-0000-0000-0000-'+String(bankOrders.size+1).padStart(12,'0');
 const row={orderNumber:oid,orderId:id,amount:Number(form.get('amount')),orderStatus:0};bankOrders.set(id,row);registrations.push(row);
 return Response.json({orderId:id,formUrl:origin+'/bank?oid='+oid});
 }
 if(u.pathname.endsWith('/getOrderStatusExtended.do')){if(statusDown)throw Error('Synthetic bank unavailable');return Response.json(bankOrders.get(new URLSearchParams(options.body).get('orderId')));}
 if(u.host==='api.telegram.org'){messages.push(JSON.parse(options.body));return Response.json({ok:true,result:{message_id:messages.length}});}
 throw Error('Unexpected fixture destination '+u.host);
};
const entry=`import {initCheckout} from './storefront/client/checkout.js';import {initPaymentReturn} from './storefront/client/payment-return.js';import * as cart from './storefront/client/cart-store.js';
window.__LE_STOREFRONT_CONFIG__={mode:'production',payment:'/functions/v1/pay-v2',catalog:{trees:'/trees.csv',decor:'/decor.csv'}};window.qa={cart};
if(location.pathname==='/checkout')initCheckout(document.querySelector('form'),()=>null,cart);else initPaymentReturn(cart);`;
const client=await build({stdin:{contents:entry,resolveDir:process.cwd()},bundle:true,format:'iife',write:false});
const form=`<form><input data-checkout-field="name"><input type="email" data-checkout-field="email"><input type="tel" data-checkout-field="phone"><input data-checkout-field="address"><select data-checkout-field="contactPref"><option>Telegram</option></select><select data-checkout-field="paymentMethod"><option value="card">Карта</option><option value="cash_on_delivery">При получении</option></select><textarea data-checkout-field="comment"></textarea><input type="checkbox" data-checkout-field="consent"><button data-pay-now><span class="text-block-wrap-div">купить</span></button></form>`;
let requestNo=0;const server=createServer(async(req,res)=>{
 try{
 const path=new URL(req.url,origin).pathname;
 if(path==='/functions/v1/pay-v2'){
 let body='';for await(const part of req)body+=part;
 const result=await serve(new Request(origin+req.url,{method:'POST',headers:{'Content-Type':'application/json',origin:'https://lady-elka.ru','x-forwarded-for':'browser-'+(++requestNo)},body}));
 res.writeHead(result.status,{'Content-Type':'application/json'});return res.end(await result.text());
 }
 if(path==='/qa.js'){res.setHeader('Content-Type','application/javascript');return res.end(client.outputFiles[0].text);}
 if(path==='/trees.csv'||path==='/decor.csv'){const result=await globalThis.fetch(origin+path);return res.end(await result.text());}
 res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');
 res.end(`<!doctype html><meta charset="utf-8"><h1><span class="text-block-wrap-div">${path==='/bank'?'Synthetic bank':'Спасибо'}</span></h1>${path==='/checkout'?form:''}<script src="/qa.js"></script>`);
 }catch(error){res.writeHead(500);res.end('fixture error');}
});
let browser;const evidence=[];
try{
 await new Promise((r,j)=>{server.once('error',j);server.listen(4176,'127.0.0.1',r);});
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();
 const fill=async()=>page.evaluate(()=>{
 qa.cart.clear();qa.cart.add({id:'1',kind:'tree',title:'Миранда'},{id:'1:Зелёная:180',price:1000,options:{category:'Зелёная',height:'180'}});
 for(const [key,value]of Object.entries({name:'Synthetic',email:'qa@example.test',phone:'+79991234567',address:'Synthetic',contactPref:'Telegram',comment:'Synthetic'}))document.querySelector(`[data-checkout-field="${key}"]`).value=value;
 document.querySelector('[data-checkout-field=consent]').checked=true;
 });
 const begin=async()=>{await page.goto(origin+'/checkout');await fill();await page.locator('[data-pay-now]').click();await page.waitForURL('**/bank?oid=*');return new URL(page.url()).searchParams.get('oid');};
 const oid=await begin();assert.equal(registrations.length,1);
 await page.goto(origin+'/spasibo/?oid='+oid);await page.getByRole('heading',{name:'Ожидаем подтверждение оплаты'}).waitFor();
 assert.equal(await page.evaluate(()=>qa.cart.getItems().length),1);assert.equal(messages.length,0);evidence.push('unpaid return preserves cart and pending');
 statusDown=true;await page.getByRole('button',{name:'Проверить оплату'}).click();await page.getByRole('heading',{name:'Статус оплаты пока недоступен'}).waitFor();assert.equal(await page.evaluate(()=>qa.cart.getItems().length),1);evidence.push('bank outage preserves cart and pending');
 statusDown=false;registrations[0].orderStatus=2;await page.getByRole('button',{name:'Проверить оплату'}).click();await page.getByRole('heading',{name:'Заказ оплачен',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>qa.cart.getItems().length),0);assert.equal(messages.length,1);assert.equal(registrations.length,1);evidence.push('paid return clears purchased cart; one bank registration and notification');
 await page.reload();await page.getByRole('heading',{name:'Заказ оплачен',exact:true}).waitFor();assert.equal(messages.length,1);evidence.push('paid F5 re-verifies without duplicate notification');
 const second=await begin();registrations[1].orderStatus=6;await page.goto(origin+'/pay-return/?fail=1&oid='+second);await page.getByRole('heading',{name:'Оплата не завершена',exact:true}).waitFor();assert.equal(await page.evaluate(()=>qa.cart.getItems().length),1);assert.equal(messages.length,1);evidence.push('cancelled return preserves cart and sends no notification');
 registrations[1].orderStatus=2;await page.evaluate(()=>qa.cart.setQuantity('1','1:Зелёная:180',2));await page.getByRole('button',{name:'Проверить оплату'}).click();await page.getByRole('heading',{name:'Заказ оплачен',exact:true}).waitFor();assert.equal(await page.evaluate(()=>qa.cart.getItems()[0].quantity),2);evidence.push('paid return does not erase changed cart');
 await page.goto(origin+'/spasibo/?oid=unknown');await page.getByRole('heading',{name:'Статус оплаты требует проверки'}).waitFor();assert.equal(messages.length,2);evidence.push('unknown return cannot confirm payment');
 await page.goto(origin+'/checkout');await fill();await page.evaluate(()=>{const p=JSON.parse(sessionStorage.getItem('lady_elka_paid_return_v2'));p.endpoint='/legacy-pay';sessionStorage.setItem('lady_elka_pending_order_v1',JSON.stringify(p));});await page.reload();await fill();await page.locator('[data-pay-now]').click();await page.getByRole('alert').filter({hasText:'прежней версии магазина'}).waitFor();assert.equal(registrations.length,2);evidence.push('legacy pending never registers another bank payment through V2');
 await writeFile('audit/pay-v2/payment-return-browser.json',JSON.stringify({time:new Date().toISOString(),browser:'Chrome',providers:'synthetic only',evidence,registrations:registrations.length,notifications:messages.length},null,2));console.log(JSON.stringify({passed:evidence.length,evidence}));
}finally{
 if(browser)await browser.close();await new Promise(r=>server.close(r));await database.db.close();Object.assign(globalThis,original);
}
