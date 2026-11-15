import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const schema=await readFile(new URL('../schema-draft.sql',import.meta.url),'utf8');
const roles=await readFile(new URL('../roles-draft.sql',import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite(); await db.exec(schema);
 await db.exec(`CREATE TABLE public.payment_orders(marker text); CREATE TABLE public.le_orders(marker text);
 CREATE TABLE public.catalog(marker text); CREATE TABLE public.blog(marker text);
 INSERT INTO public.payment_orders VALUES('legacy'); INSERT INTO public.le_orders VALUES('legacy');
 INSERT INTO le_checkout_v2.budgets(key,capacity,window_ms,owner_capacity) VALUES
 ('create',100,60000,100),('ownerRequest',100,60000,100),('replay',100,60000,100),('status',100,60000,100),('bank',100,60000,100),('telegram',100,60000,100);`);
 await db.exec(roles);
 await db.exec("UPDATE le_checkout_v2.gateway_policy SET create_open=true");
 await db.exec("INSERT INTO le_checkout_v2.capabilities VALUES('alice-cap','alice',9999999999999,true,true),('bob-cap','bob',9999999999999,false,true),('expired','alice',0,true,true)");
 return db;
}
async function as(db,role,fn){await db.exec('SET ROLE '+role);try{return await fn();}finally{await db.exec('RESET ROLE');}}
const createSql="SELECT * FROM le_checkout_v2.api_create($1,'own','fingerprint','LE2aaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,'card','[\"synthetic\"]'::jsonb)";
test('SET ROLE denies all direct tables, legacy writes/reads, private RPC and role attributes',async()=>{
 const db=await fixture();try{
 for(const role of ['le_v2_create','le_v2_status','le_v2_callback','le_v2_internal']){
 await as(db,role,async()=>{
 assert.equal((await db.query('SELECT current_user')).rows[0].current_user,role);
 for(const table of ['public.payment_orders','public.le_orders','public.catalog','public.blog','le_checkout_v2.orders','le_checkout_v2.effects','le_checkout_v2.capabilities','le_checkout_v2.budgets']){
 for(const sql of ['SELECT * FROM '+table,'DELETE FROM '+table,"INSERT INTO "+table+" DEFAULT VALUES"])
 await assert.rejects(db.exec(sql),e=>e.code==='42501');
 }
 await assert.rejects(db.exec("UPDATE le_checkout_v2.effects SET state='failed'"),e=>e.code==='42501');
 await assert.rejects(db.exec("SELECT le_checkout_v2.consume_window('bank','alice')"),e=>e.code==='42501');
 await assert.rejects(db.exec("CREATE TABLE le_checkout_v2.evil(i int)"),e=>e.code==='42501');
 // SET ROLE from the PGlite superuser session can escalate: session_user remains
 // postgres. Membership/non-superuser connection behavior is checked in ACLs,
 // not falsely claimed by attempting SET ROLE on that session.
 });
 }
 const rows=(await db.query("SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname LIKE 'le_v2_%'")).rows;
 assert(rows.every(r=>!r.rolsuper&&!r.rolbypassrls&&!r.rolcanlogin));
 assert.equal((await db.query("SELECT count(*)::int n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname LIKE 'le_v2_%'")).rows[0].n,0);
 }finally{await db.close();}
});
test('capability ownership, scope, expiry; status projection and RPC role separation',async()=>{
 const db=await fixture();try{
 await as(db,'le_v2_create',async()=>{
 for(const cap of ['alice','bob-cap','expired','missing']) await assert.rejects(db.query(createSql,[cap]),/UNAUTHORIZED/);
 assert.deepEqual((await db.query(createSql,['alice-cap'])).rows,[{id:'own',status:'received'}]);
 await assert.rejects(db.query("SELECT * FROM le_checkout_v2.api_status('alice-cap','own')"),e=>e.code==='42501');
 await assert.rejects(db.query("SELECT le_checkout_v2.api_internal('get','{}')"),e=>e.code==='42501');
 });
 await as(db,'le_v2_status',async()=>{
 assert.deepEqual((await db.query("SELECT * FROM le_checkout_v2.api_status('bob-cap','own')")).rows,[]);
 assert.deepEqual((await db.query("SELECT * FROM le_checkout_v2.api_status('bob-cap','absent')")).rows,[]);
 assert.deepEqual((await db.query("SELECT * FROM le_checkout_v2.api_status('alice-cap','own')")).rows,[{id:'own',status:'received',payment_url:null}]);
 await assert.rejects(db.query(createSql,['alice-cap']),e=>e.code==='42501');
 await assert.rejects(db.query("SELECT * FROM le_checkout_v2.api_callback_lookup('p')"),e=>e.code==='42501');
 });
 await as(db,'le_v2_internal',async()=>{
 assert.equal((await db.query("SELECT le_checkout_v2.api_internal('claim',$1::jsonb) ok",[JSON.stringify({key:'v2:bank:own',id:'own',kind:'bank'})])).rows[0].ok,true);
 await db.query("SELECT le_checkout_v2.api_internal('bind',$1::jsonb)",[JSON.stringify({id:'own',paymentId:'p',paymentURL:'https://synthetic.invalid'})]);
 });
 await as(db,'le_v2_callback',async()=>{
 assert.equal((await db.query("SELECT * FROM le_checkout_v2.api_callback_lookup('foreign')")).rows.length,0);
 assert.equal((await db.query("SELECT * FROM le_checkout_v2.api_callback_lookup('p')")).rows.length,1);
 assert.equal((await db.query("SELECT le_checkout_v2.api_callback_recover('own','foreign','LE2aaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,'{}') ok")).rows[0].ok,false);
 assert.equal((await db.query("SELECT le_checkout_v2.api_callback_recover('own','p','LE2aaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,'{}') ok")).rows[0].ok,true);
 await assert.rejects(db.query("SELECT le_checkout_v2.api_internal('finish','{}')"),e=>e.code==='42501');
 });
 await as(db,'le_v2_internal',async()=>{
 await db.query("SELECT le_checkout_v2.api_internal('status',$1::jsonb)",[JSON.stringify({id:'own',status:'pending_review'})]);
 assert.equal((await db.query("SELECT le_checkout_v2.api_internal('get','{\"id\":\"own\"}') o")).rows[0].o.status,'paid');
 await assert.rejects(db.query("SELECT le_checkout_v2.api_internal('status','{\"id\":\"own\",\"status\":\"paid\"}')"),/INVALID_STATUS/);
 });
 assert.equal((await db.query('SELECT marker FROM public.payment_orders')).rows[0].marker,'legacy');
 const funcs=(await db.query("SELECT p.proname,p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='le_checkout_v2'")).rows;
 assert(funcs.every(f=>f.rolname==='le_v2_owner'&&f.proconfig.includes('search_path=pg_catalog')));
 assert(funcs.filter(f=>f.proname.startsWith('api_')).every(f=>f.prosecdef));
 }finally{await db.close();}
});

test('non-superuser session cannot assume owner or other route role',async()=>{
 const db=await fixture();try{
 await db.exec('SET SESSION AUTHORIZATION le_v2_status');
 assert.equal((await db.query('SELECT session_user')).rows[0].session_user,'le_v2_status');
 for(const role of ['le_v2_owner','le_v2_create','le_v2_internal','le_v2_callback'])
 await assert.rejects(db.exec('SET ROLE '+role),e=>e.code==='42501');
 await assert.rejects(db.exec('ALTER ROLE le_v2_status SUPERUSER'),e=>e.code==='42501');
 }finally{await db.exec('RESET SESSION AUTHORIZATION');await db.close();}
});
test('closed SQL create policy permits owned exact replay, rejects new reservation',async()=>{
 const db=await fixture();try{
 await as(db,'le_v2_create',()=>db.query(createSql,['alice-cap']));
 await db.exec('UPDATE le_checkout_v2.gateway_policy SET create_open=false');
 await as(db,'le_v2_create',async()=>{
 assert.equal((await db.query(createSql,['alice-cap'])).rows[0].id,'own');
 await assert.rejects(db.query(createSql.replace("'own'","'new'"),['alice-cap']),/CREATE_CLOSED/);
 });
 }finally{await db.close();}
});
