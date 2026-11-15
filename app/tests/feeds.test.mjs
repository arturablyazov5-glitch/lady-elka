import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DEFAULT_SETTINGS} from '../public/js/pricing.js';
// Offline: the cabinet server talks only to a local mock of PostgREST + Storage.
const root=fileURLToPath(new URL('../../',import.meta.url));
const product={id:'trees:QA-FEED',kind:'trees',sku:'QA-FEED',title:'QA',variants:[{key:'k1',category:'Зелёная',type_id:'green',height_cm:150,base_price:1000,price:1000,diameter_cm:0,branches:0,offer:0,discount_pct:0,description:'',photos:[],active:false,variants:'',source_price:0}]};
async function withServer(storageStatus,fn){
 const state={revision:1,uploads:[]};
 const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  const json=(s,d)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(d));};
  if(req.url.startsWith('/storage/')){state.uploads.push(req.url);res.writeHead(storageStatus);return res.end('{}');}
  if(req.url.startsWith('/rest/v1/le_catalog_settings'))return json(200,[{payload:DEFAULT_SETTINGS,revision:1,updated_at:'x'}]);
  if(req.url.startsWith('/rest/v1/le_promo_codes'))return json(200,[]);
  if(req.url.startsWith('/rest/v1/le_catalog_products')&&req.method==='PATCH'){state.revision++;return json(200,[{payload:JSON.parse(raw).payload,revision:state.revision,updated_at:'y'}]);}
  if(req.url.startsWith('/rest/v1/le_catalog_products'))return json(200,[{payload:product,revision:state.revision,updated_at:'x'}]);
  json(404,{});
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const port=String(40000+Math.floor(Math.random()*20000));
 const server=spawn(process.execPath,['app/server/index.mjs'],{cwd:root,env:{...process.env,PORT:port,HOST:'127.0.0.1',CATALOG_ADMIN_PASSWORD:'',PUBLIC_ORIGIN:'',SUPABASE_URL:`http://127.0.0.1:${mock.address().port}`,SUPABASE_PROJECT_REF:'offline',SUPABASE_SERVICE_ROLE_KEY:'offline'},stdio:'ignore'});
 try{
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){try{if((await fetch(base+'/app')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  await fn(base,state);
 }finally{server.kill();mock.close();}
}
const put=base=>fetch(`${base}/api/products/${encodeURIComponent(product.id)}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Catalog-Request':'1'},body:JSON.stringify({...product,revision:1})});
test('feed upload failure after a committed save returns success with a warning instead of an error',async()=>{
 await withServer(500,async(base,state)=>{
  const res=await put(base),body=await res.json();
  assert.equal(res.status,200);assert.equal(body.revision,2);assert.equal(state.revision,2);
  assert.match(decodeURIComponent(res.headers.get('x-feed-warning')),/файлы для сайта не обновились/);
  assert.ok(state.uploads.length>=3,'publish was retried');
 });
});
test('successful save publishes all three feeds without a warning',async()=>{
 await withServer(200,async(base,state)=>{
  const res=await put(base);
  assert.equal(res.status,200);assert.equal(res.headers.get('x-feed-warning'),null);
  assert.deepEqual(state.uploads.map(u=>u.split('/').pop()).sort(),['decor.csv','promos.csv','trees.csv']);
 });
});
