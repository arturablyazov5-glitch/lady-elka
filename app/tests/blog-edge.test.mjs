import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createHmac,webcrypto} from 'node:crypto';
test('blog edge validates existing HMAC session protocol, closed writes and public status filter',async()=>{
 const originalFetch=globalThis.fetch,originalDeno=globalThis.Deno;let handler,calls=[];
 const values={SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',CATALOG_SESSION_SECRET:'synthetic-session',CATALOG_ALLOWED_ORIGINS:'http://localhost:4180'};
 globalThis.Deno={env:{get:k=>values[k]},serve:fn=>handler=fn};
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json(options?.method==='POST'?[{id:'00000000-0000-4000-8000-000000000000',payload:JSON.parse(options.body).payload,revision:1}]:[]);};
 try{
  let code=await fs.readFile(new URL('../server/blog-edge/index.ts',import.meta.url),'utf8');code=code.replace("'../../public/js/blog-model.js'",JSON.stringify(new URL('../public/js/blog-model.js',import.meta.url).href));
  await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(code)).toString('base64'));
  const payload=Buffer.from(JSON.stringify({exp:Date.now()+60000,nonce:'qa'})).toString('base64url'),signature=createHmac('sha256',values.CATALOG_SESSION_SECRET).update(payload).digest('base64url');
  const base='https://offline.invalid/functions/v1/le-admin-blog',headers={Authorization:`Bearer ${payload}.${signature}`,Origin:'http://localhost:4180','Content-Type':'application/json','X-Catalog-Request':'1'};
  assert.equal((await handler(new Request(base+'/posts'))).status,401);
  assert.equal((await handler(new Request(base+'/posts',{headers:{...headers,Authorization:'Bearer invalid'}}))).status,401);
  assert.equal((await handler(new Request(base+'/posts',{headers:{...headers,Origin:'https://evil.invalid'}}))).status,403);
  assert.equal((await handler(new Request(base+'/posts',{method:'POST',headers:{Authorization:headers.Authorization},body:'{}'}))).status,403);
  const post={title:'QA',slug:'qa-test',excerpt:'a',text:'<script>bad</script>',cover:'',alt:'',seoTitle:'',seoDescription:'',status:'draft'};
  const response=await handler(new Request(base+'/posts',{method:'POST',headers,body:JSON.stringify(post)}));assert.equal(response.status,201);assert.equal((await response.json()).text,post.text);
  const unsafe=await handler(new Request(base+'/posts',{method:'POST',headers,body:JSON.stringify({...post,contentFormat:'le-richtext-v1',content:{version:1,blocks:[{type:'paragraph',runs:[{text:'bad',href:'javascript:alert(1)'}]}]}})}));assert.equal(unsafe.status,400);
  const publicResponse=await handler(new Request(base+'/published'));assert.equal(publicResponse.status,200);assert.match(calls.at(-1).url,/status=eq.published/);
  assert.ok(calls.every(c=>c.url.includes('/rest/v1/le_blog_posts')));
 }finally{globalThis.fetch=originalFetch;globalThis.Deno=originalDeno;}
});
