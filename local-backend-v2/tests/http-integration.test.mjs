import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createGateway} from '../gateway.mjs';
import {createHttpAuth} from '../http-auth.mjs';
import {createServer} from '../http-server.mjs';
import {createRuntime} from '../runtime.mjs';
import {randomBytes} from 'node:crypto';
import {createEnvelope} from '../../storefront/api-v2/contract.mjs';
const endpoint='http://localhost:9999/pay-v2';
function envelope(suffix='12345678',patch={}){
 const id=`LE-1791000000000-V2-${suffix}`;
 const customer={name:'Synthetic',email:'test@example.invalid',phone:'79000000000',address:'Synthetic',contactPref:'phone'};
 return createEnvelope({orderId:id,clientId:'untrusted',paymentMethod:'card',amount:1,description:'synthetic',email:customer.email,phone:customer.phone,address:customer.address,contactPref:customer.contactPref,customer,delivery:{address:customer.address},items:[{productId:'fixture',variantId:'fixture',kind:'tree',quantity:1,price:1}],promo:null,promoCode:'',successUrl:`http://localhost:4176/spasibo?oid=${id}`,failUrl:`http://localhost:4176/pay-return?oid=${id}&fail=1`,...patch},endpoint);
}
async function fixture(t,settings={}){
 const db=new PGlite();
 await db.exec(await readFile(new URL('../schema-draft.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../roles-draft.sql',import.meta.url),'utf8'));
 await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity,window_ms,owner_capacity) SELECT unnest(ARRAY['create','request','ownerRequest','replay','status','callback','internal','bank','telegram']),1000,60000,1000; UPDATE le_checkout_v2.gateway_policy SET create_open=true");
 const sessions=new Map(),capabilities=new Map(),tokens=[];
 for(const owner of ['alice','bob']){
  const session={sessionId:owner+'-session',owner,expiresMs:Date.now()+60000,revoked:false,scopes:['create','status']};sessions.set('Bearer '+owner,session);
  for(const scope of ['create','status']){
   const token=randomBytes(32).toString('hex');tokens.push(token);
   const record={...session,scopes:[scope],token};capabilities.set(owner+':'+scope,record);
   await db.query('INSERT INTO le_checkout_v2.capabilities VALUES($1,$2,$3,$4,$5)',[token,owner,record.expiresMs,scope==='create',scope==='status']);
  }
 }
 // Single PGlite session, role switching serialized outside application executor.
 let tail=Promise.resolve();const seen=[],queries=[];
 const executors=Object.fromEntries(['create','status','callback','internal'].map(role=>[role,{query(sql,args){const task=tail.then(async()=>{await db.exec('SET SESSION AUTHORIZATION le_v2_'+role);try{seen.push(role);queries.push({role,sql});return await db.query(sql,args);}finally{await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');}});tail=task.catch(()=>{});return task.then(async result=>{if(settings.afterQuery)await settings.afterQuery(role,sql);return result;});}}]));
 const grant=scope=>({expiresMs:Date.now()+60000,revoked:false,scopes:[scope]});
 let lookups=0,banks=0,sends=0,evidence;
 const authOptions={verifySession:async request=>sessions.get(request.headers.authorization),capabilityStore:{resolve:async({owner,scope})=>{lookups++;return capabilities.get(owner+':'+scope);}},
  verifyCallback:async({request,body})=>{
   assert.deepEqual(JSON.parse(request.rawBody.toString()),body);assert.equal(request.method,'POST');
   return request.headers.authorization==='Bearer callback'?grant('callback'):request.headers.authorization==='Bearer internal'?grant('internal'):null;
  },verifyInternal:async({request})=>request.headers.authorization==='Bearer internal'?grant('internal'):request.headers.authorization==='Bearer callback'?grant('callback'):null};
 const auth=createHttpAuth(authOptions);
 const gatewayOptions={executors,auth:auth.auth,identity:{apiVersion:'2',fingerprintVersion:'sha256-canonical-json-v1',ownerEndpoint:endpoint},verifyCatalog:async()=>({verified:true,fresh:true,revision:'fixture',amountMinor:100}),recipients:['synthetic'],paymentOrigins:['https://mock-bank.invalid'],provider:{register:async({order})=>{banks++;return {outcome:'confirmed',paymentId:'p-'+order.id,bankNumber:order.bank_number,amount:Number(order.amount),paymentURL:'https://mock-bank.invalid/pay'};},evidence:async()=>evidence},notifier:{send:async()=>{sends++;return {outcome:'confirmed'};}}};
 const gateway=createGateway(gatewayOptions);
 const runtime=settings.runtime?createRuntime({...gatewayOptions,...authOptions,origins:[],localCreateEnabled:true,timeoutMs:settings.timeoutMs??5000}):null;
 const server=runtime?null:createServer({gateway:input=>auth.dispatch(gateway,input),timeoutMs:settings.timeoutMs??5000});
 const address=runtime?await runtime.listen():await new Promise(r=>server.listen(0,()=>r(server.address())));
 t.after(async()=>{if(runtime)await runtime.shutdown();else await new Promise(r=>{server.close(r);server.closeAllConnections();});await db.close();});
 const base='http://127.0.0.1:'+address.port;
 async function call(path,body={},authorization='Bearer alice'){
  const response=await fetch(base+'/v2/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:authorization},body:JSON.stringify(body)});
  const text=await response.text();const headers=Object.fromEntries(response.headers);
  for(const token of tokens){assert.ok(!text.includes(token));assert.ok(!JSON.stringify(headers).includes(token));}
  return {status:response.status,body:JSON.parse(text),headers};
 }
 return {db,call,gateway,runtime,queries,sessions,capabilities,seen,counts:()=>({banks,sends,lookups}),evidence:v=>evidence=v};
}
test('HTTP sessions map private scoped SQL capabilities; replay and foreign ownership',async t=>{
 const f=await fixture(t),env=envelope();
 const results=await Promise.all(Array.from({length:4},()=>f.call('create',env)));
 assert.ok(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(f.counts().banks,1);
 assert.equal((await f.call('status',{orderId:env.orderId})).body.paymentURL,'https://mock-bank.invalid/pay');
 for(const orderId of [env.orderId,'missing'])assert.deepEqual((await f.call('status',{orderId,owner:'alice',sessionId:'alice-session',credentials:f.capabilities.get('alice:status').token},'Bearer bob')).body,{error:'NOT_FOUND'});
 assert.equal((await f.call('create',envelope('abcdef12',{description:'bob'}),'Bearer bob')).status,200);
 assert.equal((await f.call('status',{orderId:envelope('abcdef12').orderId},'Bearer alice')).status,404);
 const rows=(await f.db.query('SELECT owner FROM le_checkout_v2.orders ORDER BY owner')).rows;assert.deepEqual(rows,[{owner:'alice'},{owner:'bob'}]);
 assert.equal((await f.call('create',envelope('12345678',{description:'changed'}))).status,409);assert.equal(f.counts().banks,2);
 assert.ok(f.seen.includes('create')&&f.seen.includes('status')&&f.seen.includes('internal'));assert.ok(f.counts().lookups>=10);
});
test('HTTP expired/revoked/foreign sessions and capability records deny; SQL independently checks expiry/revocation',async t=>{
 const f=await fixture(t),env=envelope();assert.equal((await f.call('create',env)).status,200);
 assert.equal((await f.call('status',{orderId:env.orderId},'Bearer unknown')).status,401);
 const session=f.sessions.get('Bearer alice'),record=f.capabilities.get('alice:status');
 for(const target of [session,record])for(const [key,value] of [['expiresMs',0],['revoked',true]]){
  const old=target[key];target[key]=value;assert.equal((await f.call('status',{orderId:env.orderId})).status,401);target[key]=old;
 }
 for(const [key,value] of [['sessionId','foreign'],['owner','bob'],['scopes',['create']]]){const old=record[key];record[key]=value;assert.equal((await f.call('status',{orderId:env.orderId})).status,401);record[key]=old;}
 await f.db.query('UPDATE le_checkout_v2.capabilities SET expires_ms=0 WHERE token=$1',[record.token]);
 assert.equal((await f.call('status',{orderId:env.orderId})).status,401);
 await f.db.query('DELETE FROM le_checkout_v2.capabilities WHERE token=$1',[record.token]);assert.equal((await f.call('status',{orderId:env.orderId})).status,401);
 assert.equal(f.counts().banks,1);
});
test('HTTP callback/internal scope separation, paid effects deduplication and real SQL 429',async t=>{
 const f=await fixture(t),env=envelope();assert.equal((await f.call('create',env)).status,200);
 const o=(await f.db.query('SELECT * FROM le_checkout_v2.orders')).rows[0];const body={paymentId:o.payment_id};
 f.evidence({verified:true,status:'paid',paymentId:o.payment_id,bankNumber:o.bank_number,amount:100,observedAt:Date.now()});
 for(const credential of ['Bearer alice','Bearer internal'])assert.equal((await f.call('callback',body,credential)).status,401);
 for(const path of ['internal/poll','internal/retry'])for(const credential of ['Bearer alice','Bearer callback'])assert.equal((await f.call(path,{},credential)).status,401);
 assert.deepEqual(f.counts().banks,1);assert.equal(f.counts().sends,0);
 const results=await Promise.all([f.call('callback',body,'Bearer callback'),f.call('internal/poll',{},'Bearer internal')]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
 assert.equal((await f.call('internal/retry',{},'Bearer internal')).status,200);assert.equal(f.counts().sends,1);assert.equal((await f.call('status',{orderId:o.id})).body.status.status,'paid');
 await f.db.exec("UPDATE le_checkout_v2.budgets SET capacity=0 WHERE key='status'");
 const limited=await f.call('status',{orderId:o.id});assert.equal(limited.status,429);assert.equal(limited.body.error,'RATE_LIMITED');assert.match(limited.headers['retry-after'],/^[1-9][0-9]*$/);
 await f.db.exec("UPDATE le_checkout_v2.budgets SET capacity=0 WHERE key='request'");assert.equal((await f.call('create',envelope('abcdef13'))).status,429);assert.equal(f.counts().banks,1);assert.equal(f.counts().sends,1);
});
test('real gateway rejects expired/aborted status before restricted SQL gate',async t=>{
 const f=await fixture(t);
 for(const kind of ['expired','aborted']){
  const controller=new AbortController();if(kind==='aborted')controller.abort();
  const before=f.seen.length;
  const result=await f.gateway({route:'status',body:{orderId:'missing'},credentials:f.capabilities.get('alice:status').token,signal:controller.signal,deadline:kind==='expired'?Date.now()-1:Date.now()+1000});
  assert.deepEqual(result,{status:504,body:{error:'REQUEST_CANCELLED'}});assert.equal(f.seen.length,before);
 }
});
test('deferred real identity after timeout/shutdown prevents admission/status RPC; live request stays isolated',async t=>{
 for(const route of ['create','status'])for(const stop of ['timeout','shutdown']){
  let entered,release,count=0;const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
  const f=await fixture(t,{runtime:stop==='shutdown',timeoutMs:80,afterQuery:async(role,sql)=>{
   if(role===route&&sql==='SELECT session_user,current_user'&&++count===2){entered();await pending;}
  }});
  const request=f.call(route,route==='create'?envelope():{orderId:'missing'}).catch(()=>({disconnected:true}));await started;
  if(stop==='shutdown'){await f.runtime.shutdown();assert.deepEqual(await request,{disconnected:true});}
  else assert.equal((await request).status,504);
  release();await new Promise(r=>setTimeout(r,30));
  assert.equal(f.queries.some(x=>/api_create|api_status/.test(x.sql)),false,route+'/'+stop);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM le_checkout_v2.orders')).rows[0].n,0);assert.equal(f.counts().banks,0);assert.equal(f.counts().sends,0);
 }
 let entered,release,count=0;const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 const f=await fixture(t,{timeoutMs:250,afterQuery:async(role,sql)=>{if(role==='create'&&sql==='SELECT session_user,current_user'&&++count===2){entered();await pending;}}});
 const cancelled=f.call('create',envelope());await started;
 const live=await f.call('create',envelope('abcdef15'),'Bearer bob');assert.equal(live.status,200);
 assert.equal((await cancelled).status,504);release();await new Promise(r=>setTimeout(r,30));
 assert.equal(f.queries.filter(x=>x.sql.includes('api_create')).length,1);assert.equal(f.counts().banks,1);
 assert.deepEqual((await f.db.query('SELECT owner FROM le_checkout_v2.orders')).rows,[{owner:'bob'}]);
});
