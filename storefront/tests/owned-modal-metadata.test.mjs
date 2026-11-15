import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isolatedWorkspace} from '../../scripts/offline-suite-isolated-workspace.mjs';
const run=promisify(execFile);
test('source metadata is removed and modal targets fail closed after copied-cart assembly',async()=>{
 const root=resolve(import.meta.dirname,'../..');
 for(const name of await readdir(join(root,'storefront/public'),{recursive:true})){
  if(!name.endsWith('.html'))continue;
  const html=await readFile(join(root,'storefront/public',name),'utf8');
  assert.doesNotMatch(html,/data-action-element|data-field-position|data-do-mask|data-agree\b|data-s3-anketa-id|data-captcha|data-sitekey|data-hide-shield|data-invisible|data-url=|data-name=|data-lang=/,name);
  for(const match of html.matchAll(/data-type-field=['"]([^'"]*)['"]/g))assert.equal(match[1],'input_hidden');
 }
 const workspace=await isolatedWorkspace(root);
 try{
  const args=['--import','data:text/javascript,globalThis.fetch=()=>{throw new Error("Offline")}', 'storefront/build.mjs','--mode=preview'];
  await run(process.execPath,args,{cwd:workspace.directory});
  const source=join(workspace.directory,'storefront/public/index.html');
  const original=await readFile(source,'utf8');
  assert.match(original,/data-modal-open=/);
  await writeFile(source,original.replace(/data-modal-open="[^"]+"/,'data-modal-open="missing-target"'));
  await assert.rejects(run(process.execPath,args,{cwd:workspace.directory}),/Modal template: expected one valid target/);
  await writeFile(source,original.replace(/data-modal-open="[^"]+"/,m=>m+' data-modal-close="missing-target"'));
  await assert.rejects(run(process.execPath,args,{cwd:workspace.directory}),/Modal template: expected one valid target/);
 }finally{await workspace.cleanup();}
});
