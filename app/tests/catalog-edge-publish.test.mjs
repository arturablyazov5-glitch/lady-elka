import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
const base='https://offline.invalid/functions/v1/catalog',secret='synthetic-private-github-token';
const paths=['supabase/functions/catalog/index.ts','agent-context/catalog-button-candidate/supabase/functions/catalog/index.ts'];
async function load(file,options={}){
 const env={SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',CATALOG_ADMIN_PASSWORD:'synthetic-admin',CATALOG_SESSION_SECRET:'synthetic-session',CATALOG_FEED_RETRY_DELAY_MS:'1',GITHUB_DISPATCH_TOKEN:secret,...options.env};
 let handler;const calls=[];
 globalThis.Deno={env:{get:k=>env[k]},serve:fn=>handler=fn};
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);calls.push({url:String(url),init});
  if(u.hostname==='api.github.com')return options.github?options.github(u,init):new Response(null,{status:204});
  if(u.pathname.endsWith('/le_catalog_publish_take'))return options.gate?options.gate():Response.json({allowed:true});
  if(u.pathname.endsWith('/le_catalog_login_attempt'))return Response.json({allowed:true});
  if(u.pathname.endsWith('/le_catalog_login_success'))return new Response(null,{status:204});
  if(u.pathname.includes('le_catalog_settings'))return Response.json([{payload:{adjustment_pct:0,discount_pct:0,types:[{id:'green',name:'Зелёная'}]},revision:1}]);
  if(u.pathname.includes('le_promo_codes')&&init.method==='POST')return Response.json([{id:'00000000-0000-4000-8000-000000000001',revision:1,...JSON.parse(init.body)}]);
  if(u.pathname.startsWith('/storage/'))return Response.json({}, {status:options.storageStatus||200});
  return Response.json([]);
 };
 let code=await fs.readFile(file,'utf8');
 code=code.replace("'../_shared/billing-store.mjs'",JSON.stringify(new URL('../../supabase/functions/_shared/billing-store.mjs',import.meta.url).href));
 await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(code)+'\n//'+Math.random()).toString('base64'));
 const request=(route,init={})=>handler(new Request(base+route,init));
 const login=await request('/api/login',{method:'POST',headers:{'X-Catalog-Request':'1','Content-Type':'application/json'},body:'{"password":"synthetic-admin"}'});
 assert.equal(login.status,200);const {token}=await login.json();
 const auth={Authorization:`Bearer ${token}`,'X-Catalog-Request':'1','Content-Type':'application/json'};
 return {calls,request,post:(headers=auth)=>request('/api/publish-site',{method:'POST',headers,body:'{}'}),status:()=>request('/api/publish-status',{headers:auth}),auth};
}
for(const file of paths){
 test(file+': authentication, CSRF, origin, accepted signal',async()=>{
  const fetchOriginal=fetch,denoOriginal=globalThis.Deno;
  try{const e=await load(file);
   assert.equal((await e.request('/api/publish-status')).status,401);
   assert.equal((await e.post({'X-Catalog-Request':'1'})).status,401);
   assert.equal((await e.post({Authorization:e.auth.Authorization})).status,403);
   assert.equal((await e.post({...e.auth,Origin:'https://evil.invalid'})).status,403);
   assert.equal(e.calls.filter(c=>c.url.includes('api.github.com')).length,0);
   const r=await e.post();assert.equal(r.status,202);assert.equal((await r.json()).accepted,true);
   const call=e.calls.find(c=>c.url.includes('api.github.com'));assert.ok(call.url.endsWith('/dispatches'));assert.deepEqual(JSON.parse(call.init.body),{event_type:'catalog_changed'});assert.equal(call.init.headers.Authorization,'Bearer '+secret);
   for(const c of e.calls.filter(c=>!c.url.includes('api.github.com')))assert.ok(!JSON.stringify(c).includes(secret));
  }finally{globalThis.fetch=fetchOriginal;globalThis.Deno=denoOriginal;}
 });
 test(file+': missing credential, DB errors, throttle and upstream errors do not leak',async()=>{
  const fetchOriginal=fetch,denoOriginal=globalThis.Deno,errorOriginal=console.error;const logs=[];console.error=(...args)=>logs.push(args.join(' '));
  try{
   let e=await load(file,{env:{GITHUB_DISPATCH_TOKEN:''}});assert.equal((await e.post()).status,503);assert.equal(e.calls.filter(c=>c.url.endsWith('le_catalog_publish_take')).length,0);
   for(const gate of [()=>{throw new Error(secret)},()=>Response.json({allowed:'yes'}),()=>Response.json({message:secret},{status:500})]){
    e=await load(file,{gate});const r=await e.post();assert.equal(r.status,503);assert.ok(!(await r.text()).includes(secret));assert.equal(e.calls.filter(c=>c.url.includes('api.github.com')).length,0);
   }
   e=await load(file,{gate:()=>Response.json({allowed:false,retry_after:37})});const limited=await e.post();assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'37');assert.match(limited.headers.get('Access-Control-Expose-Headers'),/Retry-After/);
   for(const github of [()=>Response.json({message:secret},{status:401}),()=>Response.json({message:secret},{status:403}),()=>Response.json({message:secret},{status:500}),()=>new Response(null,{status:200}),()=>{throw new Error(secret)}]){
    e=await load(file,{github});const r=await e.post();assert.equal(r.status,502);assert.ok(!(await r.text()).includes(secret));
   }
   assert.ok(!logs.join('\n').includes(secret));
  }finally{globalThis.fetch=fetchOriginal;globalThis.Deno=denoOriginal;console.error=errorOriginal;}
 });
 test(file+': public runs API, safe response, 25-second cache and cache invalidation',async()=>{
  const fetchOriginal=fetch,denoOriginal=globalThis.Deno,nowOriginal=Date.now;let now=nowOriginal();Date.now=()=>now;
  try{
   const e=await load(file,{github:(u,init)=>{
    if(init.method==='POST')return new Response(null,{status:204});
    assert.equal(init.headers.Authorization,undefined);
    return Response.json({workflow_runs:[{id:123,created_at:'2026-10-10T08:00:00Z',status:'completed',conclusion:'skipped',html_url:'https://evil.invalid/'+secret,extra:secret}]});
   }});
   let r=await e.status(),data=await r.json();assert.equal(data.lastRun.status,'success');assert.equal(data.lastRun.conclusion,'skipped');assert.equal(data.lastRun.url,'https://github.com/arturablyazov5-glitch/lady-elka-cloud-preview/actions/runs/123');assert.ok(!JSON.stringify(data).includes(secret));
   await e.status();assert.equal(e.calls.filter(c=>c.url.includes('/runs?')).length,1);
   now+=26000;await e.status();assert.equal(e.calls.filter(c=>c.url.includes('/runs?')).length,2);
   await e.post();await e.status();assert.equal(e.calls.filter(c=>c.url.includes('/runs?')).length,3);
  }finally{globalThis.fetch=fetchOriginal;globalThis.Deno=denoOriginal;Date.now=nowOriginal;}
 });
}
test('SQL admission: repeat migration, two Edge instances, concurrent attempts, reset and restricted roles',async()=>{
 const fetchOriginal=fetch,denoOriginal=globalThis.Deno,db=new PGlite();
 try{
  await db.exec('create role anon;create role authenticated;create role service_role;');
  const sql=await fs.readFile('supabase/migrations/20261010120000_catalog_publish_limit.sql','utf8');await db.exec(sql);await db.exec(sql);
  const gate=async()=>Response.json((await db.query('select public.le_catalog_publish_take() as r')).rows[0].r);
  const first=await load(paths[0],{gate}),second=await load(paths[0],{gate});
  const statuses=await Promise.all(Array.from({length:12},(_,i)=>(i%2?first:second).post()));
  assert.equal(statuses.filter(r=>r.status===202).length,1);assert.equal(statuses.filter(r=>r.status===429).length,11);
  assert.equal((await db.query('select attempts from le_catalog_publish_limit')).rows[0].attempts,1);
  await db.exec("update le_catalog_publish_limit set last_started_at=clock_timestamp()-interval '61 seconds'");assert.equal((await first.post()).status,202);
  for(const role of ['anon','authenticated']){
   for(const statement of ['select * from le_catalog_publish_limit','select le_catalog_publish_take()']){await assert.rejects(db.exec(`set role ${role};${statement}`));await db.exec('reset role');}
  }
  await db.exec('set role service_role');assert.equal((await db.query('select public.le_catalog_publish_take() as r')).rows[0].r.allowed,false);await db.exec('reset role');
 }finally{globalThis.fetch=fetchOriginal;globalThis.Deno=denoOriginal;await db.close();}
});
test('v8 contracts unchanged by isolated candidate: feeds, login, catalog, save and CORS',async()=>{
 const fetchOriginal=fetch,denoOriginal=globalThis.Deno;
 try{
  const snapshots=[];
  for(const file of ['agent-context/catalog-v8-backup/supabase/functions/catalog/index.ts',paths[1]]){
   const e=await load(file),out=[];
   for(const [route,method,body,auth] of [['/feeds/trees.csv','GET'],['/feeds/decor.csv','HEAD'],['/feeds/promos.csv','GET'],['/pub?gid=500105078','GET'],['/api/catalog','GET',null,true],['/api/catalog','GET'],['/api/catalog','OPTIONS'],['/api/login','POST','{"password":"wrong"}'],['/api/promos','POST','{"code":"QA","pct":10}',true]]){
    const r=await e.request(route,{method,headers:auth?e.auth:{Origin:'http://localhost:4180','X-Catalog-Request':'1','Content-Type':'application/json'},...(body?{body}:{})});
    out.push({route,status:r.status,body:await r.text(),type:r.headers.get('Content-Type'),cors:r.headers.get('Access-Control-Allow-Origin')});
   }snapshots.push(out);
  }assert.deepEqual(snapshots[1],snapshots[0]);
 }finally{globalThis.fetch=fetchOriginal;globalThis.Deno=denoOriginal;}
});

