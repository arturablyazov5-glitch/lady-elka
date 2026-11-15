import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateCSV,checksum,readCandidate,accept,fetchPublic,zone} from '../import.mjs';
const trees='id,title,category,height_cm,price,diameter_cm,branches,offer,discount_pct,photos,active,description\n1,Tree,Green,180,100,90,100,150,-30,,TRUE,Description\n1,Tree,Green,210,0,100,200,0,-30,,FALSE,Description\n';
const decor='id,title,category,price,variants,photos,active,description\n1d,Basket,Decor,100,Large,,TRUE,Description\n';
const promos='promocode,Комментарий,ruble-offer,percent-offer,gift-offer\n';
const texts={trees,decor,promos};
const inputs=()=>Object.fromEntries(Object.entries(texts).map(([k,text])=>[k,{text,source:'synthetic-local-test',receivedAt:'2026-10-03T00:00:00Z'}]));
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'catalog-import-'));try{const manifest={schemaVersion:1,productionReady:false,feeds:{}};for(const [name,text] of Object.entries(texts)){await writeFile(join(root,`${name}.csv`),text);manifest.feeds[name]={path:`${name}.csv`,status:name==='promos'?'empty':'available',records:name==='trees'?2:name==='decor'?1:0,sha256:checksum(text),source:'synthetic-local-test',receivedAt:'2026-10-03T00:00:00Z'};}await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));await fn(root,manifest);}finally{await rm(root,{recursive:true,force:true});}}
test('retains inactive rows, real empty promo accepted, shared storefront refinement',()=>{assert.equal(validateCSV('trees',trees).length,2);assert.equal(validateCSV('promos',promos).length,0);assert.equal(validateCSV('trees',trees.replace(',100,90,',',19.99,90,')).length,2);});
test('rejects malformed, missing columns and feeds',()=>{for(const text of [trees.replace('height_cm','bad'),trees.replace('Description\n','Description,extra\n'),'id,title\n1,"unterminated',trees.replace('Tree','"Tree"junk')])assert.throws(()=>validateCSV('trees',text));assert.throws(()=>validateCSV('promos',null));});
test('duplicate variant including inactive and incompatible product names',()=>{assert.throws(()=>validateCSV('trees',trees+trees.split('\n')[1]+'\n'));assert.throws(()=>validateCSV('trees',trees.replace('1,Tree,Green,210','1,Other,Green,210')));});
test('invalid money/active/traversal fails',()=>{for(const value of ['NaN','Infinity','-1','1e9','1.001'])assert.throws(()=>validateCSV('trees',trees.replace(',100,90,',`,${value},90,`)));assert.throws(()=>validateCSV('trees',trees.replace(',TRUE,',',maybe,')));assert.throws(()=>validateCSV('trees',trees.replace(',,TRUE,',',/d/%2e%2e/x,TRUE,')));});
test('promo range, duplicates, no benefit and unsupported gifts fail',()=>{for(const row of ['CODE,,0,100,','CODE,,1,2,','CODE,,0,0,','CODE,,0,0,Car'])assert.throws(()=>validateCSV('promos',promos+row+'\n'));assert.throws(()=>validateCSV('promos',promos+'Code,,100,0,\ncode,,100,0,\n'));});
test('checksum, record counts, missing feed, traversal, unavailable differ from empty',async()=>{await fixture(async(root,m)=>{await readCandidate(join(root,'manifest.json'));for(const patch of [{sha256:'bad'},{records:5},{path:'../outside.csv'},{status:'unavailable'}]){const copy=structuredClone(m);Object.assign(copy.feeds.promos,patch);await writeFile(join(root,'manifest.json'),JSON.stringify(copy));await assert.rejects(readCandidate(join(root,'manifest.json')));}delete m.feeds.decor;await writeFile(join(root,'manifest.json'),JSON.stringify(m));await assert.rejects(readCandidate(join(root,'manifest.json')));});});
test('bounded public GET, no redirects, unavailable response and oversized fail',async()=>{let options;const fake=async(url,opt)=>{options=opt;return new Response(trees,{headers:{'content-type':'text/csv'}});};await fetchPublic('trees',{fetchImpl:fake});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);await assert.rejects(fetchPublic('trees',{fetchImpl:fake,maxBytes:10}));await assert.rejects(fetchPublic('trees',{fetchImpl:async()=>new Response('missing',{status:404})}));});
test('local candidate only; cannot overwrite existing or active artifact',async()=>{const output=await mkdtemp(join(zone,'test-output-'));try{await writeFile(join(output,'marker'),'preserve');await assert.rejects(accept(inputs(),{output}));assert.equal(await readFile(join(output,'marker'),'utf8'),'preserve');await assert.rejects(accept(inputs(),{output:join(tmpdir(),'outside-candidate')}));const next=join(output,'candidate');await accept(inputs(),{output:next});const candidate=await readCandidate(join(next,'manifest.json'));assert.equal(candidate.manifest.productionReady,false);assert.equal(candidate.manifest.freshness,'unknown');assert.equal(candidate.manifest.feeds.trees.records,2);assert.equal(candidate.manifest.feeds.promos.status,'empty');}finally{await rm(output,{recursive:true,force:true});}});
test('temporary read failures retry once; persistent failures stop after two attempts',async()=>{
  for(const failure of [()=>{throw new DOMException('slow','TimeoutError');},()=>{throw new TypeError('fetch failed');},()=>new Response('unavailable',{status:503})]) {
    let calls=0,delays=[];
    const result=await fetchPublic('trees',{sleep:async ms=>delays.push(ms),fetchImpl:async()=>++calls===1?failure():new Response(trees,{headers:{'content-type':'text/csv'}})});
    assert.equal(result.text,trees);assert.equal(calls,2);assert.deepEqual(delays,[5000]);
    calls=0;
    await assert.rejects(fetchPublic('trees',{sleep:async()=>{},fetchImpl:async()=>{calls++;return failure();}}));
    assert.equal(calls,2);
  }
});
test('invalid CSV and permanent HTTP errors are never retried',async()=>{
  for(const response of [()=>new Response('missing',{status:404}),()=>new Response('invalid',{headers:{'content-type':'text/csv'}})]) {
    let calls=0;
    await assert.rejects(fetchPublic('trees',{sleep:async()=>assert.fail('unexpected retry'),fetchImpl:async()=>{calls++;return response();}}));
    assert.equal(calls,1);
  }
});
