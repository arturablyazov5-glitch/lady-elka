// Existing Chrome + Node WebSocket only. No installs; no storefront build outputs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const browser = process.env.CHECKOUT_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const entry = `import {initCheckout} from './storefront/client/checkout.js';
import * as cart from './storefront/client/cart-store.js';
window.__LE_STOREFRONT_CONFIG__={mode:'preview',catalog:{trees:'/trees.csv',decor:'/decor.csv'},payment:'/pay'};
const nativeStorage=window.sessionStorage;
const mode=new URL(location.href).searchParams.get('failure');
if(mode==='missing') Object.defineProperty(window,'sessionStorage',{value:undefined});
else if(mode==='getter') Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('blocked','SecurityError')}});
else if(mode) Object.defineProperty(window,'sessionStorage',{value:{
 getItem(k){if(k==='lady_elka_pending_order_v1' && mode==='read')throw new Error('read');
 if(k==='lady_elka_pending_order_v1' && mode==='corrupt')return '{}';return nativeStorage.getItem(k)},
 setItem(k,v){if(k==='lady_elka_pending_order_v1'){if(mode==='quota')throw new DOMException('quota','QuotaExceededError');if(mode==='noop')return;}nativeStorage.setItem(k,v)},removeItem(k){nativeStorage.removeItem(k)}}});