test('status handles empty runs, queued/in_progress/failure, malformed/upstream failures without credentials',async()=>{
 const fetchOriginal=fetch,denoOriginal=globalThis.Deno,errorOriginal=console.error;const logs=[];console.error=(...args)=>logs.push(args.join(' '));
 try{
  for(const file of paths){
   for(const [status,conclusion,expected] of [['queued',null,'queued'],['in_progress',null,'in_progress'],['completed','failure','failure'],['completed','cancelled','failure'],['completed','success','success']]){
    const e=await load(file,{github:()=>Response.json({workflow_runs:[{id:1,created_at:'2026-10-10T08:00:00Z',status,conclusion}]})});assert.equal((await (await e.status()).json()).lastRun.status,expected);
   }
   let e=await load(file,{github:()=>Response.json({workflow_runs:[]})});assert.equal((await (await e.status()).json()).lastRun,null);
   for(const github of [()=>Response.json({message:secret},{status:403}),()=>Response.json({workflow_runs:[{id:secret}]}),()=>{throw new Error(secret)}]){
    e=await load(file,{github});const r=await e.status();assert.equal(r.status,502);assert.ok(!(await r.text()).includes(secret));
   }
  }
  assert.ok(!logs.join(' ').includes(secret));
 }finally{globalThis.fetch=fetchOriginal;globalThis.Deno=denoOriginal;console.error=errorOriginal;}
});
test('v8 feed warning contract preserved by candidate when a saved write cannot upload feeds',async()=>{
 const fetchOriginal=fetch,denoOriginal=globalThis.Deno,errorOriginal=console.error;console.error=()=>{};
 try{
  const snapshots=[];
  for(const file of ['agent-context/catalog-v8-backup/supabase/functions/catalog/index.ts',paths[1]]){
   const e=await load(file,{storageStatus:500});const r=await e.request('/api/promos',{method:'POST',headers:e.auth,body:'{"code":"QA","pct":10}'});
   snapshots.push({status:r.status,body:await r.json(),warning:r.headers.get('X-Feed-Warning')});
   assert.equal(r.status,201);assert.match(decodeURIComponent(r.headers.get('X-Feed-Warning')),/Изменения сохранены/);
  }assert.deepEqual(snapshots[0],snapshots[1]);
 }finally{globalThis.fetch=fetchOriginal;globalThis.Deno=denoOriginal;console.error=errorOriginal;}
});
