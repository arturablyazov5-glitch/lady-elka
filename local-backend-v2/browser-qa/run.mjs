import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {PGlite} from '@electric-sql/pglite';
import {sqlStore} from '../store.mjs';
import {createRouter} from '../router.mjs';
import {contractValidator} from '../contract-adapter.mjs';
import {createEnvelope} from '../../storefront/api-v2/contract.mjs';
const cancellation=new AbortController();
const cancel=()=>cancellation.abort(new Error('QA cancelled'));
process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
const bounded=(promise,ms=10000)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Operation timeout')),ms);timer.unref();})]);
const dir=await mkdtemp(join(tmpdir(),'elka-v2-qa-'));
const db=new PGlite();let server,chrome,ws,transport,primary;
const report={productionReady:false,cases:[],blocked:[],requests:[]};
let registers=0,sends=0,open=true,unknown=false,lose=false,posts=[],evidence=new Map();
try {
 await db.exec(await readFile(new URL('../schema-draft.sql',import.meta.url),'utf8'));
 await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity) VALUES('create',100),('bank',100),('telegram',100); CREATE TABLE public.payment_orders(marker text); INSERT INTO public.payment_orders VALUES('legacy'); CREATE TABLE public.le_orders(marker text); INSERT INTO public.le_orders VALUES('legacy')");
 await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity) VALUES('request',1000),('ownerRequest',1000),('status',100),('replay',100),('callback',100),('internal',100); UPDATE le_checkout_v2.budgets SET window_ms=60000,owner_capacity=capacity; CREATE TABLE le_checkout_v2.fixture_clock(t bigint); INSERT INTO le_checkout_v2.fixture_clock VALUES(60001); CREATE OR REPLACE FUNCTION le_checkout_v2.server_ms() RETURNS bigint LANGUAGE sql VOLATILE AS $$ SELECT t FROM le_checkout_v2.fixture_clock $$");
 const store=sqlStore(db);
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./ui.mjs',import.meta.url))],bundle:true,write:false,platform:'browser',format:'iife'});
 const html='<!doctype html><meta charset="utf-8"><title>Local v2 QA · synthetic</title><h1>Изолированная проверка v2</h1><p>Синтетические данные. productionReady=false</p><button id="replay">Восстановить заказ</button><button id="status">Проверить статус</button><output></output><script src="/qa.js"></script>';
 let route;
 server=createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");res.setHeader('Cache-Control','no-store');
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method==='GET'&&['/qa','/spasibo','/pay-return','/payment-placeholder'].includes(path)){res.setHeader('Content-Type','text/html');res.end(html);return;}
  if(req.method==='GET'&&path==='/qa.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
  if(req.method!=='POST'||path!=='/pay-v2'){res.writeHead(404).end();return;}
  try {
   let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413).end();return;}chunks.push(chunk);}
   const request=JSON.parse(Buffer.concat(chunks));
   // Callback/internal capabilities are never available through this browser HTTP adapter.
   if(!['create','status'].includes(request.route)){res.writeHead(404).end();return;}
   if(request.route==='create')posts.push(structuredClone(request.body));
   const result=await route({...request,credentials:req.headers['x-fixture-capability']});
   if(lose&&request.route==='create'&&result.status===200){lose=false;res.destroy();return;}
   res.writeHead(result.status,{'Content-Type':'application/json',...result.headers}).end(JSON.stringify(result.body));
  }catch{if(!res.destroyed)res.writeHead(400).end();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const origin=`http://127.0.0.1:${server.address().port}`,ownerEndpoint=origin+'/pay-v2';
 const options={store,requestBudgets:{request:'request',ownerRequest:'ownerRequest',status:'status',replay:'replay',callback:'callback',internal:'internal'},identity:{apiVersion:'2',fingerprintVersion:'sha256-canonical-json-v1',ownerEndpoint},budget:'create',effectBudgets:{bank:'bank',telegram:'telegram'},recipients:['synthetic'],paymentOrigins:['https://mock-bank.invalid'],
 validator:contractValidator({ownerEndpoint,verifyCatalog:async()=>({verified:true,fresh:true,revision:'synthetic',amountMinor:100})}),
 auth:{caller:async c=>['alice','bob'].includes(c)?c:null,callback:async c=>c==='callback',internal:async c=>c==='internal'},
 provider:{register:async({order})=>{registers++;return {outcome:unknown?'unknown':'confirmed',paymentId:'mock-'+order.id,bankNumber:order.bank_number,amount:Number(order.amount),paymentURL:'https://mock-bank.invalid/pay'};},evidence:async id=>evidence.get(id)},
 notifier:{send:async()=>{sends++;return {outcome:'confirmed'};}}};
 const resetRoute=()=>{route=createRouter({...options,createOpen:open});};resetRoute();
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-quic','--disable-domain-reliability','--metrics-recording-only','--disable-features=MediaRouter,OptimizationHints','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${dir}`,'--remote-debugging-port=0','about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Chrome startup timeout')),15000);chrome.stderr.on('data',b=>{text+=b;const m=text.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});chrome.once('error',e=>{clearTimeout(timer);reject(e);});chrome.once('exit',c=>{clearTimeout(timer);reject(new Error('Chrome exited '+c));});});
 const pages=await(await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/, '/json/list'),{signal:AbortSignal.timeout(5000)})).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket startup timeout')),5000);ws.onopen=()=>{clearTimeout(timer);resolve();};ws.onerror=()=>{clearTimeout(timer);reject(new Error('WebSocket failed'));};});
 // Independent owned transport; bounded commands and caught interception failures.
 let seq=0,failure,closing=false;const pending=new Map(),events=new Set();
 const command=(method,params={})=>new Promise((resolve,reject)=>{if(cancellation.signal.aborted)return reject(cancellation.signal.reason);if(failure||closing)return reject(failure||new Error('closed'));const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 cancellation.signal.addEventListener('abort',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(cancellation.signal.reason);}pending.clear();},{once:true});
 ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}else if(m.method==='Fetch.requestPaused'){
  const p=m.params,u=new URL(p.request.url);report.requests.push({url:u.href,method:p.request.method});
  const allowed=u.origin===origin&&((p.request.method==='GET'&&['/qa','/qa.js','/spasibo','/pay-return','/payment-placeholder'].includes(u.pathname))||(p.request.method==='POST'&&u.pathname==='/pay-v2'));
  const mock=u.href==='https://mock-bank.invalid/pay'&&p.resourceType==='Document';if(!allowed)report.blocked.push(u.href);
  const task=command(mock?'Fetch.fulfillRequest':allowed?'Fetch.continueRequest':'Fetch.failRequest',mock?{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'},{name:'Content-Security-Policy',value:"default-src 'none'; worker-src 'none'"}],body:Buffer.from('<h1>Synthetic payment placeholder · no bank request</h1>').toString('base64')}:allowed?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'}).catch(e=>{if(!closing)failure=e;}).finally(()=>events.delete(task));events.add(task);
 }}catch(e){failure=e;}};
 ws.onclose=()=>{if(!closing)failure=new Error('Unexpected transport close');};
 transport={stop(){closing=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('closed'));}pending.clear();},check(){if(failure)throw failure;}};
 const evaluate=async expression=>{transport.check();const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async expression=>{const end=Date.now()+10000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI timeout '+expression);};
 const navigate=async url=>{await command('Page.navigate',{url});await until('window.qa?.ready===true');};
 const reload=async()=>{const time=await evaluate('performance.timeOrigin');await command('Page.reload',{ignoreCache:true});await until(`window.qa?.ready===true && performance.timeOrigin!==${time}`);};
 await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await command('Network.setBypassServiceWorker',{bypass:true});await command('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
 if(process.env.V2_QA_FAIL_AFTER_START==='1')throw new Error('Injected startup failure');
 const envelope=(method,n)=>{const id=`LE-1791000000000-V2-${n.toString(16).padStart(8,'0')}`,customer={name:'Synthetic',email:'test@example.invalid',phone:'79000000000',address:'Synthetic',contactPref:'phone',comment:'full payload'};return createEnvelope({orderId:id,clientId:'fixture',paymentMethod:method,amount:1,description:'synthetic',email:customer.email,phone:customer.phone,address:customer.address,contactPref:customer.contactPref,customer,delivery:{address:customer.address},items:[{productId:'fixture',variantId:'fixture',kind:'tree',quantity:1,price:1}],promo:null,promoCode:'',successUrl:`http://localhost:4176/spasibo?oid=${id}`,failUrl:`http://localhost:4176/pay-return?oid=${id}&fail=1`},ownerEndpoint);};
 await navigate(origin+'/qa');await evaluate('sessionStorage.clear()');
 const storageEnv=envelope('card',99), storagePostCount=posts.length;
 await evaluate(`window.savedSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){};qa.start(${JSON.stringify(storageEnv)})`);
 assert.equal(await evaluate('qa.snapshot().notice'),'STORAGE_READBACK_FAILED');assert.equal(posts.length,storagePostCount);
 await evaluate('Storage.prototype.setItem=window.savedSet');
 report.cases.push({storageWriteReadbackFailure:true,noCreateBeforeDurablePending:true});
 let card;
 for(const [n,method] of [[1,'card'],[2,'cash_on_delivery']]){
  await navigate(origin+'/qa');await evaluate('sessionStorage.clear()');const env=envelope(method,n);lose=true;const beforeRegisters=registers,beforeSends=sends;
  await evaluate(`qa.start(${JSON.stringify(env)})`);const raw=await evaluate('qa.snapshot().raw');assert.deepEqual(JSON.parse(raw),env);
  await reload();assert.equal(await evaluate('qa.snapshot().raw'),raw);
  open=false;resetRoute();await evaluate('qa.replay()');assert.equal(await evaluate('qa.snapshot().notice'),method==='card'?'awaiting_payment':'accepted');
  assert.deepEqual(posts.slice(-2),[env,env]);assert.equal(registers-beforeRegisters,method==='card'?1:0);assert.equal(sends-beforeSends,method==='card'?0:1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM le_checkout_v2.orders WHERE id=$1',[env.orderId])).rows[0].n,1);
  const status=await evaluate('qa.status()');assert.equal(status.nextAction,method==='card'?'status_only':'confirm_accepted');
  assert.equal(await evaluate("qa.status('bob').then(()=>0,e=>e.message)"),'NOT_FOUND');assert.equal(await evaluate("qa.status('invalid').then(()=>0,e=>e.message)"),'UNAUTHORIZED');
  const fresh=envelope(method,n+100);assert.equal((await route({route:'create',credentials:'alice',body:fresh})).status,503);
  report.cases.push({method,lostReadableResponse:true,realPageReload:true,verifiedStorage:true,exactIDAndFullPayload:true,oneDurableOrder:true,closedCreateRecovery:true,privateOwnerDenied:true,registers:registers-beforeRegisters,notifications:sends-beforeSends});
  if(method==='card')card={env,raw,status};open=true;resetRoute();
 }
 await navigate(origin+'/qa');await evaluate(`sessionStorage.clear();sessionStorage.setItem(qa.key,${JSON.stringify(card.raw)})`);await reload();
 const cardResponse=await evaluate('qa.status()');assert.equal(cardResponse.paymentURL,'https://mock-bank.invalid/pay');
 for(const paymentURL of ['https://evil.invalid/pay','https://mock-bank.invalid.evil.invalid/pay','https://user@mock-bank.invalid/pay','http://mock-bank.invalid/pay','https://mock-bank.invalid/pay#x']){
  const response={status:Object.fromEntries(Object.entries(cardResponse).filter(([k])=>!['paymentURL','preservePending','nextAction'].includes(k))),paymentURL};
  assert.equal(await evaluate(`(()=>{try{qa.validateResponse(${JSON.stringify(response)});return false;}catch{return true;}})()`),true);
 }
 report.cases.push({browserPaymentURLAllowlist:true,arbitraryOriginUserinfoHTTPHashRejected:true});
 assert.equal(await evaluate("qa.payment().then(()=>true)"),true);await until("location.href==='https://mock-bank.invalid/pay'");
 assert(report.blocked.includes('https://mock-bank.invalid/pay'));
 await navigate(origin+'/spasibo?oid='+card.env.orderId);
 const o=await store.get(card.env.orderId);evidence.set(o.payment_id,{verified:true,observedAt:Date.now(),status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100});const sendsBefore=sends;
 const results=await Promise.all([route({route:'callback',credentials:'callback',body:{paymentId:o.payment_id}}),route({route:'internal-poll',credentials:'internal',deadline:Date.now()+5000}),route({route:'internal-poll',credentials:'internal',deadline:Date.now()+5000})]);assert(results.every(r=>r.status===200));
 assert.equal(sends-sendsBefore,1);assert.equal((await evaluate('qa.returnStatus()')).nextAction,'confirm_paid');assert.equal((await evaluate('qa.status()')).paymentURL,null);assert.equal(await evaluate('qa.snapshot().raw'),card.raw);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM le_checkout_v2.bank_queue')).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM le_checkout_v2.effects WHERE order_id=$1 AND state='succeeded'",[o.id])).rows[0].n,2);
 report.cases.push({returnOID:true,mockURLIntercepted:true,callbackPollConcurrent:true,paidPrivateReadback:true,oneNotification:true,queueDrained:true});
 unknown=true;const review=envelope('card',3);await navigate(origin+'/qa');await evaluate('sessionStorage.clear()');const count=registers;await evaluate(`qa.start(${JSON.stringify(review)})`);const reviewRaw=await evaluate('qa.snapshot().raw');await reload();await evaluate('qa.replay()');assert.equal((await evaluate('qa.status()')).status,'pending_review');assert.equal(registers-count,1);assert.equal(await evaluate('qa.snapshot().raw'),reviewRaw);report.cases.push({unknownRegistration:'pending_review',noNewRegistration:true});
 // Exhaust finite read/replay policies after the original successful recovery cases.
 const budgetBefore={registers,sends,posts:posts.length},orderCount=(await db.query('SELECT count(*)::int n FROM le_checkout_v2.orders')).rows[0].n;
 await db.exec("UPDATE le_checkout_v2.budgets SET capacity=used WHERE key IN ('status','replay')");
 const limited=await evaluate("qa.status().then(()=>null,e=>({message:e.message,status:e.status,retryAfter:e.retryAfter}))");
 assert.equal(limited.message,'RATE_LIMITED');assert.equal(limited.status,429);assert.equal(limited.retryAfter,'60');
 await evaluate('qa.replay()');assert.equal(await evaluate('qa.snapshot().notice'),'RATE_LIMITED');
 assert.deepEqual(await evaluate('qa.snapshot().lastError'),{message:'RATE_LIMITED',status:429,retryAfter:'60'});
 assert.equal(await evaluate('qa.snapshot().raw'),reviewRaw);assert.equal(registers,budgetBefore.registers);assert.equal(sends,budgetBefore.sends);
 assert.deepEqual(posts.at(-1),review);assert.equal((await db.query('SELECT count(*)::int n FROM le_checkout_v2.orders')).rows[0].n,orderCount);
 report.cases.push({statusAndReplay429:true,retryAfter:60,pendingAndIDPreserved:true,noNewOrderOrEffect:true});
 await db.exec("UPDATE le_checkout_v2.fixture_clock SET t=120001; UPDATE le_checkout_v2.budgets SET capacity=100 WHERE key IN ('status','replay')");
 await evaluate('qa.replay()');assert.equal((await evaluate('qa.status()')).status,'pending_review');
 assert.equal(registers,budgetBefore.registers);assert.equal(sends,budgetBefore.sends);assert.equal(await evaluate('qa.snapshot().raw'),reviewRaw);
 // Replay the already paid order after admission/effect window rollover: durable effects stay deduplicated.
 await evaluate(`sessionStorage.setItem(qa.key,${JSON.stringify(card.raw)})`);await reload();await evaluate('qa.replay()');
 assert.equal((await evaluate('qa.status()')).status,'paid');assert.equal(registers,budgetBefore.registers);assert.equal(sends,budgetBefore.sends);
 assert.equal((await db.query('SELECT count(*)::int n FROM le_checkout_v2.orders')).rows[0].n,orderCount);
 report.cases.push({windowRolloverRecovery:true,existingPaidEffectsDeduplicated:true});
 const legacy=JSON.stringify({signature:'legacy',payload:{orderId:'old'}});await evaluate(`sessionStorage.clear();sessionStorage.setItem(qa.legacy,${JSON.stringify(legacy)})`);const postsBefore=posts.length;await reload();assert.equal(await evaluate('qa.snapshot().legacy'),legacy);assert.equal(await evaluate('qa.snapshot().notice'),'LEGACY_PENDING_UNSUPPORTED');await evaluate(`qa.start(${JSON.stringify(review)})`);assert.equal(posts.length,postsBefore);assert.equal(await evaluate('qa.snapshot().raw'),null);
 await evaluate(`sessionStorage.clear();sessionStorage.setItem(qa.key,${JSON.stringify(reviewRaw)})`);await navigate(origin+'/qa?expired=1');await reload();assert.equal(await evaluate('qa.snapshot().notice'),'VERSION_EXPIRED');await evaluate('qa.replay()');assert.equal(posts.length,postsBefore);assert.equal(await evaluate('qa.snapshot().raw'),reviewRaw);report.cases.push({legacyPreserved:true,expiredPreserved:true,noSilentMigration:true,noExpiredCreate:true});
 await navigate(origin+'/qa');await command('Page.setBypassCSP',{enabled:true});assert.equal(await evaluate("fetch('/forbidden').then(()=>false,()=>true)"),true);assert.equal(await evaluate("fetch('https://external.invalid/probe').then(()=>false,()=>true)"),true);await command('Page.setBypassCSP',{enabled:false});await Promise.all([...events]);transport.check();
 assert(report.blocked.some(x=>x.endsWith('/forbidden')));assert(report.requests.every(x=>x.url.startsWith(origin+'/')||['https://mock-bank.invalid/pay','https://external.invalid/probe'].includes(x.url)));
 for(const table of ['payment_orders','le_orders'])assert.deepEqual((await db.query(`SELECT * FROM public.${table}`)).rows,[{marker:'legacy'}]);
 report.cases.push({denyProxyDNS:true,CDPBeforeNavigation:true,CSP:true,serviceWorkerBypass:true,externalProbeRejected:true,legacySentinelsUnchanged:true});report.browser=await command('Browser.getVersion');
 await writeFile(new URL('./evidence.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.cases.length,registers,sends,browser:report.browser.product}));
}catch(e){primary=e;}finally{
 const errors=[];transport?.stop();ws?.close();
 if(chrome?.pid){try{const alive=()=>{try{process.kill(-chrome.pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};const signal=s=>{try{process.kill(-chrome.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}};signal('SIGTERM');for(let i=0;i<30&&alive();i++)await new Promise(r=>setTimeout(r,100));if(alive())signal('SIGKILL');for(let i=0;i<20&&alive();i++)await new Promise(r=>setTimeout(r,100));if(alive())throw new Error('Chrome group survived cleanup');}catch(e){errors.push(e);}}
 if(server){server.closeAllConnections();try{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}catch(e){errors.push(e);}}
 try{await bounded(db.close(),5000);await bounded(rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150}),5000);}catch(e){errors.push(e);}
 process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
 if(primary||errors.length)throw new AggregateError([...(primary?[primary]:[]),...errors],'QA/cleanup failure');console.log('Owned Chrome, HTTP fixture, PGlite and temporary profile cleaned');
}