window.qa={cart, nativeStorage};
initCheckout(document.querySelector('form'),()=>null);window.qa.ready=true;`;
const compiled = await build({stdin:{contents:entry,resolveDir:process.cwd(),sourcefile:'offline-qa.js'},bundle:true,format:'iife',write:false});
const html = `<!doctype html><meta charset="utf-8"><title>Offline checkout QA</title><form>
<input data-checkout-field="name" placeholder="Иван Иванов"><input data-checkout-field="email" type="email"><input data-checkout-field="phone" type="tel"><input data-checkout-field="address" placeholder="Адрес доставки">
<div data-field-position="9"><select data-checkout-field="contactPref"><option>Telegram</option></select></div>
<div data-field-position="8"><select data-checkout-field="paymentMethod"><option value="cash_on_delivery">Оплата при получении</option><option value="card">Оплата картой</option></select></div>
<textarea data-checkout-field="comment"></textarea><input data-checkout-field="consent" type="checkbox"><button data-pay-now><span class="text-block-wrap-div">купить</span></button></form><script src="/qa.js"></script>`;
let posts=[], catalogDown=false, responseMode='lost';const accepted=new Map();
const server=createServer(async(req,res)=>{
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
 res.setHeader('Cache-Control','no-store');
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 if(path==='/qa'){res.setHeader('Content-Type','text/html');return res.end(html)}
 if(path==='/qa.js'){res.setHeader('Content-Type','text/javascript');return res.end(compiled.outputFiles[0].text)}
 if(path==='/trees.csv'||path==='/decor.csv'){
   if(catalogDown){res.writeHead(503);return res.end('unavailable')}
   return res.end(path==='/trees.csv'?'id,title,active,category,height_cm,price\n1,Тестовое дерево,1,Зелёная,180,1000\n':'id,title,active,category,variants,price\n');
 }
 if(path==='/pay'&&req.method==='POST'){
   let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);posts.push(payload);
   if(accepted.has(payload.orderId))assert.equal(accepted.get(payload.orderId),raw);else accepted.set(payload.orderId,raw);
   if(responseMode==='lost'){res.setHeader('Content-Type','application/json');return res.end('{');} // accepted, but reply body lost/unparseable; no transport retry
   res.setHeader('Content-Type','application/json');
   return res.end(JSON.stringify(payload.paymentMethod==='card'?{paid:true,orderId:payload.orderId}:{ok:true,orderId:payload.orderId}));
 }
 res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=await mkdtemp(join(tmpdir(),'checkout-browser-offline-'));
let chrome,ws,scenarioError;const pending=new Map();const listeners=new Map();let seq=0;const blocked=[];
const command=(method,params={})=>new Promise((resolve,reject)=>{
 const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});
const evaluate=async expression=>{
 const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
};
const until=async(expression)=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,20))}throw new Error(`timeout ${expression}`)};
const navigate=async(url)=>{const previous=await evaluate('performance.timeOrigin');await command('Page.navigate',{url});await until(`performance.timeOrigin!==${previous} && window.qa?.ready===true`)};
const snapshot=()=>evaluate(`({fields:[...document.querySelectorAll('input,select,textarea')].map(e=>({value:e.value,checked:e.checked})),cart:qa.cart.getItems(),name:document.querySelector('[data-checkout-field="name"]').value,comment:document.querySelector('textarea').value,consent:document.querySelector('[data-checkout-field="consent"]').checked,disabled:document.querySelector('button').disabled,notice:document.querySelector('[data-checkout-notice]').textContent,pending:qa.nativeStorage.getItem('lady_elka_pending_order_v1'),draft:qa.nativeStorage.getItem('lady_elka_checkout_draft_v1')})`);
const fill=async method=>evaluate(`qa.cart.clear();qa.cart.add({id:'1',title:'Тестовое дерево',kind:'tree'},{id:'1:Зелёная:180',price:1000,options:{category:'Зелёная',height:'180'}});
 document.querySelector('[data-checkout-field="name"]').value='Тест';document.querySelector('[data-checkout-field="email"]').value='qa@example.test';document.querySelector('[data-checkout-field="phone"]').value='+79990000000';document.querySelector('[data-checkout-field="address"]').value='Синтетический адрес';document.querySelector('textarea').value='Синтетический комментарий';document.querySelector('[data-checkout-field="consent"]').checked=true;document.querySelector('[data-checkout-field="paymentMethod"]').value=${JSON.stringify(method.includes('получении') ? 'cash_on_delivery' : 'card')};document.querySelector('form').dispatchEvent(new Event('input',{bubbles:true}));`);
const submit=async()=>{await evaluate(`document.querySelector('form').requestSubmit()`);await until(`!document.querySelector('button').disabled && document.querySelector('[data-checkout-notice]').textContent.length>0`)};
try{
 // Fail closed before Chrome starts; loopback is the only proxy bypass. No persistent user profile.
 chrome=spawn(browser,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-quic','--disable-domain-reliability','--metrics-recording-only','--disable-features=MediaRouter,OptimizationHints','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
 const endpoint=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(new Error('Chrome CDP startup timeout')),15000);chrome.stderr.on('data',b=>{s+=b;const m=s.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1])}});chrome.once('error',error=>{clearTimeout(timer);reject(error)});chrome.once('exit',code=>{clearTimeout(timer);reject(new Error(`Chrome exited during startup: ${code}`))})});
 const httpEndpoint=endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/, '/json/list');
 const pages=await (await fetch(httpEndpoint)).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result)}else listeners.get(msg.method)?.(msg.params)};
 listeners.set('Fetch.requestPaused',async p=>{const u=new URL(p.request.url);const allowed=u.origin===origin && ['/qa','/qa.js','/trees.csv','/decor.csv','/pay'].includes(u.pathname);
 if(!allowed)blocked.push({url:p.request.url,type:p.resourceType});await command(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'});});
 await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await command('Network.setBypassServiceWorker',{bypass:true});
 await command('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
 if(process.env.CHECKOUT_QA_FAIL_AFTER_START==='1')throw new Error('Injected scenario failure after Chrome startup');
 const evidence=[];
 for(const method of ['Оплата при получении','Оплата картой']){
  for(const failure of ['missing','getter','quota','read','noop','corrupt']){
   posts=[];catalogDown=false;await navigate(`${origin}/qa?failure=${failure}`);await evaluate('qa.nativeStorage.clear();localStorage.clear()');await fill(method);await submit();const state=await snapshot();
   assert.equal(posts.length,0);assert.equal(state.cart.length,1);assert.equal(state.name,'Тест');assert.equal(state.comment,'Синтетический комментарий');assert.equal(state.disabled,false);assert.match(state.notice,/Отправка остановлена/);
   evidence.push({method,failure,posts:0,formPreserved:true,cartPreserved:true});
  }
  posts=[];catalogDown=false;responseMode='lost';await navigate(`${origin}/qa`);await evaluate('qa.nativeStorage.clear();localStorage.clear()');await navigate(`${origin}/qa`);await fill(method);await submit();
  assert.equal(posts.length,1);assert.ok(accepted.has(posts[0].orderId));const first=structuredClone(posts[0]);const before=await snapshot();assert.deepEqual(JSON.parse(before.pending).payload,first);assert.equal(before.cart.length,1);
  catalogDown=true;responseMode='success';const oldTime=await evaluate('performance.timeOrigin');
  await command('Page.reload',{ignoreCache:true});await until(`window.qa?.ready===true && performance.timeOrigin!==${oldTime}`);
  const restored=await snapshot();assert.deepEqual(restored.fields,before.fields);assert.equal(restored.name,before.name);assert.equal(restored.comment,before.comment);assert.equal(restored.consent,true);assert.deepEqual(restored.cart,before.cart);assert.equal(restored.pending,before.pending);
  await submit();assert.equal(posts.length,2);assert.deepEqual(posts[1],first);const completed=await snapshot();assert.equal(completed.cart.length,0);assert.equal(completed.pending,null);assert.equal(completed.draft,null);
  evidence.push({method,lostResponse:true,realReload:true,identicalFullPayload:true,identicalOrderId:true,formAndCartRestored:true,catalogUnavailableOnReplay:true});
 }
 // Probe isolation without a production hostname or a real outbound request.
 const count=blocked.length;await command('Page.setBypassCSP',{enabled:true});
 const rejected=await evaluate(`fetch('https://external.invalid/probe').then(()=>false,()=>true)`);
 assert.equal(rejected,true);
 // Loopback disallowed path proves the CDP gate independently of DNS/proxy/CSP.
 const gateRejected=await evaluate(`fetch('/forbidden-network-probe').then(()=>false,()=>true)`);
 assert.equal(gateRejected,true);assert.ok(blocked.slice(count).some(r=>r.url.endsWith('/forbidden-network-probe')));await command('Page.setBypassCSP',{enabled:false});
 // CSP may reject even before CDP interception. Both barriers exist before initial navigation.
 evidence.push({isolation:'proxy deny + DNS deny + CDP allowlist before navigation + CSP + service-worker bypass',probeRejected:true,blockedRequests:blocked.length-count});
 console.log(JSON.stringify({browser:await command('Browser.getVersion'),scenarios:evidence.length,evidence},null,2));
 }catch(error){scenarioError=error;throw error;}finally{
 try{
 // Only our detached ephemeral process group; never signal a browser by name.
 ws?.close();
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 let processCleanupError;
 try{if(chrome?.pid){
  const signal=name=>{try{process.kill(-chrome.pid,name)}catch(error){if(error.code!=='ESRCH')throw error}};
  const alive=()=>{try{process.kill(-chrome.pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}};
  signal('SIGTERM');
  for(let attempt=0;attempt<30 && alive();attempt++)await delay(100);
  if(alive())signal('SIGKILL');
  for(let attempt=0;attempt<20 && alive();attempt++)await delay(100);
  if(alive())throw new Error('Ephemeral Chrome process group did not terminate');
 }
 }catch(error){processCleanupError=error}
 server.closeAllConnections();
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150});
 if(processCleanupError)throw processCleanupError;
 console.log('Offline QA cleanup complete');
 }catch(error){throw scenarioError?new AggregateError([scenarioError,error],'Scenario and cleanup both failed'):error;}
}
