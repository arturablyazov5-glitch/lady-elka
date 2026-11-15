import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {sqlStore} from '../store.mjs';
import {createRouter,bankNumber} from '../router.mjs';
import {canonicalPayload,fingerprintPayload} from '../../storefront/api-v2/contract.mjs';
const schema=await readFile(new URL('../schema-draft.sql',import.meta.url),'utf8');
async function fixture({capacity=100,recipients=['synthetic'],outcome='confirmed'}={}) {
 const db=new PGlite();await db.exec(schema);
 await db.exec(`CREATE TABLE public.payment_orders(marker text); INSERT INTO public.payment_orders VALUES('legacy-pending'); CREATE TABLE public.le_orders(marker text); INSERT INTO public.le_orders VALUES('unchanged'); INSERT INTO le_checkout_v2.budgets(key,capacity) VALUES('create',${capacity}),('bank',100),('telegram',100)`);
 await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity) VALUES('request',10000),('ownerRequest',10000),('status',10000),('replay',10000),('callback',10000),('internal',10000); UPDATE le_checkout_v2.budgets SET window_ms=60000,owner_capacity=capacity");
 const store=sqlStore(db);let banks=0,sends=0,evidence;
 const options={store,requestBudgets:{request:'request',ownerRequest:'ownerRequest',status:'status',replay:'replay',callback:'callback',internal:'internal'},budget:'create',effectBudgets:{bank:'bank',telegram:'telegram'},paymentOrigins:['https://mock-bank.invalid'],createOpen:true,identity:{apiVersion:'2',fingerprintVersion:'sha256-canonical-json-v1',ownerEndpoint:'http://localhost:9999/pay-v2'},recipients,
 validator:async body=>({id:body.id,method:body.method||'card',amount:100,fingerprint:await fingerprintPayload(body)}),
 auth:{caller:async c=>c==='alice'?'alice':c==='bob'?'bob':null,callback:async c=>c==='callback',internal:async c=>c==='internal'},
 provider:{register:async({order})=>{banks++;return {outcome,paymentId:'synthetic-bank',bankNumber:order.bank_number,amount:Number(order.amount),paymentURL:'https://mock-bank.invalid/pay'};},evidence:async()=>evidence},
 notifier:{send:async()=>{sends++;return {outcome};}}};
 return {db,store,options,route:createRouter(options),counts:()=>({banks,sends}),evidence:x=>{evidence=x;},close:()=>db.close()};
}
const create=(route,id='test',extra={})=>route({route:'create',credentials:'alice',body:{id,...extra}});
test('concurrent exact replay one bank effect; conflicting payload; private status; legacy untouched',async()=>{
 const f=await fixture();try{
 const results=await Promise.all(Array.from({length:12},()=>create(f.route)));
 assert(results.every(r=>r.status===200));assert.equal(f.counts().banks,1);
 assert.equal((await create(f.route,'test',{changed:true})).status,409);
 assert.equal((await f.route({route:'status',credentials:'bob',body:{orderId:'test'}})).status,404);
 assert.equal((await f.db.query('SELECT marker FROM public.payment_orders')).rows[0].marker,'legacy-pending');
 assert.equal((await f.db.query('SELECT marker FROM public.le_orders')).rows[0].marker,'unchanged');
 }finally{await f.close();}
});
test('callback owns persisted payment AND matches actual provider evidence',async()=>{
 const f=await fixture();try{
 await create(f.route);
 const callback=paymentId=>f.route({route:'callback',credentials:'callback',body:{paymentId}});
 assert.equal((await callback('legacy-bank')).status,404);assert.equal(f.counts().sends,0);
 const o=await f.store.get('test');
 f.evidence({observedAt:Date.now(),verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:99});
 assert.equal((await callback(o.payment_id)).status,409);assert.equal(f.counts().sends,0);
 f.evidence({observedAt:Date.now(),verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100});
 assert.equal((await callback(o.payment_id)).status,200);await callback(o.payment_id);assert.equal(f.counts().sends,1);
 assert.equal((await f.db.query('SELECT * FROM le_checkout_v2.bank_queue')).rows.length,0);
 }finally{await f.close();}
});
test('missing recipients/schema/auth/provider fail closed before external effects',async()=>{
 const f=await fixture({recipients:[]});try{
 assert.equal((await create(f.route)).status,503);assert.equal(f.counts().banks,0);
 assert.equal((await f.db.query('SELECT * FROM le_checkout_v2.orders')).rows.length,0);
 assert.equal((await f.route({route:'status',credentials:'service_role',body:{orderId:'test'}})).status,401);
 const noProvider=createRouter({...f.options,recipients:['x'],provider:null});assert.equal((await create(noProvider)).status,503);
 await f.db.exec('DROP SCHEMA le_checkout_v2 CASCADE');assert.equal((await create(f.route)).status,503);
 }finally{await f.close();}
});
test('unknown bank/delivery outcomes and running claims never retry',async()=>{
 const f=await fixture({outcome:'unknown'});try{
 await create(f.route);await create(f.route);assert.equal(f.counts().banks,1);
 await create(f.route,'cod',{method:'cash_on_delivery'});
 await f.route({route:'internal-retry',credentials:'internal'});assert.equal(f.counts().sends,1);
 await f.store.claim('v2:manual:cod','cod','telegram');assert.equal(await f.store.claim('v2:manual:cod','cod','telegram'),false);
 }finally{await f.close();}
});
test('atomic configured admission cap and closed create permit existing recovery',async()=>{
 const f=await fixture({capacity:1});try{
 const r=await Promise.all(['one','two','three'].map(id=>create(f.route,id,{method:'cash_on_delivery'})));
 assert.equal(r.filter(x=>x.status===200).length,1);assert.equal(r.filter(x=>x.status===429).length,2);
 const existing=(await f.db.query('SELECT id FROM le_checkout_v2.orders')).rows[0].id;
 const closed=createRouter({...f.options,createOpen:false});
 assert.equal((await create(closed,existing,{method:'cash_on_delivery'})).status,200);
 assert.equal((await create(closed,'new')).status,503);
 assert.equal((await f.db.query("SELECT used FROM le_checkout_v2.budgets WHERE key='create'")).rows[0].used,1);
 }finally{await f.close();}
});
test('namespaced IDs, canonical fingerprint and SQL containment',()=>{
 const ids=new Set(Array.from({length:1000},bankNumber));assert.equal(ids.size,1000);
 assert([...ids].every(id=>/^LE2[0-9a-f]{28}$/.test(id)&&id.length<=32));
 assert.equal(canonicalPayload({b:2,a:1}),canonicalPayload({a:1,b:2}));
 assert(!/public\.|payment_orders|le_orders|cron|CREATE EXTENSION|GRANT /i.test(schema));
});
test('effect budgets atomically stop external calls and missing budget fails closed',async()=>{
 const f=await fixture();try{
 await f.db.exec("UPDATE le_checkout_v2.budgets SET capacity=0 WHERE key='bank'");
 await create(f.route);assert.equal(f.counts().banks,0);
 await f.db.exec("DELETE FROM le_checkout_v2.budgets WHERE key='bank'");
 assert.equal((await create(f.route)).status,503);assert.equal(f.counts().banks,0);
 }finally{await f.close();}
});
test('shared contract bridge requires trusted fresh catalog and preserves full payload fingerprint',async()=>{
 const {contractValidator}=await import('../contract-adapter.mjs');
 const {createEnvelope}=await import('../../storefront/api-v2/contract.mjs');
 const endpoint='http://localhost:9999/pay-v2',id='LE-1791000000000-V2-12345678';
 const customer={name:'Synthetic',email:'test@example.invalid',phone:'79000000000',address:'Synthetic',contactPref:'phone'};
 const payload={orderId:id,clientId:'fixture',paymentMethod:'card',amount:1,description:'synthetic',email:customer.email,phone:customer.phone,address:customer.address,contactPref:customer.contactPref,customer,delivery:{address:customer.address},items:[{productId:'fixture',variantId:'fixture',kind:'tree',quantity:1,price:1}],promo:null,promoCode:'',successUrl:`http://localhost:4176/spasibo?oid=${id}`,failUrl:`http://localhost:4176/pay-return?oid=${id}&fail=1`};
 const env=createEnvelope(payload,endpoint);
 await assert.rejects(contractValidator({ownerEndpoint:endpoint})(env));
 const validator=contractValidator({ownerEndpoint:endpoint,verifyCatalog:async()=>({verified:true,fresh:true,revision:'synthetic-only',amountMinor:100})});
 const first=await validator(env),changed=await validator(createEnvelope({...payload,description:'changed'},endpoint));
 assert.notEqual(first.fingerprint,changed.fingerprint);
 await assert.rejects(validator({...env,ownerEndpoint:'http://localhost:9999/foreign-v2'}));
});
test('poll/callback concurrency, private redirect/paid readback and own queue only',async()=>{
 const f=await fixture();try{
 await create(f.route);const o=await f.store.get('test');
 const status=c=>f.route({route:'status',credentials:c,body:{orderId:o.id}});
 assert.equal((await status('alice')).body.paymentURL,'https://mock-bank.invalid/pay');
 assert.deepEqual((await status('bob')).body,{error:'NOT_FOUND'});
 f.evidence({observedAt:Date.now(),verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100});
 const closed=createRouter({...f.options,createOpen:false});
 const results=await Promise.all([closed({route:'internal-poll',credentials:'internal',deadline:Date.now()+5000}),closed({route:'internal-poll',credentials:'internal',deadline:Date.now()+5000}),f.route({route:'callback',credentials:'callback',body:{paymentId:o.payment_id}})]);
 assert(results.every(r=>r.status===200));assert.equal(f.counts().sends,1);
 assert.equal((await status('alice')).body.status.status,'paid');assert.equal((await status('alice')).body.paymentURL,null);
 assert.equal((await f.db.query('SELECT marker FROM public.payment_orders')).rows[0].marker,'legacy-pending');
 assert.equal((await f.db.query('SELECT marker FROM public.le_orders')).rows[0].marker,'unchanged');
 }finally{await f.close();}
});
test('missing/stale/conflicting evidence never pays; unmapped unknown never registers again',async()=>{
 const f=await fixture();try{
 await create(f.route);const o=await f.store.get('test');
 const base={observedAt:Date.now(),verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100};
 for(const patch of [{observedAt:undefined},{observedAt:Date.now()-120000},{paymentId:'foreign'},{bankNumber:'foreign'},{amount:101},{verified:false}]) {
  f.evidence({...base,...patch});await f.route({route:'internal-poll',credentials:'internal',deadline:Date.now()+1000});
  assert.equal((await f.store.get(o.id)).status,'awaiting_payment');
 }
 assert.equal(f.counts().sends,0);
 const unknown=createRouter({...f.options,provider:{...f.options.provider,register:async()=>({outcome:'confirmed',paymentId:'unbound',paymentURL:'https://evil.invalid/'})}});
 await create(unknown,'unknown');await create(unknown,'unknown');
 const r=await unknown({route:'status',credentials:'alice',body:{orderId:'unknown'}});
 assert.equal(r.body.status.status,'pending_review');assert.equal(r.body.paymentURL,null);
 assert.equal((await f.store.pollable(20)).length,1);
 assert.equal((await unknown({route:'callback',credentials:'callback',body:{paymentId:'unbound',amount:100}})).status,404);
 }finally{await f.close();}
});
test('worker deadline/abort is bounded even for noncooperative provider; no retries',async()=>{
 const {pollPayments}=await import('../worker.mjs');let calls=0,completes=0;
 const options={store:{pollable:async()=>[{payment_id:'own'},{payment_id:'second'}]},provider:{evidence:async()=>{calls++;return new Promise(()=>{});}},complete:async()=>completes++};
 const r=await pollPayments({...options,deadline:Date.now()+30});assert.equal(r.stopped,true);assert.equal(calls,1);assert.equal(completes,0);
 const c=new AbortController();c.abort();await pollPayments({...options,signal:c.signal,deadline:Date.now()+1000});assert.equal(calls,1);
 await assert.rejects(pollPayments({...options,batch:21,deadline:Date.now()+1000}));
});
test('autonomous loopback mock flow: lost response, reload exact ID, return status recovery',async()=>{
 const {createServer}=await import('node:http');
 const {createEnvelope,serializePending,restorePending}=await import('../../storefront/api-v2/contract.mjs');
 const {contractValidator}=await import('../contract-adapter.mjs');
 const {validatePaymentResponse}=await import('../payment-adapter.mjs');
 const f=await fixture();let route,lose=true;
 const server=createServer(async(req,res)=>{
  // Synthetic trusted capability in a header; no credentials or query logging.
  if(req.url!=='/pay-v2'||req.method!=='POST') {res.writeHead(404).end();return;}
  let data='';for await(const chunk of req) {data+=chunk;if(data.length>32768){res.writeHead(413).end();return;}}
  try {
   const request=JSON.parse(data);const result=await route({...request,credentials:req.headers['x-fixture-capability']});
   if(request.route==='create'&&lose){lose=false;res.destroy();return;}
   res.writeHead(result.status,{'Content-Type':'application/json'}).end(JSON.stringify(result.body));
  }catch{res.writeHead(400).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const endpoint=`http://127.0.0.1:${server.address().port}/pay-v2`,id='LE-1791000000000-V2-abcdef12';
  const customer={name:'Synthetic',email:'test@example.invalid',phone:'79000000000',address:'Synthetic',contactPref:'phone'};
  const payload={orderId:id,clientId:'fixture',paymentMethod:'card',amount:1,description:'synthetic',email:customer.email,phone:customer.phone,address:customer.address,contactPref:customer.contactPref,customer,delivery:{address:customer.address},items:[{productId:'fixture',variantId:'fixture',kind:'tree',quantity:1,price:1}],promo:null,promoCode:'',successUrl:`http://localhost:4176/spasibo?oid=${id}`,failUrl:`http://localhost:4176/pay-return?oid=${id}&fail=1`};
  const envelope=createEnvelope(payload,endpoint),policy={ownerEndpoint:endpoint};
  const durable=serializePending(envelope,policy);assert.equal(restorePending(durable,policy).orderId,id);
  route=createRouter({...f.options,identity:{...f.options.identity,ownerEndpoint:endpoint},validator:contractValidator({ownerEndpoint:endpoint,verifyCatalog:async()=>({verified:true,fresh:true,revision:'fixture',amountMinor:100})})});
  const post=async(body,capability='alice')=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Fixture-Capability':capability},body:JSON.stringify(body)});
  await assert.rejects(post({route:'create',body:envelope}));
  const restored=restorePending(durable,policy); // reload reconstruction, no browser navigation claimed
  assert.equal((await post({route:'create',body:restored})).status,200);assert.equal(f.counts().banks,1);
  const read=async()=>validatePaymentResponse(await(await post({route:'status',body:{orderId:restored.orderId}})).json(),restored,policy,['https://mock-bank.invalid']);
  assert.equal((await read()).paymentURL,'https://mock-bank.invalid/pay');
  assert.equal((await post({route:'status',body:{orderId:id}},'bob')).status,404);
  assert.equal((await post({route:'status',body:{orderId:id}},'unknown')).status,401);
  const returnID=new URL(restored.payload.successUrl).searchParams.get('oid');assert.equal(returnID,id);
  const o=await f.store.get(returnID);f.evidence({observedAt:Date.now(),verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100});
  await route({route:'internal-poll',credentials:'internal',deadline:Date.now()+1000});
  assert.equal((await read()).nextAction,'confirm_paid');assert.equal((await read()).paymentURL,null);
  assert.equal(restorePending(durable,policy).orderId,id);assert.equal(f.counts().sends,1);
 }finally {await new Promise(resolve=>server.close(resolve));await f.close();}
});

test('SQL windows across routers: owner/global limits, exact replay, rollover and rollback',async()=>{
 const f=await fixture({capacity:2,outcome:'unknown'});try{
 await f.db.exec("CREATE TABLE le_checkout_v2.fixture_clock(t bigint); INSERT INTO le_checkout_v2.fixture_clock VALUES(59999); CREATE OR REPLACE FUNCTION le_checkout_v2.server_ms() RETURNS bigint LANGUAGE sql VOLATILE AS $$ SELECT t FROM le_checkout_v2.fixture_clock $$; UPDATE le_checkout_v2.budgets SET owner_capacity=1 WHERE key='create'");
 const other=createRouter(f.options);
 const r=await Promise.all([create(f.route,'a'),create(other,'b')]);
 assert.equal(r.filter(x=>x.status===200).length,1);assert.equal(r.filter(x=>x.status===429).length,1);
 const id=(await f.db.query('SELECT id FROM le_checkout_v2.orders')).rows[0].id;
 assert.equal((await create(other,id)).status,200);
 assert.equal((await other({route:'create',credentials:'bob',body:{id:'bob'}})).status,200);
 assert.equal((await other({route:'create',credentials:'bob',body:{id:'over'}})).headers['Retry-After'],'1');
 await f.db.exec('UPDATE le_checkout_v2.fixture_clock SET t=60000');
 assert.equal((await create(other,'next')).status,200);
 const before=f.counts().banks;assert.equal((await create(other,id)).status,200);assert.equal(f.counts().banks,before);
 await f.db.exec('UPDATE le_checkout_v2.fixture_clock SET t=0');
 assert.equal((await create(other,'backward')).status,503);
 await f.db.exec('UPDATE le_checkout_v2.fixture_clock SET t=120000');
 await assert.rejects(f.store.reserve({id:'bad',owner:'alice',fingerprint:'f',bankNumber:'invalid',amount:100,method:'card',recipients:['x'],budget:'create',open:true}));
 assert.equal((await f.db.query("SELECT used FROM le_checkout_v2.budgets WHERE key='create'")).rows[0].used,1);
 assert.equal((await f.db.query('SELECT marker FROM public.payment_orders')).rows[0].marker,'legacy-pending');
 }finally{await f.close();}
});
test('request/auth/replay budgets fail closed and closed-create bounded drain',async()=>{
 const f=await fixture();try{
 await create(f.route,'cod',{method:'cash_on_delivery'});
 await f.db.exec("UPDATE le_checkout_v2.budgets SET capacity=1 WHERE key='replay'");
 assert.equal((await create(f.route,'cod',{method:'cash_on_delivery'})).status,429);
 const closed=createRouter({...f.options,createOpen:false});
 assert.equal((await closed({route:'internal-retry',credentials:'internal',deadline:Date.now()+100,body:{batch:1}})).status,200);
 await f.db.exec("UPDATE le_checkout_v2.budgets SET capacity=used WHERE key='request'");
 const before=f.counts();
 assert.equal((await f.route({route:'status',credentials:'wrong',body:{orderId:'cod'},headers:{'x-forwarded-for':'different'}})).status,429);
 assert.deepEqual(f.counts(),before);
 await f.db.exec("DELETE FROM le_checkout_v2.budgets WHERE key='status'");
 await f.db.exec("UPDATE le_checkout_v2.budgets SET capacity=10000 WHERE key='request'");
 assert.equal((await f.route({route:'status',credentials:'alice',body:{orderId:'cod'}})).status,503);
 }finally{await f.close();}
});
