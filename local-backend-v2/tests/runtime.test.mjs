import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createRuntime} from '../runtime.mjs';
import {randomBytes} from 'node:crypto';
import {createEnvelope} from '../../storefront/api-v2/contract.mjs';
const endpoint='http://localhost:9999/pay-v2';
function envelope(suffix='12345678',patch={}){
 const id=`LE-1791000000000-V2-${suffix}`;
 const customer={name:'Synthetic',email:'test@example.invalid',phone:'79000000000',address:'Synthetic',contactPref:'phone'};
 return createEnvelope({orderId:id,clientId:'untrusted',paymentMethod:'card',amount:1,description:'synthetic',email:customer.email,phone:customer.phone,address:customer.address,contactPref:customer.contactPref,customer,delivery:{address:customer.address},items:[{productId:'fixture',variantId:'fixture',kind:'tree',quantity:1,price:1}],promo:null,promoCode:'',successUrl:`http://localhost:4176/spasibo?oid=${id}`,failUrl:`http://localhost:4176/pay-return?oid=${id}&fail=1`,...patch},endpoint);
}
async function fixture(t){
 const db=new PGlite();await db.exec(await readFile(new URL('../schema-draft.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../roles-draft.sql',import.meta.url),'utf8'));
 await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity,window_ms,owner_capacity) SELECT unnest(ARRAY['create','request','ownerRequest','replay','status','callback','internal','bank','telegram']),1000,60000,1000; UPDATE le_checkout_v2.gateway_policy SET create_open=true");
 const token=randomBytes(32).toString('hex'),session={sessionId:'local-session',owner:'local-owner',expiresMs:Date.now()+60000,revoked:false,scopes:['create','status']};
 await db.query('INSERT INTO le_checkout_v2.capabilities VALUES($1,$2,$3,true,true)',[token,session.owner,session.expiresMs]);
 let tail=Promise.resolve(),banks=0,executorCloses=0;const queries=[];
 const executors=Object.fromEntries(['create','status','callback','internal'].map(role=>[role,{close(){executorCloses++;},query(sql,args){queries.push(sql);const task=tail.then(async()=>{await db.exec('SET SESSION AUTHORIZATION le_v2_'+role);try{return await db.query(sql,args);}finally{await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');}});tail=task.catch(()=>{});return task;}}]));
 const options={executors,identity:{apiVersion:'2',fingerprintVersion:'sha256-canonical-json-v1',ownerEndpoint:endpoint},verifyCatalog:async()=>({verified:true,fresh:true,revision:'fixture',amountMinor:100}),verifySession:async request=>request.headers.authorization==='Bearer session'?session:null,capabilityStore:{resolve:async()=>({...session,token})},verifyCallback:async()=>null,verifyInternal:async()=>null,provider:{register:async({order})=>{banks++;return {outcome:'confirmed',paymentId:'p-'+order.id,bankNumber:order.bank_number,amount:Number(order.amount),paymentURL:'https://mock-bank.invalid/pay'};},evidence:async()=>null},notifier:{send:async()=>({outcome:'confirmed'})},recipients:['synthetic'],origins:[],paymentOrigins:['https://mock-bank.invalid']};
 t.after(()=>db.close());
 return {options,db,token,queries,counts:()=>({banks,executorCloses})};
}
async function start(t,options){const runtime=createRuntime(options);t.after(()=>runtime.shutdown());const address=await runtime.listen();assert.equal(address.address,'127.0.0.1');return {runtime,url:'http://127.0.0.1:'+address.port};}
async function post(url,path,body){return fetch(url+'/v2/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer session'},body:JSON.stringify(body)});}
test('runtime composes localhost auth/gateway/restricted SQL with explicit local create opt-in',async t=>{
 const f=await fixture(t),{url,runtime}=await start(t,{...f.options,localCreateEnabled:true});
 const created=await post(url,'create',envelope());assert.equal(created.status,200);assert.ok(!(await created.text()).includes(f.token));
 const status=await post(url,'status',{orderId:envelope().orderId});assert.equal(status.status,200);assert.equal((await status.json()).paymentURL,'https://mock-bank.invalid/pay');assert.equal(f.counts().banks,1);
 assert.deepEqual(await runtime.shutdown(),{timedOut:false});assert.equal(f.counts().executorCloses,0);
 await assert.rejects(fetch(url+'/v2/status'));await assert.rejects(runtime.listen(),/RUNTIME_LISTEN_STATE/);
});
test('runtime rejects incomplete/unsafe config before listen and keeps create closed even with open SQL policy',async t=>{
 const f=await fixture(t);
 for(const key of ['executors','identity','verifyCatalog','verifySession','capabilityStore','verifyCallback','verifyInternal','provider','notifier','recipients','origins','paymentOrigins'])assert.throws(()=>createRuntime({...f.options,[key]:undefined}),/RUNTIME_CONFIG/,key);
 for(const origin of ['*','null','http://shop.example','https://user:pass@shop.example','https://shop.example/path','https://shop.example/','ftp://shop.example'])for(const key of ['origins','paymentOrigins'])assert.throws(()=>createRuntime({...f.options,[key]:[origin]}),/RUNTIME_CONFIG/);
 assert.throws(()=>createRuntime({...f.options,localCreateEnabled:'true'}),/RUNTIME_CONFIG/);
 const {url,runtime}=await start(t,f.options);const r=await post(url,'create',envelope());assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'CREATE_CLOSED'});assert.equal(f.counts().banks,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM le_checkout_v2.orders')).rows[0].n,0);
 assert.equal((await post(url,'status',{orderId:'missing'})).status,404);assert.deepEqual(await runtime.shutdown(),{timedOut:false});
 const unstarted=createRuntime(f.options);assert.deepEqual(await unstarted.shutdown(),{timedOut:false});
 const unsafe=createRuntime(f.options);await assert.rejects(unsafe.listen({host:'0.0.0.0'}),/RUNTIME_CONFIG/);await unsafe.shutdown();
});
test('shutdown aborts active provider requests, closes listener, bounds noncooperative cleanup, is idempotent',async t=>{
 const f=await fixture(t);let entered,signal,cleanupCalls=0,cleanupSignal;const started=new Promise(r=>entered=r);
 const {url,runtime}=await start(t,{...f.options,localCreateEnabled:true,shutdownMs:80,provider:{...f.options.provider,register:async input=>{signal=input.signal;entered();return new Promise(()=>{});}},cleanup:async({signal,deadline})=>{cleanupCalls++;cleanupSignal=signal;assert.ok(deadline>Date.now());return new Promise(()=>{});}});
 const response=post(url,'create',envelope()).then(()=>({resolved:true}),()=>({disconnected:true}));await started;
 const before=Date.now(),first=runtime.shutdown();assert.equal(first,runtime.shutdown());assert.deepEqual(await first,{timedOut:true});assert.ok(Date.now()-before<500);assert.equal(signal.aborted,true);assert.equal(cleanupSignal.aborted,true);assert.equal(cleanupCalls,1);assert.equal(f.counts().executorCloses,0);assert.deepEqual(await response,{disconnected:true});await assert.rejects(fetch(url+'/v2/status'));
});
test('late auth/store/catalog after HTTP timeout or shutdown starts no late status SQL/admission/effect',async t=>{
 for(const phase of ['session','store','catalog'])for(const stop of ['timeout','shutdown']){
  const f=await fixture(t);let release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const options={...f.options,localCreateEnabled:true,timeoutMs:40};
  if(phase==='session'){const original=options.verifySession;options.verifySession=async x=>{entered();await pending;return original(x);};}
  if(phase==='store'){const original=options.capabilityStore;options.capabilityStore={resolve:async x=>{entered();await pending;return original.resolve(x);}};}
  if(phase==='catalog'){const original=options.verifyCatalog;options.verifyCatalog=async x=>{entered();await pending;return original(x);};}
  const {url,runtime}=await start(t,options);
  const request=post(url,phase==='catalog'?'create':'status',phase==='catalog'?envelope():{orderId:'missing'}).then(async r=>({status:r.status,body:await r.json()}),()=>({disconnected:true}));
  await started;
  if(stop==='shutdown'){await runtime.shutdown();assert.deepEqual(await request,{disconnected:true});}
  else assert.equal((await request).status,504);
  const before=f.queries.length;release();await new Promise(r=>setTimeout(r,30));
  assert.equal(f.queries.length,before,`${phase}/${stop}: late SQL`);
  assert.equal(f.queries.some(sql=>sql.includes('api_create')),false);assert.equal(f.queries.some(sql=>sql.includes('api_status')),false);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM le_checkout_v2.orders')).rows[0].n,0);assert.equal(f.counts().banks,0);
  await runtime.shutdown();
 }
});
