import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {ownerBuildStatus} from '../products/owner-confirmation.mjs';
import {validatePreviewInput} from '../products/build-feed.mjs';
const root=resolve(import.meta.dirname,'../..'),candidate=join(root,'storefront/catalog-import/candidates/2026-10-04-owner-confirmed');
const read=async path=>JSON.parse(await readFile(path));
async function startPreview(output) {
 const child=spawn(process.execPath,['storefront/server.mjs','--mode=preview',`--root=${output}`],{cwd:root,env:{...process.env,STOREFRONT_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='',stdout='';child.stderr.on('data',chunk=>stderr+=chunk);
 const closed=new Promise(resolve=>child.once('close',resolve));
 try {
 const origin=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error('Startup timeout'));},10000);
  child.stdout.on('data',chunk=>{stdout+=chunk;const match=stdout.match(/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr));});child.once('error',error=>{clearTimeout(timer);reject(error);});
 });
 return {origin,stop:async()=>{child.kill();await closed;}};
 }catch(error){child.kill();await closed;throw error;}
}
test('owner metadata validates complete confirmation and preserves fetch provenance',async()=>{
 const m=await read(join(candidate,'manifest.json')),p=await read(join(candidate,'provenance.json'));
 const status=ownerBuildStatus(m,p);assert.equal(status.ownerAccepted,true);assert.match(status.notice,/2026-10-04/);assert.match(status.notice,/Готовность оплаты/);
 const preview=await validatePreviewInput(join(candidate,'manifest.json'),join(candidate,'media-manifest.json'));
 assert.equal(preview.ownerStatus.ownerAccepted,true);assert.match(preview.ownerProvenanceSha256,/^[a-f0-9]{64}$/);assert.equal(preview.manifest.dataAsOf,null);
});
test('old candidate remains unaccepted; partial and invalid confirmations fail closed',async()=>{
 const old=await read(join(root,'storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json'));
 assert.equal(ownerBuildStatus(old).ownerAccepted,false);
 const m=await read(join(candidate,'manifest.json')),p=await read(join(candidate,'provenance.json'));
 for(const mutate of [x=>delete x.ownerConfirmation,x=>x.ownerAccepted=false,x=>x.ownerConfirmation.date='2026-02-30',x=>x.ownerConfirmation.scope=['prices'],x=>x.ownerConfirmation.source='',x=>x.dataAsOf=x.feeds.trees.receivedAt,x=>x.productionReady=true,x=>x.feeds.trees.receivedAt='2026-10-03T12:00:00Z']){
  const bad=structuredClone(m);mutate(bad);assert.throws(()=>ownerBuildStatus(bad,p),/Invalid local owner/);
 }
 assert.throws(()=>ownerBuildStatus(m),/Invalid local owner/);
 const bad=structuredClone(p);bad.feeds.trees.sha256='0'.repeat(64);assert.throws(()=>ownerBuildStatus(m,bad),/Invalid local owner/);
});
test('fresh isolated build reproduces accepted metadata without output patching',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'le-owner-status-test-'));
 try{
 const {stdout}=await promisify(execFile)(process.execPath,['storefront/build.mjs','--mode=preview',`--input-manifest=${candidate}/manifest.json`,`--media-manifest=${candidate}/media-manifest.json`,`--output=${parent}/preview`],{cwd:root});
 const build=await read(join(parent,'preview/build-manifest.json'));
 assert.equal(build.candidatePreview.ownerAccepted,true);assert.equal(build.productionReady,false);assert.equal(build.snapshot.dataAsOf,null);
 assert.equal(build.candidatePreview.ownerConfirmation.date,'2026-10-04');assert.match(stdout,/Каталог принят владельцем/);assert.ok(!stdout.includes('current prices UNVERIFIED'));
 assert.equal(build.snapshot.feeds.trees.receivedAt,'2026-10-04T12:07:16.552Z');assert.ok(!build.acceptanceAnnotation);
 const server=await startPreview(join(parent,'preview'));
 try {
  assert.equal((await fetch(server.origin+'/tree/darina')).status,200);
  assert.equal((await fetch(server.origin+'/__offline/catalog/trees.csv')).status,200);
  assert.equal((await fetch(server.origin+'/v2/create',{method:'POST'})).status,405);
 } finally {await server.stop();}
 const buildPath=join(parent,'preview/build-manifest.json');
 for(const mutate of [m=>m.candidatePreview.ownerConfirmation.accepted=false,m=>m.candidatePreview.ownerConfirmation.source='',m=>m.candidatePreview.ownerConfirmation.date='2026-02-30',m=>m.candidatePreview.ownerConfirmation.scope=['prices'],m=>delete m.candidatePreview.ownerProvenance,m=>m.candidatePreview.ownerAccepted=false]) {
  const bad=structuredClone(build);mutate(bad);await writeFile(buildPath,JSON.stringify(bad));
  await assert.rejects(startPreview(join(parent,'preview')),/owner confirmation|Owner confirmation/i);
 }
 await writeFile(buildPath,JSON.stringify(build));
 const proof=join(parent,'preview/__offline/catalog/owner-provenance.json');
 await writeFile(proof,'{}');await assert.rejects(startPreview(join(parent,'preview')),/checksum mismatch/i);

 }finally{await rm(parent,{recursive:true,force:true});}
});
