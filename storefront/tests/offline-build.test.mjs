import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { readFeedText, readManifest, legacyManifest } from '../products/build-feed.mjs';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');

test('offline artifacts build with fetch forbidden and production contains no fixture or keys', async () => {
  const workspace = await isolatedWorkspace(root);
  const temporary = workspace.directory;
  try {
    const deny = join(temporary, 'deny.mjs');
    await writeFile(deny, "globalThis.fetch=()=>{throw new Error('Network forbidden during offline build')};\n");
    for (const mode of ['preview', 'production']) {
      await run(process.execPath, ['--import', deny, 'storefront/build.mjs', `--mode=${mode}`], { cwd: temporary });
    }
    for (const artifact of ['dist', 'production/dist']) {
    const target = join(temporary, 'storefront', artifact);
    for (const file of await readdir(target, { recursive: true })) {
      if (!/\.(js|html|json|css)$/.test(file)) continue;
      const text = await readFile(join(target, file), 'utf8');
      assert.doesNotMatch(text, /\/__test|PGlite|browser-fixture|SUPABASE_SERVICE_ROLE_KEY|ALFA_API_PASS|test-service-key/i, file);
    }
    const manifest = JSON.parse(await readFile(join(target, 'build-manifest.json'), 'utf8'));
    assert.equal(manifest.productionReady, false);
    assert.equal(manifest.snapshot.freshness, 'current-fetch-owner-confirmed');
    const routes = JSON.parse(await readFile(join(temporary, 'storefront/product-routes.json'), 'utf8'));
    assert.equal(routes.length, 42);
    for (const route of routes) assert.match(await readFile(join(target, route.path, 'index.html'), 'utf8'), /data-storefront-page-product/);
    assert.equal(JSON.parse(await readFile(join(target, 'search-index.json'), 'utf8')).length, 67);
    }
  } finally { await workspace.cleanup(); }
});

test('snapshot checksums verified and missing promo feed fails explicitly', async () => {
  assert.equal((await readManifest()).productionReady, false);
  assert.match(await readFeedText('trees'), /Миранда/);
  await assert.rejects(readFeedText('promos', legacyManifest), /unavailable/);
});

test('local browser guard rejects URL, Request, init writes and disables redirects before network', async () => {
  const calls = [];
  const context = { URL, Request, location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:4197', href: 'http://localhost:4197/tree/miranda' } };
  context.window = { fetch: async request => { calls.push(request); return new Response('ok'); } };
  vm.runInNewContext(await readFile(join(root, 'storefront/public/local-guard.js'), 'utf8'), context);
  for (const input of [new URL('https://unexpected.example.test/'), new Request('https://unexpected.example.test/')]) await assert.rejects(context.window.fetch(input), /Only Supabase catalog reads are enabled in local preview/);
  await assert.rejects(context.window.fetch('/functions/v1/pay', { method: 'POST' }), /Only Supabase catalog reads are enabled in local preview/);
  await assert.rejects(context.window.fetch(new Request('http://localhost:4197/functions/v1/pay'), { method: 'POST' }), /Only Supabase catalog reads are enabled in local preview/);
  assert.equal(calls.length, 0);
  await context.window.fetch('/__offline/catalog/trees.csv', { redirect: 'follow' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(context.window.__LE_STOREFRONT_CONFIG__.payment, null);
});

test('production artifact preview overrides endpoints, refuses writes and has no upstream fallback', async t => {
  const workspace = await isolatedWorkspace(root);
  t.after(() => workspace.cleanup());
  const deny = join(workspace.directory, 'deny.mjs');
  await writeFile(deny, "globalThis.fetch=()=>{throw new Error('Network forbidden')}");
  await run(process.execPath, ['--import', deny, 'storefront/build.mjs', '--mode=production'], { cwd: workspace.directory });
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Server network forbidden")}', 'storefront/server.mjs', '--mode=preview', '--artifact=production'], { cwd: workspace.directory, env: { ...process.env, STOREFRONT_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolvePort, reject) => {
      const timeout = setTimeout(() => reject(new Error('Preview startup timeout')), 10000);
      child.stdout.on('data', data => { const match = /localhost:(\d+)/.exec(data.toString()); if (match) { clearTimeout(timeout); resolvePort(Number(match[1])); } });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const config = await (await fetch(`${base}/f/storefront-config.js`)).text();
    // Since 7 Oct local preview reads the live public catalog feeds; no other upstream (no lead/payment).
    for (const url of config.match(/https:\/\/[^"]+/g) || []) assert.match(url, /^https:\/\/mgnotvaahftrbifqtahf\.supabase\.co\/storage\/v1\/object\/public\/le-catalog-feeds\/(?:trees|decor|promos)\.csv$/);
    assert.match(config, /"lead":null/);
    assert.match(config, /"payment":null/);
    assert.equal((await fetch(`${base}/functions/v1/pay`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/__test/control`)).status, 404);
    assert.equal((await fetch(`${base}/d/missing-image.png`)).status, 404);
    assert.equal((await fetch(`${base}/__offline/catalog/promos.csv`)).status, 200);
    assert.equal((await fetch(`${base}/__offline/catalog/trees.csv`)).status, 200);
    for (let repeat = 0; repeat < 2; repeat++) {
      const page = await fetch(`${base}/tree/miranda`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
      assert.match(await page.text(), /data-storefront-page-product/);
    }
    const redirect = await fetch(`${base}/main`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/');
  } finally {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    await closed;
    await workspace.cleanup();
  }
});

test('missing build or server mode fails closed', async () => {
  for (const script of ['storefront/build.mjs', 'storefront/server.mjs']) await assert.rejects(run(process.execPath, [script], { cwd: root }), /Explicit/);
});

test('missing referenced asset produces an explicit build error', async () => {
  const { validateBuildAssets } = await import('../products/build-assets.mjs');
  const temporary = await mkdtemp(join(tmpdir(), 'le-missing-asset-'));
  try {
    await writeFile(join(temporary, 'index.html'), '<img src="/missing.png">');
    await assert.rejects(validateBuildAssets(temporary), /missing local resource \/missing.png/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
