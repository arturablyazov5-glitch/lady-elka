import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';

const root = resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
const legacyReference = /catalog\.js(?:\?|%3f)v=11|\$ite\.start|data_do_json|\/g\/(?:s3\/mosaic\/js\/|libs\/jquery\/)|\/assets\/site\/(?:main|s3\/js\/(?:common|lang\/)|vk-id\/)/i;

test('captured catalog archive is physically absent and has no executable source consumer', async () => {
  await assert.rejects(stat(join(root, 'storefront/public/f/catalog.js?v=11')), { code: 'ENOENT' });
  for (const file of await readdir(join(root, 'storefront/public'), { recursive: true })) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(join(root, 'storefront/public', file), 'utf8');
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/type=['"]application\/(?:ld\+json|json)['"]/i.test(script[1])) continue;
      assert.doesNotMatch(script[0], legacyReference, file);
    }
  }
});

test('fresh preview and production load and execute the owned catalog entry exactly once per HTML', async () => {
  const workspace = await isolatedWorkspace(root);
  try {
    const deny = join(workspace.directory, 'deny-legacy-build.mjs');
    await writeFile(deny, "globalThis.fetch=()=>{throw new Error('Offline build network forbidden')};\n");
    for (const mode of ['preview', 'production']) {
      await run(process.execPath, ['--import', deny, 'storefront/build.mjs', `--mode=${mode}`], {
        cwd: workspace.directory, timeout: 120000, maxBuffer: 1024 * 1024,
      });
      const target = join(workspace.directory, 'storefront', mode === 'preview' ? 'dist' : 'production/dist');
      await assert.rejects(stat(join(target, 'f/catalog.js?v=11')), { code: 'ENOENT' });
      // Shared content-hashed runtime replaces the former five script URLs.
      const assets = JSON.parse(await readFile(join(target, 'request-assets.json'), 'utf8'));
      const bundle = await readFile(join(target, 'f/catalog.js'), 'utf8');
      assert.doesNotMatch(bundle, legacyReference);
      let pages = 0;
      for (const file of await readdir(target, { recursive: true })) {
        if (!file.endsWith('.html')) continue;
        // 404.html is a standalone copy of the live Taptop 404 (owner requirement, see agent-context/progress-404.md): own /f/404.js, no cart/checkout; covered by 404-*.test.mjs.
        if (file === '404.html') continue;
        const html = await readFile(join(target, file), 'utf8');
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        const entry = scripts.filter(script => script[1].includes(assets.runtime));
        assert.equal(entry.length, 1, `${mode}/${file}: owned bundle count`);
        for (const script of scripts) {
          if (/type=['"]application\/(?:ld\+json|json)['"]/i.test(script[1])) continue;
          assert.doesNotMatch(script[0], legacyReference, `${mode}/${file}`);
        }
        // Execute the emitted bytes at the browser's loading phase. The actual
        // entry must register exactly one once-only start, without network or
        // running checkout against a synthetic DOM. Interaction QA is separate.
        const starts = [];
        const context = vm.createContext({ document: {
          // client/index.js also subscribes to the storefront:products-added event; only the start registration is counted.
          readyState: 'loading', addEventListener: (...args) => { if (args[0] === 'DOMContentLoaded') starts.push(args); },
        } });
        for (const script of entry) vm.runInContext(bundle, context, { timeout: 1000, filename: `${mode}/${file}:catalog.js` });
        assert.equal(starts.length, 1, `${mode}/${file}: entry execution count`);
        assert.equal(starts[0][0], 'DOMContentLoaded');
        assert.equal(typeof starts[0][1], 'function');
        assert.equal(starts[0][2].once, true);
        pages++;
      }
      assert.ok(pages >= 85, `${mode}: unexpectedly incomplete artifact (${pages} HTML)`);
      console.log(`${mode}: ${pages} fresh HTML; one owned entry execution each; zero legacy runtime references`);
    }
  } finally { await workspace.cleanup(); }
});
