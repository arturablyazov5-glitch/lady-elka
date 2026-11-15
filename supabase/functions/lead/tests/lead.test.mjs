import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadHandler, normalizeLead, telegramText } from '../handler.mjs';

import { leadDatabase } from './database.mjs';
const payload = (type='question') => ({ id: crypto.randomUUID(), type, name: 'ТЕСТ <b>&', phone: '+7 (999) 123-45-67',
  email: 'qa@example.test', comment: '<script>comment & hello</script>', city:'Москва',business:'Дизайн',page:'https://lady-elka.ru/blog?token=private',consent:true,website:'' });
const post = data => new Request('https://edge.test/lead', { method:'POST',headers:{'Content-Type':'application/json',Origin:'https://lady-elka.ru','x-forwarded-for':'127.0.0.1'},body:JSON.stringify(data) });

test('lead validation, escaping and schema',()=>{
 for (const type of ['question','installment','consultation','wholesale','callback']) assert.equal(normalizeLead(payload(type)).type,type);
 for (const phone of ['89991234567','9991234567','+7 (999) 123-45-67']) assert.equal(normalizeLead({...payload(),phone}).phone,'+79991234567');
 for (const fields of [{phone:'123'},{phone:'+799912345678'},{phone:'evil79991234567'},{consent:false},{type:'__proto__'},{email:'bad'},{comment:''},{comment:'x'.repeat(1501)},{page:'javascript:alert(1)'},{id:'bad'}]) assert.throws(()=>normalizeLead({...payload(),...fields}));
 assert.throws(()=>normalizeLead({...payload('wholesale'),business:''}));
 const msg=telegramText({id:crypto.randomUUID(),created_at:new Date().toISOString(),payload:normalizeLead(payload())});
 assert.ok(msg.includes('&lt;script&gt;'));assert.ok(msg.includes('&amp;'));assert.ok(!msg.includes('?token='));assert.ok(!msg.includes('<script>'));
});

