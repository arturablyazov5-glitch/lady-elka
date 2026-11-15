import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
import {payDatabase} from '../pay/tests/helpers.mjs';import {names,preparePayV2} from '../../../scripts/prepare-pay-v2.mjs';import {qaDigest,createQaPolicy} from './qa-policy.mjs';import {workerSignature} from './worker-auth.mjs';
const orderId='LE-1791875606040-QA1-7a5ca6',productId='qa-payment-100-kopecks',paymentId='00000000-0000-0000-0000-000000000003';
const payload={orderId,paymentMethod:'card',amount:1,description:'ТЕСТ ОПЛАТЫ — 1 ₽ — НЕ ОБРАБАТЫВАТЬ',items:[{kind:'qa',productId,variantId:'qa:100:RUB',quantity:1,price:1}],promo:null,customer:{name:'TEST QA',email:'qa@example.invalid',phone:'+70000000000',contactPref:'QA',comment:'synthetic ownership'},delivery:{address:'QA — NO DELIVERY'},successUrl:'https://arturablyazov5-glitch-lady-elka-cloud-preview-3626.twc1.net/spasibo/?oid='+orderId,failUrl:'https://arturablyazov5-glitch-lady-elka-cloud-preview-3626.twc1.net/pay-return/?oid='+orderId+'&fail=1'};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
async function fixture(t){
 t.mock.method(console,'error',()=>{});
 await preparePayV2();const db=await payDatabase();t.after(()=>db.db.close());let serve;
 const config={orderId,productId,fingerprint:await qaDigest(JSON.stringify(canonical(payload))),recipientHash:await qaDigest('123')};
 const old={Deno:globalThis.Deno,fetch:globalThis.fetch};t.after(()=>Object.assign(globalThis,old));
 const worker='synthetic-qa-worker-'.padEnd(64,'x');const env={LE_V2_ADMISSION:'enabled',LE_V2_WORKER_TOKEN:worker,TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'123,-456,789',ALFA_API_USER:'synthetic',ALFA_API_PASS:'synthetic',ALFA_API_BASE:'https://bank.test/payment/rest',SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',CHECK_RATE_LIMIT_IP:'100/600',ORDER_RATE_LIMIT_IP:'100/600'};
 globalThis.Deno={env:{get:k=>env[k]},serve:fn=>serve=fn,createHttpClient:()=>({})};
 const compiled=await build({entryPoints:['supabase/functions/pay-v2/index.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'synthetic-fixed-policy',setup(b){b.onLoad({filter:/qa-config\.mjs$/},()=>({contents:'export const qaConfig='+JSON.stringify(config),loader:'js'}));}}]});
 await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64')+'#'+crypto.randomUUID());
 const state={registrations:0,bankChecks:0,status:0,currency:643,amount:100,reject:false,timeout:false,notifications:[],catalogCalls:0};
 globalThis.fetch=async(url,opts={})=>{const u=new URL(url);
 if(u.host==='db.test'){const path=u.pathname.slice('/rest/v1/'.length)+u.search;assert.match(path,/^(?:rpc\/)?le_v2_/);return db.request(path.replace(/^(rpc\/)?([a-z0-9_]+)(?=\?|$)/,(_,rpc='',name)=>rpc+Object.keys(names).find(k=>names[k]===name)),opts);}
 if(u.pathname.endsWith('/register.do')){state.registrations++;const form=new URLSearchParams(opts.body);assert.equal(form.get('amount'),'100');assert.equal(form.get('currency'),'643');assert.equal(form.get('sessionTimeoutSecs'),'86400');assert.equal(form.get('orderNumber'),orderId);assert.match(form.get('returnUrl'),/^https:\/\/arturablyazov5-glitch-lady-elka-cloud-preview-3626.twc1.net\/spasibo\//);if(state.timeout)throw Error('Synthetic ambiguous registration timeout');return Response.json({orderId:paymentId,formUrl:'https://payment.alfabank.ru/payment/form?mdOrder='+paymentId});}
 if(u.pathname.endsWith('/getOrderStatusExtended.do')){state.bankChecks++;return Response.json({errorCode:'0',orderId:paymentId,orderNumber:orderId,amount:state.amount,currency:state.currency,orderStatus:state.status});}
 if(u.host==='api.telegram.org'){const body=JSON.parse(opts.body);assert.equal(body.chat_id,'123','QA may only contact pinned private recipient');assert.deepEqual(body.reply_markup.inline_keyboard,[],'QA has no legacy status events');state.notifications.push(body);return state.reject?Response.json({ok:false,error_code:400,description:'Synthetic rejection'},{status:400}):Response.json({ok:true,result:{message_id:state.notifications.length,chat:{id:123}}});}
 if(u.pathname.endsWith('.csv')){state.catalogCalls++;throw Error('QA must not fetch/reserve ordinary products');}
 throw Error('Unexpected destination '+u.host);
 };
 const auth=async(action)=>{const time=String(Math.floor(Date.now()/1000)),nonce=crypto.randomUUID();return {'x-worker-time':time,'x-worker-nonce':nonce,'x-worker-signature':await workerSignature(worker,action,time,nonce)};};
 const call=(body,action='',headers={})=>serve(new Request('https://db.test/functions/v1/pay-v2'+(action?'?action='+action:''),{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}));
 const signed=async(body,action='qa-create')=>call(body,action,await auth(action));
 return {db,call,signed,auth,state,env,config};
}
for(const via of ['status','poll'])test('QA fixed create/price/fingerprint/private-only '+via+' and retry/env drift',async t=>{
 const f=await fixture(t),{db,call,signed,auth,state,env}=f;
 assert.equal((await call(payload,'qa-create')).status,401);assert.equal((await call(payload)).status,403);assert.equal((await call({...payload,action:'qa-create'})).status,403);assert.equal((await call({...payload,paymentMethod:'cash_on_delivery'},'create-cod-order')).status,403);
 for(const mutate of [p=>p.amount=0.01,p=>p.items[0].price=0.01,p=>p.items[0].quantity=2,p=>p.customer.comment='different',p=>p.orderId='LE-1791875606041-QA1-other',p=>p.items[0].productId='1',p=>p.successUrl='https://lady-elka.ru/spasibo/',p=>p.recipients=['-456'],p=>p.items.push({...p.items[0]})]){const p=structuredClone(payload);mutate(p);assert.equal((await signed(p)).status,400);}
 assert.equal(state.registrations,0);assert.equal((await db.db.query('select count(*) as n from le_orders')).rows[0].n,0);
 const h=await auth('qa-create');assert.equal((await call(payload,'qa-create',h)).status,200);assert.equal((await call(payload,'qa-create',h)).status,409,'signed nonce replay denied');
 const duplicate=await signed(payload);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true);assert.equal(state.registrations,1);assert.equal(state.notifications.length,0);assert.equal(state.catalogCalls,0);
 let row=(await db.db.query('select * from le_orders where order_id=$1',[orderId])).rows[0];assert.equal(Number(row.total),1);assert.equal(row.payment_id,paymentId);assert.deepEqual(row.notification_chat_ids,['123']);assert.equal(row.status,'awaiting_payment');
 const checks=state.bankChecks;assert.equal((await call({orderId},'order-status')).status,404);assert.equal((await call({...payload,amount:2},'order-status')).status,404);assert.equal(state.bankChecks,checks);
 state.status=2;state.currency=840;assert.equal((await call(payload,'order-status')).status,503);assert.equal(state.notifications.length,0);state.currency=643;state.amount=101;assert.equal((await call(payload,'order-status')).status,503);state.amount=100;
 env.TG_CHAT_IDS='-999,789';state.reject=true;
 if(via==='status'){const r=await(await call(payload,'order-status')).json();assert.equal(r.paid,true);}else{const r=await(await signed({},'poll-payments')).json();assert.equal(r.failed,1);}
 row=(await db.db.query('select * from le_orders where order_id=$1',[orderId])).rows[0];assert.equal(row.status,'paid');assert.equal(row.telegram_sent,false);assert.deepEqual(row.notification_chat_ids,['123']);assert.equal(state.notifications.length,1);
 assert.equal((await(await signed({},'retry-cod-delivery')).json()).checked,0,'COD retry excludes QA card');assert.equal(state.notifications.length,1);
 const bankAfterPaid=state.bankChecks;await db.db.query('update le_orders set notification_chat_ids=$1 where order_id=$2',[JSON.stringify(['-456']),orderId]);assert.equal((await call(payload,'order-status')).status,503);const corrupt=await(await signed({},'poll-payments')).json();assert.equal(corrupt.failed,1);assert.equal(state.notifications.length,1);assert.equal(state.bankChecks,bankAfterPaid);
 await db.db.query('update le_orders set notification_chat_ids=$1 where order_id=$2',[JSON.stringify(['123']),orderId]);state.reject=false;await db.db.exec("update le_order_effects set next_attempt_at=now()-interval '1 second' where state='failed'");
 assert.equal((await(await signed({},'poll-payments')).json()).failed,0);assert.equal(state.notifications.length,2);assert.equal(state.bankChecks,bankAfterPaid,'paid retry uses persisted evidence');
 assert.equal((await(await signed({},'poll-payments')).json()).checked,0);assert.equal((await(await call(payload,'order-status')).json()).paid,true);assert.equal(state.notifications.length,2);assert.equal(state.registrations,1);
});
test('ambiguous QA registration is never repeated',async t=>{const {signed,state,db}=await fixture(t);state.timeout=true;assert.equal((await signed(payload)).status,503);assert.equal((await signed(payload)).status,409);assert.equal(state.registrations,1);assert.equal((await db.db.query("select state from le_order_effects where effect_key=$1",['bank:'+orderId])).rows[0].state,'unknown');assert.equal(state.notifications.length,0);});
test('concurrent signed QA creates register only once',async t=>{const {signed,state,db}=await fixture(t);const responses=await Promise.all([signed(payload),signed(payload)]);assert.ok(responses.some(r=>r.status===200));assert.ok(responses.every(r=>[200,409].includes(r.status)));assert.equal(state.registrations,1);assert.equal((await db.db.query('select count(*) as n from le_orders')).rows[0].n,1);assert.equal(state.notifications.length,0);});
test('fixed private recipient validation rejects groups/mixed/new recipient; stored snapshot ignores env',async()=>{const config={orderId,productId,fingerprint:'unused',recipientHash:await qaDigest('123')},p=createQaPolicy(config);for(const ids of [[],['-456'],['123','-456'],['789'],[123]])await assert.rejects(()=>p.validateRecipients(ids));assert.deepEqual(await p.selectRecipients({notification_chat_ids:['123']},['-999']),['123']);await assert.rejects(()=>p.selectRecipients(null,['-999','789']));});

test('retired QA retains its private fingerprint snapshot but cannot be created again',async()=>{
 const fingerprint=await qaDigest(JSON.stringify(canonical(payload))),recipientHash=await qaDigest('123');
 const previous={orderId,productId,fingerprint,recipientHash};
 const policy=createQaPolicy({orderId:'LE-1791947999640-QA2-fixture',productId,fingerprint:'different',recipientHash,sessionTimeoutSecs:86400,retired:[previous]});
 const oldPolicy=createQaPolicy(previous),row={order_id:orderId,payment_method:'card',total:1,payload,fingerprint,notification:oldPolicy.notification,notification_chat_ids:['123']};
 assert.equal(policy.isOrder(orderId),true);await policy.validateRow(row);await assert.rejects(()=>policy.validatePayload(payload));
 await assert.rejects(()=>policy.validateRow({...row,notification_chat_ids:['-456']}));
 await assert.rejects(()=>policy.validateRow({...row,payload:{...payload,amount:2}}));
});
