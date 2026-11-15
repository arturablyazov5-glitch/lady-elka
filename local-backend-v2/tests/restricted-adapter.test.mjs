import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createGateway} from '../gateway.mjs';
import {restrictedAdapter} from '../restricted-adapter.mjs';
import {createEnvelope} from '../../storefront/api-v2/contract.mjs';
const endpoint='http://localhost:9999/pay-v2';
function envelope(suffix='12345678',patch={}){
 const id=`LE-1791000000000-V2-${suffix}`;
 const customer={name:'Synthetic',email:'test@example.invalid',phone:'79000000000',address:'Synthetic',contactPref:'phone'};
 return createEnvelope({orderId:id,clientId:'untrusted',paymentMethod:'card',amount:1,description:'synthetic',email:customer.email,phone:customer.phone,address:customer.address,contactPref:customer.contactPref,customer,delivery:{address:customer.address},items:[{productId:'fixture',variantId:'fixture',kind:'tree',quantity:1,price:1}],promo:null,promoCode:'',successUrl:`http://localhost:4176/spasibo?oid=${id}`,failUrl:`http://localhost:4176/pay-return?oid=${id}&fail=1`,...patch},endpoint);
}
async function fixture(){
 const db=new PGlite();
 await db.exec(await readFile(new URL('../schema-draft.sql',import.meta.url),'utf8'));
 await db.exec("CREATE TABLE public.payment_orders(marker text); INSERT INTO public.payment_orders VALUES('legacy'); CREATE TABLE public.le_orders(marker text); CREATE TABLE public.catalog(marker text); CREATE TABLE public.blog(marker text)");
 await db.exec(await readFile(new URL('../roles-draft.sql',import.meta.url),'utf8'));
 await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity,window_ms,owner_capacity) SELECT unnest(ARRAY['create','request','ownerRequest','replay','status','callback','internal','bank','telegram']),1000,60000,1000; UPDATE le_checkout_v2.gateway_policy SET create_open=true; INSERT INTO le_checkout_v2.capabilities VALUES('alice-cap','alice',9999999999999,true,true),('bob-cap','bob',9999999999999,false,true),('expired','alice',0,true,true)");
 // PGlite has one physical session: serialize each query's identity switch.
 // All application SQL runs with non-superuser session authorization. Admin only
 // brackets the disposable test connection; it is never exposed to the adapter.
 let tail=Promise.resolve();const seen=[];
 const executors=Object.fromEntries(['create','status','callback','internal'].map(role=>[role,{query(sql,args){const task=tail.then(async()=>{await db.exec('SET SESSION AUTHORIZATION le_v2_'+role);try{seen.push(role);return await db.query(sql,args);}finally{await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');}});tail=task.catch(()=>{});return task;}}]));
 let banks=0,sends=0,outcome='confirmed',evidence;
 const options={executors,identity:{apiVersion:'2',fingerprintVersion:'sha256-canonical-json-v1',ownerEndpoint:endpoint},verifyCatalog:async()=>({verified:true,fresh:true,revision:'fixture',amountMinor:100}),recipients:['synthetic'],paymentOrigins:['https://mock-bank.invalid'],auth:{callback:async c=>c==='callback',internal:async c=>c==='internal'},provider:{register:async({order})=>{banks++;return {outcome,paymentId:'p-'+order.id,bankNumber:order.bank_number,amount:Number(order.amount),paymentURL:'https://mock-bank.invalid/pay'};},evidence:async()=>evidence},notifier:{send:async()=>{sends++;return {outcome};}}};
 return {db,executors,options,seen,route:createGateway(options),counts:()=>({banks,sends}),outcome:v=>outcome=v,evidence:v=>evidence=v,close:()=>db.close()};
}
const call=(f,route,body,credentials='alice-cap')=>f.route({route,body,credentials,deadline:Date.now()+2000});
test('restricted gateway: concurrent canonical replay, catalog, capability privacy and safe redirect',async()=>{
 const f=await fixture();try{
 const env=envelope(),id=env.orderId;
 const results=await Promise.all(Array.from({length:8},()=>call(f,'create',env)));
 assert(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(f.counts().banks,1);
 assert.equal((await call(f,'create',envelope('12345678',{description:'changed'}))).status,409);
 assert.equal((await call(f,'create',env,'bob-cap')).status,401);
 assert.equal((await call(f,'create',env,'expired')).status,401);
 for(const id2 of [id,'missing']) assert.deepEqual(await call(f,'status',{orderId:id2,owner:'alice'},'bob-cap'),{status:404,body:{error:'NOT_FOUND'}});
 const status=await call(f,'status',{orderId:id});assert.equal(status.body.paymentURL,'https://mock-bank.invalid/pay');assert.deepEqual(Object.keys(status.body.status).sort(),['apiVersion','fingerprintVersion','orderId','ownerEndpoint','status'].sort());
 const unquoted=createGateway({...f.options,verifyCatalog:async()=>({verified:true,fresh:false})});
 assert.equal((await unquoted({route:'create',body:envelope('abcdef12'),credentials:'alice-cap',deadline:Date.now()+1000})).status,503);
 await f.db.exec('UPDATE le_checkout_v2.gateway_policy SET create_open=false');
 assert.equal((await call(f,'create',env)).status,200);assert.equal((await call(f,'create',envelope('abcdef12'))).status,503);
 await f.db.exec("UPDATE le_checkout_v2.orders SET payment_url='https://evil.invalid/'");assert.equal((await call(f,'status',{orderId:id})).status,503);
 assert.equal((await f.db.query('SELECT owner FROM le_checkout_v2.orders')).rows[0].owner,'alice');
 }finally{await f.close();}
});
test('callback/poll dedup, paid guard, unknown effects, and bounded noncooperative evidence',async()=>{
 const f=await fixture();try{
 const env=envelope();await call(f,'create',env);const o=(await f.db.query('SELECT * FROM le_checkout_v2.orders')).rows[0];
 assert.equal((await call(f,'callback',{paymentId:o.payment_id},'bad')).status,401);
 f.evidence({verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:101,observedAt:Date.now()});assert.equal((await call(f,'callback',{paymentId:o.payment_id},'callback')).status,409);
 f.evidence({verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100,observedAt:Date.now()});
 const r=await Promise.all([call(f,'callback',{paymentId:o.payment_id},'callback'),call(f,'internal-poll',{},'internal')]);assert(r.every(x=>x.status===200));assert.equal(f.counts().sends,1);
 await restrictedAdapter({executor:f.executors.internal,role:'internal'}).status(o.id,'pending_review');assert.equal((await call(f,'status',{orderId:o.id})).body.status.status,'paid');
 f.outcome('unknown');await call(f,'create',envelope('abcdef12'));await call(f,'create',envelope('abcdef12'));assert.equal(f.counts().banks,2);
 await call(f,'create',envelope('abcdef13',{paymentMethod:'cash_on_delivery'}));await call(f,'internal-retry',{},'internal');assert.equal(f.counts().sends,2);
 const bounded=createGateway({...f.options,provider:{...f.options.provider,evidence:async()=>new Promise(()=>{})}});
 // New confirmed card to keep a real poll queue.
 f.outcome('confirmed');await call(f,'create',envelope('abcdef14'));
 const stopped=await bounded({route:'internal-poll',credentials:'internal',deadline:Date.now()+30});assert.equal(stopped.body.stopped,true);
 }finally{await f.close();}
});
test('real session ACLs deny legacy/direct access and role escalation; wrong executor and missing RPC fail closed',async()=>{
 const f=await fixture();try{
 for(const role of Object.keys(f.executors)){
  const e=f.executors[role];
  for(const table of ['public.payment_orders','public.le_orders','public.catalog','public.blog','le_checkout_v2.orders','le_checkout_v2.capabilities','le_checkout_v2.effects']){
   for(const sql of [`SELECT * FROM ${table}`,`DELETE FROM ${table}`,`INSERT INTO ${table} DEFAULT VALUES`]) await assert.rejects(e.query(sql),x=>x.code==='42501');
  }
  await assert.rejects(e.query("UPDATE le_checkout_v2.orders SET status='paid'"),x=>x.code==='42501');
  await assert.rejects(e.query('SET ROLE le_v2_owner'),x=>x.code==='42501');
  if(role!=='internal') await assert.rejects(e.query("SELECT le_checkout_v2.api_internal('get','{}')"),x=>x.code==='42501');
  if(role!=='create') await assert.rejects(e.query("SELECT * FROM le_checkout_v2.api_create('x','x','x','x',100,'card','[]')"),x=>x.code==='42501');
 }
 const wrong=createGateway({...f.options,executors:{...f.executors,create:f.executors.internal}});
 assert.equal((await wrong({route:'create',body:envelope(),credentials:'alice-cap',deadline:Date.now()+1000})).status,503);
 const admin=createGateway({...f.options,executors:{...f.executors,create:f.db}});assert.equal((await admin({route:'create',body:envelope(),credentials:'alice-cap',deadline:Date.now()+1000})).status,503);
 const missing=createGateway({...f.options,executors:{}});assert.equal((await missing({route:'status',credentials:'alice-cap',deadline:Date.now()+1000})).status,503);
 await f.db.exec('DROP FUNCTION le_checkout_v2.api_status(text,text)');assert.equal((await call(f,'status',{orderId:'missing'})).status,503);assert.deepEqual(f.counts(),{banks:0,sends:0});
 assert.equal((await f.db.query('SELECT marker FROM public.payment_orders')).rows[0].marker,'legacy');
 }finally{await f.close();}
});
test('finite preauth, replay, status, admission and effect budgets stop gateway external calls',async()=>{
 for(const budget of ['request','ownerRequest','replay','create','bank','internal','telegram']){
 const f=await fixture();try{
 await f.db.query('UPDATE le_checkout_v2.budgets SET capacity=0 WHERE key=$1',[budget]);
 assert.equal((await call(f,'create',envelope('12345678',budget==='telegram'?{paymentMethod:'cash_on_delivery'}:{}))).status,429,budget);assert.equal(f.counts().banks,0);assert.equal(f.counts().sends,0);
 }finally{await f.close();}}
 const f=await fixture();try{
 await call(f,'create',envelope());await f.db.exec("UPDATE le_checkout_v2.budgets SET capacity=0 WHERE key='status'");assert.equal((await call(f,'status',{orderId:envelope().orderId})).status,429);
 await f.db.exec("DELETE FROM le_checkout_v2.budgets WHERE key='callback'");assert.equal((await call(f,'callback',{paymentId:'p'},'callback')).status,503);
 }finally{await f.close();}
});
test('RPC acknowledgement loss preserves bound polling and paid; running notification never repeats',async()=>{
 const f=await fixture();try{
 let lost=true;
 const fault={query:async(sql,args)=>{
  const result=await f.executors.internal.query(sql,args);
  if(sql.includes('api_internal')&&args[0]==='finish'&&JSON.parse(args[1]).state==='succeeded'&&lost){lost=false;throw new Error('synthetic acknowledgement lost');}
  return result;
 }};
 f.route=createGateway({...f.options,executors:{...f.executors,internal:fault}});
 await call(f,'create',envelope());await call(f,'create',envelope());assert.equal(f.counts().banks,1);
 const o=(await f.db.query('SELECT * FROM le_checkout_v2.orders')).rows[0];assert.equal(o.status,'awaiting_payment');
 f.evidence({verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100,observedAt:Date.now()});
 await call(f,'internal-poll',{},'internal');assert.equal((await call(f,'status',{orderId:o.id})).body.status.status,'paid');assert.equal(f.counts().sends,1);
 const unavailable={query:async(sql,args)=>{
  if(sql.includes('api_internal')&&args[0]==='finish') throw new Error('synthetic RPC unavailable');
  return f.executors.internal.query(sql,args);
 }};
 f.route=createGateway({...f.options,executors:{...f.executors,internal:unavailable}});
 assert.equal((await call(f,'create',envelope('abcdef15',{paymentMethod:'cash_on_delivery'}))).status,503);
 f.route=createGateway(f.options);await call(f,'internal-retry',{},'internal');assert.equal(f.counts().sends,2);
 assert.equal((await f.db.query("SELECT state FROM le_checkout_v2.effects WHERE key LIKE 'v2:telegram:%abcdef15%' ")).rows[0].state,'running');
 }finally{await f.close();}
});
test('gate checks per-call context after real identity; context-free trusted gate remains compatible',async()=>{
 const f=await fixture();try{
  let release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);const sql=[];
  const executor={query:async(statement,args)=>{sql.push(statement);const result=await f.executors.status.query(statement,args);if(statement==='SELECT session_user,current_user'){entered();await pending;}return result;}};
  const adapter=restrictedAdapter({executor,role:'status'}),controller=new AbortController();
  const result=adapter.gate({signal:controller.signal,deadline:Date.now()+1000});await started;controller.abort();release();await assert.rejects(result,e=>e.message==='REQUEST_CANCELLED'&&e.status===504);assert.equal(sql.length,1);
  await restrictedAdapter({executor:f.executors.status,role:'status'}).gate();
 }finally{await f.close();}
});