test('lead durable intake, replay, partial TG failure, lease and persistent limits',async t=>{
 const {db,request}=await leadDatabase();t.after(()=>db.close());
 const env={SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'101,-100202',CORS_ORIGIN:'https://lady-elka.ru',LEAD_RETRY_TOKEN:'synthetic-retry-token-0123456789abcdef'};
 let failGroup=true;const sends=[];
 const handler=createLeadHandler({env:k=>env[k],fetch:async(url,options)=>{
  if(url.startsWith('https://db.test/'))return request(url,options);
  assert.match(url,/^https:\/\/api\.telegram\.org\/botsynthetic\/send(Photo|Message)$/);
  const p=JSON.parse(options.body);sends.push(p.chat_id);
  return failGroup&&p.chat_id==='-100202'?new Response('{"ok":false}',{status:502}):Response.json({ok:true,result:{chat:{id:p.chat_id},message_id:42}});
 }});
 const p=payload();
 const first=await handler(post(p));assert.equal(first.status,202);assert.equal((await first.json()).notification,'pending');
 assert.deepEqual(sends,['101','-100202']);
 assert.deepEqual((await db.query('select delivered_to from le_leads')).rows[0].delivered_to,['101']);
 failGroup=false;
 // Replay before next_attempt_at: answered from the inbox, no Telegram call, no attempt spent.
 const early=await handler(post(p));assert.equal(early.status,202);assert.equal((await early.json()).notification,'pending');
 assert.deepEqual(sends,['101','-100202']);
 assert.equal((await db.query('select attempt_count from le_leads where id=$1',[p.id])).rows[0].attempt_count,1);
 // Once due, a replay delivers only the missing recipient.
 await db.query('update le_leads set next_attempt_at=now() where id=$1',[p.id]);
 assert.equal((await handler(post(p))).status,200);assert.deepEqual(sends,['101','-100202','-100202']);
 assert.equal((await handler(post(p))).status,200);assert.equal(sends.length,3);
 assert.equal((await handler(post({...p,comment:'changed'}))).status,409);
 // Same phone is limited across new requests and handler instances, replays excluded.
 for(let n=0;n<2;n++)assert.equal((await handler(post(payload()))).status,200);
 const limited=await handler(post(payload()));assert.equal(limited.status,429);
 assert.equal(limited.headers.get('retry-after'),'600');assert.match(limited.headers.get('access-control-expose-headers'),/Retry-After/);
 assert.equal((await db.query('select count(*)::int as n from le_leads')).rows[0].n,3);
 assert.equal((await handler(post({...payload(),website:'spam'}))).status,200);assert.equal(sends.length,7);
 assert.equal((await handler(new Request('https://edge.test/lead',{method:'OPTIONS',headers:{Origin:'https://evil.test'}}))).status,403);
 assert.equal((await handler(new Request('https://edge.test/lead',{method:'OPTIONS',headers:{Origin:'https://lady-elka.ru'}}))).status,204);
 assert.equal((await handler(new Request('https://edge.test/lead'))).status,405);
 assert.equal((await handler(new Request('https://edge.test/lead',{method:'POST',body:'{}'}))).status,415);
 assert.equal((await handler(post({...payload(),comment:'x'.repeat(13000)}))).status,413);
 assert.equal((await handler(post({...payload(),consent:false}))).status,400);
 assert.equal((await handler(new Request('https://edge.test/lead?action=retry',{method:'POST'}))).status,401);
 // New phone, failed TG, queue replay sends only pending recipients.
 failGroup=true;
 const next={...payload(),phone:'+79991234568'};
 assert.equal((await handler(post(next))).status,202);
 await db.query('update le_leads set next_attempt_at=now() where id=$1',[next.id]);
 failGroup=false;
 await db.query('update le_lead_retry_settings set enabled=true');
 const retry=await handler(new Request('https://edge.test/lead?action=retry',{method:'POST',headers:{'x-lead-retry-token':env.LEAD_RETRY_TOKEN}}));
 assert.equal((await retry.json()).delivered,1);
 const id=crypto.randomUUID(), args={p_id:id,p_fingerprint:'f',p_payload:{},p_ip_hash:'i',p_phone_hash:'p',p_recipients:['101']};
 const row=await (await request('https://db.test/rest/v1/rpc/le_accept_lead',{body:JSON.stringify(args)})).json();assert.equal(row.id,id);
 const token=crypto.randomUUID();
 assert.ok(await (await request('https://db.test/rest/v1/rpc/le_claim_lead',{body:JSON.stringify({p_id:id,p_token:token})})).json());
 assert.equal(await (await request('https://db.test/rest/v1/rpc/le_claim_lead',{body:JSON.stringify({p_id:id,p_token:crypto.randomUUID()})})).json(),null);
 await assert.rejects(db.exec('set role anon; select * from le_leads;'));await db.exec('reset role');
});

test('storage failure never acknowledges a lost lead',async()=>{
 const handler=createLeadHandler({env:k=>({SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic'}[k]),fetch:async()=>new Response('',{status:503})});
 const result=await handler(post(payload()));assert.equal(result.status,503);assert.equal((await result.json()).ok,false);
});

test('parallel duplicate submissions claim Telegram once; IP budget cannot be bypassed by changing phone',async t=>{
 const {db,request}=await leadDatabase();t.after(()=>db.close());
 let sends=0;
 const env={SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'101'};
 const handler=createLeadHandler({env:k=>env[k],fetch:async(url,options)=>{
  if(url.startsWith('https://db.test/'))return request(url,options);
  sends++;await new Promise(r=>setTimeout(r,25));return Response.json({ok:true,result:{chat:{id:101},message_id:1}});
 }});
 const p=payload();
 const results=await Promise.all(Array.from({length:8},()=>handler(post(p))));
 assert.ok(results.every(r=>[200,202].includes(r.status)));assert.equal(sends,1);
 for(let n=1;n<5;n++)assert.equal((await handler(post({...payload(),phone:'+7999000000'+n}))).status,200);
 assert.equal((await handler(post({...payload(),phone:'+79990000009'}))).status,429);
 assert.equal(sends,5);
 // Private-only snapshots remain private even if TG_CHAT_IDS later includes the group.
 env.TG_CHAT_IDS='101,-100202';assert.equal((await handler(post(p))).status,200);assert.equal(sends,5);
});
