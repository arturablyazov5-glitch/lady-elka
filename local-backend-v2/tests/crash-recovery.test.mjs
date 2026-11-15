import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {sqlStore} from '../store.mjs';
import {createRouter} from '../router.mjs';
import {paidEvidence} from '../payment-adapter.mjs';
const schema=await readFile(new URL('../schema-draft.sql',import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite();await db.exec(schema);await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity,window_ms,owner_capacity) VALUES ('create',100,60000,100),('bank',100,60000,100),('telegram',100,60000,100),('request',1000,60000,1000)");
 const store=sqlStore(db);let banks=0,sends=0;
 const options={store,identity:{apiVersion:'2',fingerprintVersion:'sha256-canonical-json-v1',ownerEndpoint:'local'},budget:'create',effectBudgets:{bank:'bank',telegram:'telegram'},requestBudgets:Object.fromEntries(['request','ownerRequest','status','replay','callback','internal'].map(k=>[k,'request'])),createOpen:true,recipients:['fixture'],paymentOrigins:['https://mock.invalid'],validator:async b=>({id:b.id,method:b.method||'card',amount:100,fingerprint:b.id}),auth:{caller:async()=> 'owner',internal:async()=>true,callback:async()=>true},provider:{register:async({order})=>{banks++;return {outcome:'confirmed',paymentId:order.id,bankNumber:order.bank_number,amount:100,paymentURL:'https://mock.invalid/pay'};},evidence:async id=>{const o=await store.get(id);return {verified:true,status:'paid',paymentId:id,bankNumber:o.bank_number,amount:100,observedAt:Date.now()};}},notifier:{send:async()=>{sends++;return {outcome:'confirmed'};}}};
 const create=(opts=options,id='one',method='card')=>createRouter(opts)({route:'create',body:{id,method}});
 return {db,store,options,create,counts:()=>({banks,sends}),close:()=>db.close()};
}
test('bank finish acknowledgement lost after bind must preserve pollable mapping and paid terminal state',async()=>{
 const f=await fixture();try{
 for(const paid of [false,true]){
 const id=paid?'paid':'pending';const store={...f.store,finish:async(key,state)=>{if(key.startsWith('v2:bank:')&&state==='succeeded'){if(paid){const o=await f.store.get(id);await f.store.recover(o,await f.options.provider.evidence(id));}throw Error('lost finish');}return f.store.finish(key,state);}};
 await f.create({...f.options,store},id);assert.equal((await f.store.get(id)).status,paid?'paid':'awaiting_payment');
 await f.create(f.options,id);assert.equal(f.counts().banks,paid?2:1);
 }
 assert.equal((await f.store.pollable(20)).length,1);
 }finally{await f.close();}
});
test('bind transaction rolls back partial queue failure; unknown registration never repeats on restart',async()=>{
 const f=await fixture();try{
 await f.db.exec("CREATE FUNCTION le_checkout_v2.fail_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fault BEFORE INSERT ON le_checkout_v2.bank_queue FOR EACH ROW EXECUTE FUNCTION le_checkout_v2.fail_queue()");
 await f.create();assert.equal((await f.store.get('one')).payment_id,null);assert.equal((await f.store.get('one')).status,'pending_review');
 await f.db.exec('DROP TRIGGER fault ON le_checkout_v2.bank_queue');await f.create();assert.equal(f.counts().banks,1);
 }finally{await f.close();}
});
test('notification sent but finish unavailable leaves durable running and never sends again',async()=>{
 const f=await fixture();try{
 await f.create({...f.options,store:{...f.store,finish:async()=>{throw Error('db unavailable');}}},'cod','cash_on_delivery');
 await f.create(f.options,'cod','cash_on_delivery');await createRouter(f.options)({route:'internal-retry',deadline:Date.now()+1000});assert.equal(f.counts().sends,1);
 assert.equal((await f.db.query("SELECT state FROM le_checkout_v2.effects WHERE key='v2:telegram:cod:fixture'")).rows[0].state,'running');
 }finally{await f.close();}
});
test('reservation and claim response lost after commit survive new router without repeated external operation',async()=>{
 const f=await fixture();try{
 await f.create({...f.options,store:{...f.store,reserve:async x=>{await f.store.reserve(x);throw Error('lost reservation');}}});assert.equal(f.counts().banks,0);
 await f.create({...f.options,store:{...f.store,claim:async(...args)=>{await f.store.claim(...args);throw Error('lost claim');}}});
 await f.create();assert.equal(f.counts().banks,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM le_checkout_v2.orders')).rows[0].n,1);
 }finally{await f.close();}
});
test('late noncooperative evidence after worker deadline cannot pay or notify',async()=>{
 const f=await fixture();try{
 await f.create();let resolve;const evidence=new Promise(r=>resolve=r);const router=createRouter({...f.options,provider:{...f.options.provider,evidence:()=>evidence}});
 const r=await router({route:'internal-poll',deadline:Date.now()+20});assert.equal(r.body.stopped,true);resolve(await f.options.provider.evidence('one'));await new Promise(r=>setTimeout(r,30));assert.equal((await f.store.get('one')).status,'awaiting_payment');assert.equal(f.counts().sends,0);
 }finally{await f.close();}
});
test('incomplete unbound evidence never proves paid',()=>{
 assert.equal(paidEvidence({verified:true,status:'paid',paymentId:null,bankNumber:'number',amount:100,observedAt:Date.now()},{payment_id:null,bank_number:'number',amount:100}),false);
});
test('callback paid races stale/incomplete poll and lost notifier acknowledgement without downgrade or resend',async()=>{
 const f=await fixture();try{
 await f.create();let release,started;const began=new Promise(r=>started=r),late=new Promise(r=>release=r);
 const router=createRouter({...f.options,provider:{...f.options.provider,evidence:async()=>{started();return late;}},notifier:{send:async()=>{throw Error('sent, acknowledgement lost');}}});
 const poll=router({route:'internal-poll',deadline:Date.now()+2000});await began;
 let sends=0;const callback=createRouter({...f.options,notifier:{send:async()=>{sends++;throw Error('sent, acknowledgement lost');}}});
 assert.equal((await callback({route:'callback',body:{paymentId:'one'}})).status,200);
 release({...await f.options.provider.evidence('one'),observedAt:Date.now()-120000,amount:undefined});await poll;
 await createRouter(f.options)({route:'internal-retry',deadline:Date.now()+1000});assert.equal(sends,1);assert.equal(f.counts().sends,0);assert.equal((await f.store.get('one')).status,'paid');
 assert.equal((await f.db.query("SELECT state FROM le_checkout_v2.effects WHERE key='v2:telegram:one:fixture'")).rows[0].state,'unknown');
 }finally{await f.close();}
});
test('late effect claim after deadline prevents send; safely failed pre-send claim can retry',async()=>{
 const f=await fixture();try{
 await f.create({...f.options,notifier:{send:async()=>({outcome:'not_sent'})}},'cod','cash_on_delivery');
 let release,started;const began=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const router=createRouter({...f.options,store:{...f.store,claim:async(...args)=>{const claimed=await f.store.claim(...args);started();await wait;return claimed;}}});
 const run=router({route:'internal-retry',deadline:Date.now()+40});await began;assert.equal((await run).body.stopped,true);release();await new Promise(r=>setTimeout(r,30));assert.equal(f.counts().sends,0);
 assert.equal((await f.db.query("SELECT state FROM le_checkout_v2.effects WHERE key='v2:telegram:cod:fixture'")).rows[0].state,'failed');
 await createRouter(f.options)({route:'internal-retry',deadline:Date.now()+1000});assert.equal(f.counts().sends,1);
 }finally{await f.close();}
});
