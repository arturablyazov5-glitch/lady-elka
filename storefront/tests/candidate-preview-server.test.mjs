import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvRecords } from '../../supabase/functions/_shared/product-rules.mjs';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';
const workspace = await isolatedWorkspace(fileURLToPath(new URL('../..', import.meta.url)));
after(() => workspace.cleanup());
const fixture = await realpath(workspace.directory);
const candidateDirectory = await mkdtemp(join(tmpdir(), 'le-candidate-artifact-'));
after(() => rm(candidateDirectory, { recursive: true, force: true }));
const candidate = join(await realpath(candidateDirectory), 'artifact');
const run = promisify(execFile);
const denyNetwork = 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Network forbidden in preview fixture")}';
const buildArgs = ['--import', denyNetwork, 'storefront/build.mjs', '--mode=preview'];
const buildOptions = { cwd: fixture, timeout: 120000, maxBuffer: 10 * 1024 * 1024 };
try {
await run(process.execPath, buildArgs, buildOptions);
await run(process.execPath, [...buildArgs,
  '--input-manifest=' + join(fixture, 'storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json'),
  '--media-manifest=' + join(fixture, 'storefront/catalog-media/2026-10-03-public-feed/manifest.json'),
  '--output=' + candidate], buildOptions);
 } catch (error) {
  const cleanup = await Promise.allSettled([
    workspace.cleanup(), rm(candidateDirectory, { recursive: true, force: true })
  ]);
  const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError([error, ...failures], 'Preview build and cleanup failed');
  throw error;
}
const script = join(fixture, 'storefront/server.mjs');
async function start(args = []) {
  const child = spawn(process.execPath, ['--import', denyNetwork, script, '--mode=preview', ...args], { cwd: fixture, env: {...process.env, STOREFRONT_PORT:'0'}, stdio:['ignore','pipe','pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => stderr += bytes);
  let closed = false;
  const closure = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  const stop = async () => {
    if (closed) return;
    child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([closure, new Promise((_, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Preview shutdown timeout')); }, 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const origin = await new Promise((resolve,reject) => {
      let output='';
      const timeout = setTimeout(() => reject(new Error('Preview startup timeout: ' + stderr)), 10000);
      const finish = (callback, value) => { clearTimeout(timeout); callback(value); };
      child.stdout.on('data',bytes => {output+=bytes; const match=output.match(/http:\/\/localhost:(\d+)/);if(match)finish(resolve,'http://127.0.0.1:'+match[1]);});
      child.once('exit', (code, signal) => finish(reject,new Error(`Preview exited ${code ?? signal}: ${stderr}`)));
      child.once('error', error => finish(reject,error));
    });
    return { origin, stop };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Preview startup and cleanup failed'); }
    throw error;
  }
}
const get = (server, path, options) => fetch(server.origin + path, options);
test('default and explicit candidate serve different pinned feeds; preview boundaries', async () => {
  const standard = await start();
  let selected;
  try {
    selected = await start(['--root',candidate]);
    const old = await (await get(standard,'/__offline/catalog/trees.csv')).text();
    const fresh = await (await get(selected,'/__offline/catalog/trees.csv')).text();
    assert.notEqual(old,fresh);
    // Default artifact serves the active accepted snapshot (catalog-snapshots/active.json); the 2026-10-03 candidate
    // used to differ by Darina's prices, but the active 2026-10-08 snapshot has the same prices, so compare exact bytes.
    const pointer = JSON.parse(await readFile(join(fixture, 'storefront/catalog-snapshots/active.json'), 'utf8'));
    const defaultManifest = JSON.parse(await readFile(join(fixture, 'storefront/dist/build-manifest.json'), 'utf8'));
    assert.equal(defaultManifest.snapshot.id, pointer.id);
    assert.ok(old === await readFile(join(fixture, 'storefront/dist/__offline/catalog/trees.csv'), 'utf8'), 'default serves its own pinned active feed');
    assert.ok(csvRecords(old).length > 0 && csvRecords(fresh).length > 0);
    assert.equal(fresh,await readFile(join(candidate,'__offline/catalog/trees.csv'),'utf8'));
    for(const path of ['/','/tree/darina','/tree/darina/','/tree/miranda','/__offline/catalog/trees.csv']) {
      const response=await get(selected,path);assert.equal(response.status,200,path);
      assert.ok(response.headers.get('content-security-policy').includes("connect-src 'self'"));
      const head=await get(selected,path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    }
    for(const method of ['POST','PUT','DELETE','OPTIONS']) assert.equal((await get(selected,'/functions/v1/pay',{method})).status,405);
    const config=await (await get(selected,'/f/storefront-config.js')).text();assert.ok(config.includes('"payment":null'));
    const redirect=await get(selected,'/main',{redirect:'manual'});assert.equal(redirect.status,301);assert.equal(redirect.headers.get('location'),'/');
    for(const path of ['/%2e%2e%2fsecret','/..%5csecret','//example.com']) assert.equal((await get(selected,path)).status,403);
    const image=fresh.match(/\/media\/catalog-pinned\/[a-f0-9]+\.(webp|jpg|png)/)[0];assert.equal((await get(selected,image)).status,200);
  } finally {await Promise.all([standard.stop(), selected?.stop()]);}
});
test('reject arbitrary roots, invalid manifests, CSV corruption and symlink escape', async () => {
  const temp=await mkdtemp(join(tmpdir(),'le-candidate-server-test-'));
  try {
    await assert.rejects(start(['--root='+temp]));
    await cp(candidate,temp,{recursive:true});
    const csv=join(temp,'__offline/catalog/trees.csv'); const bytes=await readFile(csv);
    await writeFile(csv,Buffer.concat([bytes,Buffer.from('\ncorrupt')]));
    await assert.rejects(start(['--root='+temp]),/checksum mismatch/);
    await rm(csv);await assert.rejects(start(['--root='+temp]),/ENOENT/);
    const secret=join(tmpdir(),'le-secret-'+process.pid);await writeFile(secret,'private');
    try {await symlink(secret,csv);await assert.rejects(start(['--root='+temp]),/escapes/);await rm(csv);await writeFile(csv,bytes);
      await symlink(secret,join(temp,'secret.txt'));
      const server=await start(['--root='+temp]);try {
        await writeFile(csv,'corrupt');assert.equal((await get(server,'/__offline/catalog/trees.csv')).status,503);
        await rm(csv);assert.equal((await get(server,'/__offline/catalog/trees.csv')).status,503);
        await symlink(secret,csv);assert.equal((await get(server,'/__offline/catalog/trees.csv')).status,503);
        const response=await get(server,'/secret.txt');assert.equal(response.status,500);assert.ok(!(await response.text()).includes('private'));}finally{await server.stop();}
    }finally{await rm(secret,{force:true});}
    const manifest=JSON.parse(await readFile(join(temp,'build-manifest.json')));manifest.productionReady=true;await writeFile(join(temp,'build-manifest.json'),JSON.stringify(manifest));
    // server.mjs now checks the common artifact manifest (also used by active-snapshot builds) before candidate proofs.
    await assert.rejects(start(['--root='+temp]),/Invalid offline build manifest/);
  }finally{await rm(temp,{recursive:true,force:true});}
});
