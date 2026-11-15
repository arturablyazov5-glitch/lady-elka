import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createLeadHandler,LEAD_SITE_ORIGINS} from '../handler.mjs';
import {leadDatabase} from './database.mjs';

test('lead CORS preserves configured origins and always admits apex, www and technical; unrelated origin rejected', async()=>{
 const configured='https://existing.example, http://localhost:4174';
 const handler=createLeadHandler({env:k=>k==='CORS_ORIGIN'?configured:'',fetch:()=>{throw Error('Unexpected request');}});
 for(const origin of [...LEAD_SITE_ORIGINS,'https://existing.example','http://localhost:4174']){
  const r=await handler(new Request('https://edge.test/lead',{method:'OPTIONS',headers:{Origin:origin}}));
  assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origin);
 }
 assert.equal((await handler(new Request('https://edge.test/lead',{method:'OPTIONS',headers:{Origin:'https://attacker.example'}}))).status,403);
});

test('atomic direct claim guards independently reject future backoff and cap, lease and parallel stale claims',async t=>{
 const {db}=await leadDatabase();t.after(()=>db.close());
 const id=crypto.randomUUID();
 await db.query(`insert into le_leads(id,fingerprint,payload,ip_hash,phone_hash,recipients) values ($1,'test','{}','i','p','["101"]')`,[id]);
 const claim=async()=> (await db.query('select public.le_claim_lead($1,$2) as v',[id,crypto.randomUUID()])).rows[0].v;
 assert.ok(await claim());assert.equal(await claim(),null);
 await db.query("update le_leads set lease_until=null,lease_token=null,next_attempt_at=now()+interval '1 hour' where id=$1",[id]);
 assert.equal(await claim(),null); // backoff alone, below cap
 await db.query('update le_leads set next_attempt_at=now(),attempt_count=8 where id=$1',[id]);
 assert.equal(await claim(),null); // cap alone, already due
 await db.query('update le_leads set attempt_count=7 where id=$1',[id]);
 const claims=await Promise.all(Array.from({length:12},claim));
 assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean).attempt_count,8);
 // Even an expired lease cannot bypass the attempt cap.
 await db.query("update le_leads set lease_until=now()-interval '1 second' where id=$1",[id]);
 assert.equal(await claim(),null);
 await db.query("update le_leads set attempt_count=0,delivery_status='delivered' where id=$1",[id]);
 assert.equal(await claim(),null);
});

test('ACK evidence contains validated message_id and recipient hash; partial retry only sends missing recipient; bad ACK is not evidence',async t=>{
 const {db,request}=await leadDatabase();t.after(()=>db.close());
 const evidence=[],calls=[];let failGroup=true;
 const env={SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'101,-100202',LEAD_RETRY_TOKEN:'synthetic-retry-token-0123456789abcdef'};
 const handler=createLeadHandler({env:k=>env[k],evidence:event=>evidence.push(event),fetch:async(url,options)=>{
  if(url.startsWith('https://db.test'))return request(url,options);
  assert.match(url,/^https:\/\/api.telegram.org\/botsynthetic\/(sendPhoto|sendMessage)$/);
  const p=JSON.parse(options.body);calls.push(p.chat_id);
  if(failGroup&&p.chat_id==='-100202')return Response.json({ok:false},{status:502});
  return Response.json({ok:true,result:{chat:{id:Number(p.chat_id)},message_id:calls.length}});
 }});
 const id=crypto.randomUUID(),payload={id,type:'question',phone:'+70000000000',comment:'TEST QA / НЕ ОБРАБАТЫВАТЬ / НЕ ЗВОНИТЬ',consent:true,page:LEAD_SITE_ORIGINS[2]+'/catalog/'};
 const post=()=>handler(new Request('https://edge.test/lead',{method:'POST',headers:{Origin:LEAD_SITE_ORIGINS[2],'content-type':'application/json'},body:JSON.stringify(payload)}));
 assert.equal((await post()).status,202);assert.equal(evidence.length,1);assert.equal(evidence[0].message_id,1);
 const sha=x=>createHash('sha256').update(x).digest('hex');
 assert.equal(evidence[0].recipient_sha256,sha('101'));assert.equal(evidence[0].recipient_match,true);
 await post();assert.equal(calls.length,2); // backoff
 await db.exec('update le_lead_retry_settings set enabled=true; update le_leads set next_attempt_at=now()');failGroup=false;
 const retry=()=>handler(new Request('https://edge.test/lead?action=retry',{method:'POST',headers:{'x-lead-retry-token':env.LEAD_RETRY_TOKEN,'content-type':'application/json'},body:'{}'}));
 assert.equal((await(await retry()).json()).delivered,1);
 assert.deepEqual(calls,['101','-100202','-100202']);assert.equal(evidence.length,2);assert.equal(evidence[1].recipient_sha256,sha('-100202'));assert.equal(evidence[1].message_id,3);
 await retry();await post();assert.equal(calls.length,3);
 assert.equal((await db.query('select delivery_status from le_leads where id=$1',[id])).rows[0].delivery_status,'delivered');
 assert.ok(!JSON.stringify(evidence).includes('synthetic'));assert.ok(!JSON.stringify(evidence).includes('chat_id'));
});

test('Telegram response missing message_id never emits ACK or marks delivered; evidence logger failure cannot affect successful delivery',async t=>{
 const {db,request}=await leadDatabase();t.after(()=>db.close());
 const env={SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'101'};let valid=false,events=0;
 const handler=createLeadHandler({env:k=>env[k],evidence:()=>{events++;throw Error('logger unavailable');},fetch:async(url,options)=>{
  if(url.startsWith('https://db.test'))return request(url,options);
  assert.match(url,/^https:\/\/api.telegram.org\/botsynthetic\/(sendPhoto|sendMessage)$/);
  return Response.json({ok:true,result:{chat:{id:101},...(valid?{message_id:42}:{})}});
 }});
 const id=crypto.randomUUID(),payload={id,type:'question',phone:'+70000000000',comment:'Mock ACK check',consent:true,page:'https://lady-elka.ru/'};
 const post=()=>handler(new Request('https://edge.test/lead',{method:'POST',headers:{Origin:'https://lady-elka.ru','content-type':'application/json'},body:JSON.stringify(payload)}));
 assert.equal((await post()).status,202);assert.equal(events,0);
 const r=(await db.query('select delivered_to,delivery_status from le_leads where id=$1',[id])).rows[0];assert.deepEqual(r.delivered_to,[]);assert.equal(r.delivery_status,'pending');
 await db.exec('update le_leads set next_attempt_at=now()');valid=true;
 assert.equal((await post()).status,200);assert.equal(events,1);assert.equal((await db.query('select delivery_status from le_leads where id=$1',[id])).rows[0].delivery_status,'delivered');
});
