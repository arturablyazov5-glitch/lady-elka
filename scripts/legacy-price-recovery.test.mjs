import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPriceCSV} from '../src/catalog/price-recovery.js';
const csv='title,price,category,height_cm\nTest,100,Classic,180';
const ok=()=>({ok:true,text:async()=>csv});
for(const mode of ['HTTP503','network','hang','schema']) test(`${mode} then recovery`,async()=>{
 let calls=0;
 const result=await fetchPriceCSV('https://public.invalid','default',{timeoutMs:10,delayMs:1,fetchImpl:async()=>{
 if(++calls===1){if(mode==='HTTP503')return {ok:false,status:503};if(mode==='network')throw Error('offline');if(mode==='hang')return new Promise(()=>{});return {ok:true,text:async()=>'<html>Error</html>'};}return ok();}});
 assert.equal(result,csv);assert.equal(calls,2);
});
test('bounded terminal failure',async()=>{let calls=0;await assert.rejects(fetchPriceCSV('x','default',{timeoutMs:5,delayMs:1,fetchImpl:()=>{calls++;return new Promise(()=>{});}}),/timeout/);assert.equal(calls,3);});
test('independent feeds',async()=>{const results=await Promise.allSettled([fetchPriceCSV('tree','default',{delayMs:0,fetchImpl:async()=>{throw Error('offline');}}),fetchPriceCSV('decor','default',{fetchImpl:async()=>ok()})]);assert.equal(results[0].status,'rejected');assert.equal(results[1].value,csv);});
