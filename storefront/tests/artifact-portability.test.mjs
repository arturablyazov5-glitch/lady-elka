import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../server.mjs', import.meta.url));

test('copied artifact starts with source inputs and network forbidden; rejects damaged files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'le-portability-'));
  const original = join(temp, 'original'), copy = join(temp, 'relocated', 'artifact');
  let child;
  try {
    const build = spawnSync(process.execPath, [fileURLToPath(new URL('../build.mjs', import.meta.url)), '--mode=preview',
      '--input-manifest=' + fileURLToPath(new URL('../catalog-import/candidates/2026-10-03-public-feed/manifest.json', import.meta.url)),
      '--media-manifest=' + fileURLToPath(new URL('../catalog-media/2026-10-03-public-feed/manifest.json', import.meta.url)),
      '--output=' + original], {encoding:'utf8'});
    assert.equal(build.status, 0, build.stderr);
    await cp(original, copy, {recursive:true});
    await rm(original, {recursive:true});
    const guard = join(temp, 'deny-inputs.cjs');
    await writeFile(guard, `const fs=require('node:fs'), fsp=require('node:fs/promises');
const deny = path => { if (/catalog-import|catalog-media/.test(String(path))) throw new Error('SOURCE INPUT ACCESS FORBIDDEN'); };
for (const api of [fs,fsp]) for (const key of ['readFile','realpath','stat','open','access','readdir']) {const original=api[key];api[key]=function(path,...args){deny(path);return original.call(this,path,...args)};}
require('node:module').syncBuiltinESMExports();
global.fetch=()=>{throw new Error('NETWORK FORBIDDEN')};
for (const name of ['node:http','node:https']) {const api=require(name);api.request=api.get=()=>{throw new Error('NETWORK FORBIDDEN')};}
require('node:module').syncBuiltinESMExports();`);
    const env = {...process.env, NODE_OPTIONS: '--require=' + guard, STOREFRONT_PORT:'0'};
    child = spawn(process.execPath, [script,'--mode=preview','--root='+copy], {env,stdio:['ignore','pipe','pipe']});
    const origin = await new Promise((resolve,reject)=> {let text='',error='';child.stderr.on('data',b=>error+=b);child.stdout.on('data',b=>{text+=b;const m=text.match(/localhost:(\d+)/);if(m)resolve('http://127.0.0.1:'+m[1]);});child.once('exit',()=>reject(new Error(error)));child.once('error',reject);});
    for (const path of ['/tree/darina','/tree/miranda','/__offline/catalog/trees.csv']) assert.equal((await fetch(origin+path)).status,200);
    const manifest = JSON.parse(await readFile(join(copy,'build-manifest.json')));
    const image = manifest.bundled.assets.find(a=>a.path.startsWith('media/catalog-pinned/'));
    const file = join(copy,image.path), bytes = await readFile(file);
    assert.equal((await fetch(origin+'/'+image.path)).status,200);
    await writeFile(file,'tampered');
    assert.equal((await fetch(origin+'/'+image.path)).status,500);
    const manifestFileDuringRun=join(copy,'build-manifest.json'), manifestBytes=await readFile(manifestFileDuringRun);
    await writeFile(manifestFileDuringRun, 'changed');assert.equal((await fetch(origin+'/tree/darina')).status,503);
    await rm(manifestFileDuringRun);assert.equal((await fetch(origin+'/tree/darina')).status,503);
    await writeFile(manifestFileDuringRun, manifestBytes);
    const done=once(child,'exit');child.kill();await done;child=null;
    const reject = pattern => {const result=spawnSync(process.execPath,[script,'--mode=preview','--root='+copy],{env,encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,pattern);};
    reject(/checksum mismatch/);
    await rm(file);reject(/ENOENT/);
    const outside=join(temp,'outside');await writeFile(outside,bytes);await symlink(outside,file);reject(/escapes/);
    await rm(file);await writeFile(file,bytes);
    const manifestFile=join(copy,'build-manifest.json');
    await writeFile(manifestFile,JSON.stringify({...manifest,bundled:{...manifest.bundled,assetCount:0}}));reject(/Invalid bundled/);
    await rm(manifestFile);reject(/ENOENT/);
  } finally {child?.kill();await rm(temp,{recursive:true,force:true});}
});
