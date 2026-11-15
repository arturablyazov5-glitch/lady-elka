import test from 'node:test';
import assert from 'node:assert/strict';
import {workerSignature,authenticateWorker} from './worker-auth.mjs';
test('worker signatures bind action/time/nonce and cannot be replayed or forged',async()=>{
 const secret='synthetic-worker-secret'.padEnd(64,'x'),time='1791860000',nonce=crypto.randomUUID();let claims=0;const used=new Set();
 const dependencies={secret,now:()=>Number(time)*1000,claim:async key=>{claims++;if(used.has(key))return false;used.add(key);return true;}};
 const signature=await workerSignature(secret,'poll-payments',time,nonce);
 const request=(action='poll-payments',changes={})=>new Request('https://example.test/pay-v2?action='+action,{method:'POST',headers:{'x-worker-time':time,'x-worker-nonce':nonce,'x-worker-signature':signature,...changes}});
 assert.equal(await authenticateWorker(request(),dependencies),0);
 assert.equal(await authenticateWorker(request(),dependencies),409);
 assert.equal(await authenticateWorker(request('retry-cod-delivery'),dependencies),401);
 assert.equal(await authenticateWorker(request('poll-payments',{'x-worker-signature':'0'.repeat(64)}),dependencies),401);
 assert.equal(await authenticateWorker(request(),{...dependencies,now:()=>Number(time)*1000+121000}),401);
 assert.equal(claims,2,'unauthorized requests never access nonce database');
 assert.equal(await authenticateWorker(request(),{...dependencies,claim:async()=>{throw Error('store outage');}}),503);
});
