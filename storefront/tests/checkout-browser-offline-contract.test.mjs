import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { buildOrderPayload } from '../client/order-payload.js';

// Synthetic fixture only. v2 below is a proposed contract, not an activated endpoint.
const customer={name:'Тест',email:'qa@example.test',phone:'+79990000000',address:'Синтетический адрес',contactPref:'Telegram',comment:'QA'};
const item={productId:'1',variantId:'1:Зелёная:180',kind:'tree',title:'Тестовое дерево',options:{category:'Зелёная',height:'180'},quantity:1,price:1000};
const structured=()=>buildOrderPayload([item],customer,null,'http://127.0.0.1:4176',1700000000000,'card');
const legacy=()=>{
 const p=structured();return Object.fromEntries(['amount','description','email','phone','orderId','clientId','successUrl','failUrl','promoCode','address','contactPref'].map(k=>[k,p[k]]));
};
// Future pending API ownership must be checked before POST; no migration of ambiguous old pending.
function proposedPending(envelope,expected){
 if(envelope?.apiVersion!==2||envelope.endpoint!==expected||envelope.fingerprintVersion!==1)throw new Error('pending API identity mismatch');
 if(envelope.orderId!==envelope.payload?.orderId)throw new Error('pending order identity mismatch');
 if(!['card','cash_on_delivery'].includes(envelope.payload.paymentMethod)||!envelope.payload.customer||!envelope.payload.delivery||!envelope.payload.items?.length)throw new Error('structured payload required');
 return envelope.payload;
}
test('proposed v2 pending preserves exact payload and rejects legacy/cross-endpoint/changed identity',()=>{
 const endpoint='http://127.0.0.1:4176/functions/v2/checkout';const payload=structured();
 const envelope={apiVersion:2,endpoint,fingerprintVersion:1,orderId:payload.orderId,payload};
 assert.deepEqual(proposedPending(JSON.parse(JSON.stringify(envelope)),endpoint),payload);
 for(const modified of [{payload:legacy()},{apiVersion:1},{endpoint:'http://127.0.0.1:4176/functions/v1/pay'},{fingerprintVersion:2},{orderId:'different'}])
  assert.throws(()=>proposedPending({...envelope,...modified},endpoint));
 assert.throws(()=>proposedPending({signature:'old',payload},endpoint));
});
test('current local handler rejects synthetic saved legacy payload; adding method alone is insufficient',async t=>{
 const original={Deno:globalThis.Deno,fetch:globalThis.fetch};let handle;let calls=0,limiter=0;
 const env={ALFA_API_USER:'mock',ALFA_API_PASS:'mock',TG_BOT_TOKEN:'mock',TG_CHAT_IDS:'mock',SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'mock'};
 globalThis.Deno={env:{get:k=>env[k]},serve:fn=>{handle=fn},createHttpClient:()=>({})};
 globalThis.fetch=async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:1');
  // Order admission limiter (fail-closed, before validation of the order body); 0 = admitted. Its counter is the only allowed write.
  if(u.pathname==='/rest/v1/rpc/le_rate_limit_take'){limiter++;return new Response('0');}
  assert.equal(options?.method||'GET','GET');assert.equal(u.pathname,'/rest/v1/le_orders');calls++;return new Response('[]');
 };
 t.after(()=>{globalThis.Deno=original.Deno;globalThis.fetch=original.fetch});
 const built=await build({entryPoints:['supabase/functions/pay/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
 await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
 for(const method of [undefined,'card','cash_on_delivery']){
  const payload=legacy();if(method)payload.paymentMethod=method;
  const url='http://127.0.0.1:4176/functions/v1/pay'+(method==='cash_on_delivery'?'?action=create-cod-order':'');
  const result=await handle(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));
  assert.equal(result.status,400);const body=await result.json();assert.match(body.message,/оплат|Заполните|Корзина пуста/);
 }
 assert.ok(calls>=1); // only mock GET; zero reserve/bank/Telegram writes allowed.
});
