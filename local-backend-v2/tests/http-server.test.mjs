import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createServer} from '../http-server.mjs';
async function fixture(t,gateway,options={}){
 const server=createServer({gateway,...options});
 await new Promise(r=>server.listen(0,r));
 assert.equal(server.address().address,'127.0.0.1');
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 return `http://127.0.0.1:${server.address().port}`;
}
const post=(url,body='{}',headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
test('fixed routes, opaque credentials and server deadline; no capability endpoint',async t=>{
 let input;
 const url=await fixture(t,async x=>{input=x;return {status:200,body:{ok:true},headers:{Authorization:x.credentials}};});
 for(const [path,route] of [['create','create'],['status','status'],['callback','callback'],['internal/poll','internal-poll'],['internal/retry','internal-retry']]){
  const before=Date.now();const r=await post(`${url}/v2/${path}`,'{"deadline":1,"credentials":"fake"}',{Authorization:'Bearer opaque-secret'});
  assert.equal(r.status,200);assert.equal(input.route,route);assert.equal(input.credentials,'Bearer opaque-secret');
  assert.ok(input.deadline>=before+4900);assert.ok(input.signal instanceof AbortSignal);
  assert.equal(input.request.headers.authorization,'Bearer opaque-secret');assert.equal(input.request.method,'POST');assert.equal(input.request.rawBody.toString(),'{"deadline":1,"credentials":"fake"}');
  assert.equal(r.headers.get('authorization'),null);assert.equal(await r.text(),'{"ok":true}');
 }
 assert.equal((await post(`${url}/v2/capabilities`)).status,404);
});
test('methods, exact route, JSON, media type and streamed byte limit reject before gateway',async t=>{
 let calls=0;const url=await fixture(t,async()=>{calls++;return {status:200,body:{}};},{maxBodyBytes:16});
 const method=await fetch(`${url}/v2/create`);assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'POST, OPTIONS');
 assert.equal((await post(`${url}/v2/create?route=status`)).status,404);
 for(const body of ['{','null','[]','"x"'])assert.equal((await post(`${url}/v2/create`,body)).status,400);
 assert.equal((await post(`${url}/v2/create`,'{}',{'Content-Type':'text/plain'})).status,415);
 assert.equal((await post(`${url}/v2/create`,'{"large":"abcdefghijk"}')).status,413);
 assert.equal(calls,0);
});
test('closed CORS and constrained preflight',async t=>{
 const url=await fixture(t,async()=>({status:200,body:{}}),{origins:['https://shop.example']});
 const denied=await post(`${url}/v2/create`,'{}',{Origin:'https://evil.example'});assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
 assert.equal((await post(`${url}/v2/create`)).headers.get('access-control-allow-origin'),null);
 const r=await fetch(`${url}/v2/create`,{method:'OPTIONS',headers:{Origin:'https://shop.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}});
 assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),'https://shop.example');
 assert.equal((await fetch(`${url}/v2/create`,{method:'OPTIONS',headers:{Origin:'https://shop.example','Access-Control-Request-Method':'DELETE'}})).status,403);
});
test('429 and Retry-After survive; thrown secrets are suppressed',async t=>{
 const url=await fixture(t,async({route})=>{if(route==='create')return {status:429,headers:{'Retry-After':'23','Set-Cookie':'secret'},body:{error:'RATE_LIMITED'}};throw Error('Bearer secret SQL password');});
 const r=await post(`${url}/v2/create`);assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'23');assert.equal(r.headers.get('set-cookie'),null);assert.deepEqual(await r.json(),{error:'RATE_LIMITED'});
 const fail=await post(`${url}/v2/status`);assert.equal(fail.status,503);assert.equal(await fail.text(),'{"error":"BACKEND_UNAVAILABLE"}');
});
test('noncooperative gateway times out and receives cancellation',async t=>{
 let signal;const url=await fixture(t,async x=>{signal=x.signal;return new Promise(()=>{});},{timeoutMs:80});
 const r=await post(`${url}/v2/create`);assert.equal(r.status,504);assert.equal(signal.aborted,true);
});
test('disconnect during gateway aborts its signal',async t=>{
 let started;const ready=new Promise(r=>{started=r;});let aborted;const cancelled=new Promise(r=>{aborted=r;});
 const url=await fixture(t,async({signal})=>{signal.addEventListener('abort',aborted,{once:true});started();return new Promise(()=>{});});
 const req=http.request(`${url}/v2/create`,{method:'POST',headers:{'Content-Type':'application/json'}});req.on('error',()=>{});req.end('{}');
 await ready;req.destroy();await Promise.race([cancelled,new Promise((_,reject)=>setTimeout(()=>reject(Error('not aborted')),500))]);
});
test('incomplete body is bounded by server deadline',async t=>{
 const url=await fixture(t,async()=>{throw Error('must not run');},{timeoutMs:80});
 const status=await new Promise((resolve,reject)=>{const req=http.request(`${url}/v2/create`,{method:'POST',headers:{'Content-Type':'application/json'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);req.write('{');});
 assert.equal(status,504);
});
