import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {payDatabase} from '../pay/tests/helpers.mjs';
import {names,preparePayV2} from '../../../scripts/prepare-pay-v2.mjs';
import {bankState} from './operations.mjs';
import {workerSignature} from './worker-auth.mjs';

test('active deployed entry: COD, card status, independent worker, partial Telegram retry and no legacy access',async t=>{
 await preparePayV2();const db=await payDatabase();t.after(()=>db.db.close());
 const saved={Deno:globalThis.Deno,fetch:globalThis.fetch};t.after(()=>Object.assign(globalThis,saved));let serve;
 const worker='synthetic-worker-token-'.padEnd(64,'x');
 const env={LE_V2_ADMISSION:'enabled',LE_V2_WORKER_TOKEN:worker,LE_V2_CORS_ORIGIN:'https://lady-elka.ru',TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'123,456',
 ALFA_API_USER:'synthetic',ALFA_API_PASS:'synthetic',ALFA_API_BASE:'https://bank.test/payment/rest',SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic'};
 globalThis.Deno={env:{get:k=>env[k]},serve:fn=>serve=fn,createHttpClient:()=>({})};
 const compiled=await build({entryPoints:['supabase/functions/pay-v2/index.ts'],bundle:true,platform:'node',format:'esm',write:false});await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64')+'#active');
 let registrations=0,bankChecks=0,bankStatus=0,rejectRecipient=false;const notifications=[];
 const paymentId='00000000-0000-0000-0000-000000000002',orderId='LE-1791810000010-180';
 globalThis.fetch=async(url,options={})=>{
 const u=new URL(url);
 if(u.host==='db.test'){
 const path=u.pathname.slice('/rest/v1/'.length)+u.search;assert.match(path,/^(?:rpc\/)?le_v2_/);
 return db.request(path.replace(/^(rpc\/)?([a-z0-9_]+)(?=\?|$)/,(_,rpc='',name)=>rpc+Object.keys(names).find(k=>names[k]===name)),options);
 }
 if(u.pathname.endsWith('/trees.csv'))return new Response('id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,1000\n');
 if(u.pathname.endsWith('/promos.csv'))return new Response('promocode,ruble-offer,percent-offer,gift-offer\n');
 if(u.pathname.endsWith('/register.do')){registrations++;assert.equal(new URLSearchParams(options.body).has('sessionTimeoutSecs'),false,'normal registration lifetime unchanged');return Response.json({orderId:paymentId,formUrl:'https://bank.test/form'});}
 if(u.pathname.endsWith('/getOrderStatusExtended.do')){bankChecks++;return Response.json({orderId:paymentId,orderNumber:orderId,orderStatus:bankStatus,amount:100000});}
 if(u.host==='api.telegram.org'){
 const body=JSON.parse(options.body);notifications.push(body);
 if(body.reply_markup.inline_keyboard.length)assert.ok(body.reply_markup.inline_keyboard.flat().every(b=>b.url||b.callback_data==='order_status_menu'),'card controls use the existing message-only legacy callback contract');
 if(rejectRecipient&&body.chat_id==='456')return Response.json({ok:false,error_code:400,description:'Synthetic rejection'},{status:400});
 return Response.json({ok:true,result:{message_id:notifications.length}});
 }
 throw Error('Unexpected destination '+u.host);
 };
 let seq=0;const call=(body,action='',headers={})=>serve(new Request('https://db.test/functions/v1/pay-v2'+(action?'?action='+action:''),{method:'POST',headers:{'Content-Type':'application/json',origin:'https://lady-elka.ru','x-forwarded-for':'fixture-'+(++seq),...headers},body:JSON.stringify(body)}));
 const payload={paymentMethod:'card',orderId,amount:1000,description:'Synthetic',customer:{name:'Synthetic',email:'synthetic@example.invalid',phone:'+79991234567',contactPref:'Telegram'},delivery:{address:'Synthetic'},items:[{kind:'tree',productId:'1',variantId:'1:Зелёная:180',quantity:1,price:1000}],promo:null};
 const cod={...payload,orderId:'LE-1791810000011-180',paymentMethod:'cash_on_delivery'};
 assert.equal((await call(cod,'create-cod-order')).status,200);assert.equal((await call(cod,'create-cod-order')).status,200);
 assert.equal(registrations,0);assert.equal(notifications.length,2);assert.ok(notifications.every(n=>n.reply_markup.inline_keyboard.flat().every(b=>/^https:\/\/(wa\.me|t\.me)\//.test(b.url||''))),'COD controls are customer messenger links only');
 assert.equal((await call(payload)).status,200);assert.equal((await call(payload)).status,200);assert.equal(registrations,1);
 const unauthorisedChecks=bankChecks;
 assert.equal((await call({orderId},'order-status')).status,404);assert.equal((await call({...payload,amount:99},'order-status')).status,404);assert.equal(bankChecks,unauthorisedChecks);
 assert.equal((await call({},'poll-payments')).status,401);
 let status=await(await call(payload,'order-status')).json();assert.equal(status.paid,false);assert.equal(status.status,'awaiting_payment');assert.equal(notifications.length,2);
 const auth=async()=>{const time=String(Math.floor(Date.now()/1000)),nonce=crypto.randomUUID();return {'x-worker-time':time,'x-worker-nonce':nonce,'x-worker-signature':await workerSignature(worker,'poll-payments',time,nonce)};};let poll=await(await call({},'poll-payments',await auth())).json();assert.equal(poll.checked,1);assert.equal(poll.failed,0);
 assert.equal((await db.db.query('select last_error from le_orders where order_id=$1',[orderId])).rows[0].last_error,null);
 bankStatus=2;rejectRecipient=true;
 status=await(await call(payload,'order-status')).json();assert.equal(status.paid,true);assert.equal(status.status,'paid');assert.equal(notifications.length,4);
 assert.equal((await db.db.query('select telegram_sent from le_orders where order_id=$1',[orderId])).rows[0].telegram_sent,false);
 rejectRecipient=false;const checkedAfterPayment=bankChecks;
 await db.db.exec("update le_order_effects set next_attempt_at=now()-interval '1 second' where state='failed'");
 poll=await(await call({},'poll-payments',await auth())).json();assert.equal(poll.failed,0);assert.equal(notifications.length,5);
 assert.equal(notifications.filter(n=>n.chat_id==='123').length,2,'successful COD/card recipients are never resent');
 assert.equal((await db.db.query('select telegram_sent,status from le_orders where order_id=$1',[orderId])).rows[0].telegram_sent,true);
 poll=await(await call({},'poll-payments',await auth())).json();assert.equal(poll.checked,0);assert.equal(notifications.length,5);assert.equal(registrations,1);assert.equal(bankChecks,checkedAfterPayment,'delivery retries reuse persisted payment evidence');
 assert.equal((await call({},'hook')).status,404);
});

test('bank evidence rejects mismatches and never promotes authorisation/unpaid to paid',()=>{
 const expected={orderId:'x',paymentId:'p',total:100};const base={orderNumber:'x',orderId:'p',amount:10000};const evidence=o=>o.orderStatus===2?{amount:o.amount}:null;
 assert.equal(bankState({...base,orderStatus:0},expected,evidence),'awaiting_payment');
 assert.equal(bankState({...base,orderStatus:1},expected,evidence),'awaiting_payment');
 assert.equal(bankState({...base,orderStatus:6},expected,evidence),'cancelled');
 for(const bad of [{amount:10001},{orderNumber:'other'},{orderId:'other'},{errorCode:5},{orderStatus:99},{orderStatus:0,paymentState:'DEPOSITED'}])assert.throws(()=>bankState({...base,orderStatus:0,...bad},expected,evidence));
});
