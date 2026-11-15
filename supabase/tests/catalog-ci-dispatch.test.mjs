import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
const migration = new URL('../migrations/20261010110000_catalog_ci_dispatch.sql', import.meta.url);
const original = new URL('../migrations/20261008110000_catalog_autosync.sql', import.meta.url);
async function fixture({transport=true}={}) {
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table le_catalog_products(id text primary key,price int);create table le_catalog_settings(id int);create table le_promo_codes(id text);
 create schema storage;create table storage.objects(id int primary key,bucket_id text,name text);
 create schema net;create table net.http_request_queue(id bigserial primary key,url text,headers jsonb,body jsonb);
 create table net._http_response(id bigint primary key,status_code int,content text);
 create function net.http_get(url text,headers jsonb,timeout_milliseconds int) returns bigint language sql as $$
 insert into net.http_request_queue(url,headers) values(url,headers) returning id$$;
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$
 insert into net.http_request_queue(url,headers,body) values(url,headers,body) returning id$$;
 create schema cron;create table cron.job(jobid bigint,jobname text);
 create function cron.unschedule(bigint) returns boolean language sql as $$delete from cron.job where jobid=$1 returning true$$;`);
 await db.exec(await readFile(original,'utf8'));
 await db.exec(await readFile(migration,'utf8'));
 await db.exec(await readFile(migration,'utf8'));
 const dispatches=[];const published={trees:'price=100',decor:'decor',promos:'promos'};
 let githubStatus=204;let feedStatus=200;
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture').pathname;
  if(req.method==='POST') {
   let body='';for await(const chunk of req)body+=chunk;
   dispatches.push({path,body:JSON.parse(body)});res.writeHead(githubStatus);res.end();return;
  }
  const name=path.split('/').at(-1).replace('.csv','');
  const price=(await db.query('select price from le_catalog_products order by id limit 1')).rows[0]?.price??100;
  const body=path.includes('/functions/')?(name==='trees'?`price=${price}`:name):published[name];
  res.writeHead(feedStatus,{'Content-Type':'text/csv'});res.end(body);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 if(transport)await db.exec(`create or replace function le_catalog_sync_send(p_revision bigint) returns bigint language sql security definer set search_path=pg_catalog,public as $$
 select net.http_post(url:='https://api.github.com/repos/arturablyazov5-glitch/lady-elka-cloud-preview/dispatches',
 headers:='{"Accept":"application/vnd.github+json","Content-Type":"application/json"}'::jsonb,
 body:=jsonb_build_object('event_type','catalog_changed','client_payload',jsonb_build_object('revision',p_revision)),timeout_milliseconds:=10000)$$;`);
 async function worker(){
  const rows=(await db.query('select * from net.http_request_queue order by id')).rows;
  for(const row of rows){
   const u=new URL(row.url);const response=await fetch(origin+u.pathname+u.search,{method:row.body?'POST':'GET',headers:row.headers,body:row.body?JSON.stringify(row.body):undefined});
   await db.query('insert into net._http_response values($1,$2,$3)',[row.id,response.status,await response.text()]);
   await db.query('delete from net.http_request_queue where id=$1',[row.id]);
  }
 }
 return {db,published,dispatches,worker,state:async()=>(await db.query('select * from le_catalog_sync_state')).rows[0],
  enable:()=>db.exec('update le_catalog_sync_state set enabled=true'),tick:()=>db.exec('select le_catalog_sync_dispatch()'),
  quiet:()=>db.exec("update le_catalog_sync_state set changed_at=clock_timestamp()-interval '60 seconds'"),
  retryDue:()=>db.exec("update le_catalog_sync_state set retry_at=clock_timestamp()-interval '1 second'"),
  githubStatus:s=>githubStatus=s,feedStatus:s=>feedStatus=s,
  close:async()=>{await new Promise(resolve=>server.close(resolve));await db.close();}};
}
async function verifiedDispatch(f){await f.quiet();await f.tick();await f.worker();await f.tick();await f.worker();await f.tick();}

test('migration twice: disabled, no cron, triggers inert and every API role denied',async()=>{
 const f=await fixture();try{
  assert.equal((await f.state()).enabled,false);assert.equal((await f.db.query('select count(*)::int n from cron.job')).rows[0].n,0);
  await f.db.exec("insert into le_catalog_products values('a',100);insert into storage.objects values(1,'le-catalog-feeds','trees.csv');select le_catalog_sync_dispatch();");
  assert.equal((await f.state()).revision,0);assert.equal(f.dispatches.length,0);
  for(const role of ['anon','authenticated','service_role']){
   for(const sql of ['select * from le_catalog_sync_state','select le_catalog_sync_dispatch()','select le_catalog_sync_send(1)','select le_catalog_sync_disable()']){
    await f.db.exec(`set role ${role}`);await assert.rejects(f.db.exec(sql),/permission denied/);await f.db.exec('reset role');
   }
  }
 }finally{await f.close();}
});
for(const edits of [1,10])test(`${edits} price edits -> exactly one dispatch after 60 seconds of silence and published feeds`,async()=>{
 const f=await fixture();try{
  await f.enable();await f.db.exec("insert into le_catalog_products values('a',100)");
  for(let i=0;i<edits;i++){await f.db.exec(`update le_catalog_products set price=${200+i}`);await f.tick();}
  assert.equal((await f.db.query('select count(*)::int n from net.http_request_queue')).rows[0].n,0);
  await f.db.exec("update le_catalog_sync_state set changed_at=clock_timestamp()-interval '59 seconds'");await f.tick();assert.equal(f.dispatches.length,0);
  f.published.trees=`price=${199+edits}`;await verifiedDispatch(f);await f.tick();
  assert.equal(f.dispatches.length,1);assert.deepEqual(f.dispatches[0],{path:'/repos/arturablyazov5-glitch/lady-elka-cloud-preview/dispatches',body:{event_type:'catalog_changed',client_payload:{revision:1+edits}}});
  assert.equal((await f.state()).sent_revision,1+edits);
 }finally{await f.close();}
});
test('failed/partial publication blocks dispatch; stale upload and concurrent verification are rejected',async()=>{
 const f=await fixture();try{
  await f.enable();await f.db.exec("insert into le_catalog_products values('a',250)");await verifiedDispatch(f);
  assert.equal(f.dispatches.length,0);assert.equal((await f.state()).diagnostic,'feeds_not_published');
  f.published.trees='price=250';await f.retryDue();await f.tick();await f.worker();
  await f.db.exec('update le_catalog_products set price=260');await f.quiet();await f.tick();await f.worker();await f.tick();
  assert.equal(f.dispatches.length,0);assert.equal((await f.state()).diagnostic,'feeds_not_published');
  f.published.trees='price=260';await f.retryDue();await verifiedDispatch(f);assert.equal(f.dispatches.length,1);
 }finally{await f.close();}
});
test('GitHub 500/200 never ACK; retry waits two minutes after failure then rechecks feeds',async()=>{
 const f=await fixture();try{
  await f.enable();await f.db.exec("insert into le_catalog_products values('a',100)");f.githubStatus(500);await verifiedDispatch(f);
  let s=await f.state();assert.equal(s.sent_revision,0);assert.equal(s.last_status,500);assert.ok(new Date(s.retry_at)-Date.now()>119000);
  await f.tick();await f.worker();assert.equal(f.dispatches.length,1);
  await f.retryDue();f.githubStatus(200);await verifiedDispatch(f);assert.equal((await f.state()).sent_revision,0);
  await f.retryDue();f.githubStatus(204);await verifiedDispatch(f);assert.equal(f.dispatches.length,3);assert.equal((await f.state()).sent_revision,1);
 }finally{await f.close();}
});
test('new revision while GitHub request is in flight survives ACK',async()=>{
 const f=await fixture();try{
  await f.enable();await f.db.exec("insert into le_catalog_products values('a',100)");await f.quiet();await f.tick();await f.worker();await f.tick();
  await f.db.exec('update le_catalog_products set price=300');await f.worker();await f.tick();
  let s=await f.state();assert.equal(s.sent_revision,1);assert.equal(s.revision,2);assert.equal(f.dispatches.length,1);
  f.published.trees='price=300';await verifiedDispatch(f);assert.equal((await f.state()).sent_revision,2);assert.equal(f.dispatches.length,2);
 }finally{await f.close();}
});
test('settings/promos/images/feeds mutations and delete of CSV wake revision; unrelated bucket ignored',async()=>{
 const f=await fixture();try{
  await f.enable();await f.db.exec("insert into le_catalog_settings values(1);update le_catalog_settings set id=2;delete from le_catalog_settings;insert into le_promo_codes values('x');update le_promo_codes set id='y';delete from le_promo_codes;truncate le_promo_codes;insert into storage.objects values(1,'other','x');insert into storage.objects values(2,'le-catalog-images','x');update storage.objects set name='y' where id=2;delete from storage.objects where id=2;insert into storage.objects values(3,'le-catalog-feeds','trees.csv');delete from storage.objects where id=3;");
  assert.equal((await f.state()).revision,12);
  await f.db.exec("insert into cron.job values(1,'le-catalog-sync-debounce');select le_catalog_sync_disable();insert into le_promo_codes values('z');select le_catalog_sync_dispatch();");
  assert.equal((await f.state()).revision,12);assert.equal((await f.state()).enabled,false);assert.equal((await f.db.query('select count(*)::int n from cron.job')).rows[0].n,0);
 }finally{await f.close();}
});
test('real transport remains blocked even if enabled manually; no PAT read or request queued',async()=>{
 const f=await fixture({transport:false});try{
  await assert.rejects(f.db.exec('select le_catalog_sync_send(1)'),/credential would enter/);
  await f.enable();await f.db.exec("insert into le_catalog_products values('a',100)");await verifiedDispatch(f);
  assert.equal(f.dispatches.length,0);assert.equal((await f.state()).diagnostic,'transport_blocked_or_failed');
  const sql=await readFile(migration,'utf8');assert.doesNotMatch(sql,/decrypted_secret|Bearer |Authorization['"]/);
 }finally{await f.close();}
});

test('GET 500 and missing pg_net responses fail closed; missing dispatch response retries after timeout',async()=>{
 const f=await fixture();try{
  await f.enable();await f.db.exec("insert into le_catalog_products values('a',100)");f.feedStatus(500);await verifiedDispatch(f);
  assert.equal(f.dispatches.length,0);assert.equal((await f.state()).diagnostic,'feeds_not_published');
  f.feedStatus(200);await f.retryDue();await f.tick();await f.tick();assert.equal(f.dispatches.length,0);
  await f.db.exec("update le_catalog_sync_state set verify_started_at=clock_timestamp()-interval '121 seconds'");await f.tick();assert.equal((await f.state()).diagnostic,'feeds_not_published');
  await f.worker();await f.retryDue();await f.tick();await f.worker();await f.tick();
  assert.ok((await f.state()).request_id);await f.tick();assert.equal((await f.state()).last_status,null);
  await f.db.exec("update le_catalog_sync_state set requested_at=clock_timestamp()-interval '121 seconds'");await f.tick();
  assert.equal((await f.state()).diagnostic,'dispatch_failed');assert.ok(new Date((await f.state()).retry_at)-Date.now()>119000);
 }finally{await f.close();}
});
test('reapply preserves revisions/ACK but disables; exception text containing a secret is never persisted',async()=>{
 const f=await fixture();try{
  await f.enable();await f.db.exec("insert into le_catalog_products values('a',100)");await verifiedDispatch(f);
  await f.db.exec(await readFile(migration,'utf8'));let s=await f.state();assert.equal(s.sent_revision,1);assert.equal(s.revision,1);assert.equal(s.enabled,false);
  await f.db.exec(`create or replace function le_catalog_sync_send(p_revision bigint) returns bigint language plpgsql as $$begin raise exception 'SECRET-FIXTURE';end$$;`);
  await f.enable();await f.db.exec('update le_catalog_products set price=101');f.published.trees='price=101';await verifiedDispatch(f);
  s=await f.state();assert.equal(s.diagnostic,'transport_blocked_or_failed');assert.equal(JSON.stringify(s).includes('SECRET-FIXTURE'),false);
 }finally{await f.close();}
});
