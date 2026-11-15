import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';
const run = promisify(execFile);

test('GET/HEAD unknown paths retain original 404; /person placeholder, real pages and 301 routes work', async () => {
  const workspace = await isolatedWorkspace(resolve(import.meta.dirname, '../..'));
  let child;
  try {
    await run(process.execPath, ['storefront/build.mjs', '--mode=preview'], { cwd: workspace.directory });
    child = spawn(process.execPath, ['storefront/server.mjs', '--mode=preview', '--emulate-host'], { cwd: workspace.directory, env: { ...process.env, STOREFRONT_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
      child.stdout.on('data', data => { const match = /localhost:(\d+)/.exec(data.toString()); if (match) { clearTimeout(timer); resolvePort(match[1]); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code)); });
    });
    const base = 'http://127.0.0.1:' + port;
    const source404 = await readFile(join(workspace.directory, 'storefront/dist/404.html'), 'utf8');
    for (const path of ['/qwerty-404-test', '/404.html', '/missing/deep/page']) {
      const page = await fetch(base + path, { redirect: 'manual' });
      assert.equal(page.status, 404, path);
      assert.equal(page.headers.get('location'), null, path);
      assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(await page.text(), source404);
      const head = await fetch(base + path, { method: 'HEAD', redirect: 'manual' });
      assert.equal(head.status, 404, path);
      assert.equal(await head.text(), '');
    }
    // Since 8 Oct /person is an owned noindex placeholder (forms link to it; agent-context/person-docs-report.md).
    for (const path of ['/person/', '/person/?from=old']) {
      const page = await fetch(base + path, { redirect: 'manual' });
      assert.equal(page.status, 200, path);
      assert.equal(page.headers.get('location'), null, path);
      assert.match(await page.text(), /<meta name="robots" content="noindex, follow">/, path);
    }
    for (const path of ['/', '/catalog/', '/blog/', '/tree/miranda/', '/f/404.css', '/f/404.js']) {
      assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 200, path);
    }
    // Old production URLs remain permanent aliases; canonical navigation is direct 200.
    for (const path of ['/catalog', '/tree/miranda', '/person', '/catalog-tree/hvojnaya-girlyanda-2.8-metra']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + path + '?from=old', { method, redirect: 'manual' });
        assert.equal(response.status, 308);
        assert.equal(response.headers.get('location'), path + '/?from=old');
        assert.equal((await fetch(base + response.headers.get('location'), { method, redirect: 'manual' })).status, 200);
      }
    }
    for (const [path, destination] of [['/main/', '/'], ['/catalog-decor', '/catalog-tree/'], ['/moya-kollekciya', '/blog/']]) {
      const response = await fetch(base + path + '?from=old', { redirect: 'manual' });
      assert.equal(response.status, 301);
      assert.equal(response.headers.get('location'), destination + '?from=old');
    }
  } finally {
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
    await workspace.cleanup();
  }
});
