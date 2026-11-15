import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHosting } from '../hosting/build.mjs';

test('original 404 markup is copied unchanged; static hosting keeps 404 and the verified 301 routes', async () => {
  const target = await mkdtemp(join(tmpdir(), 'le404-hosting-'));
  try {
    await buildHosting(target);
    const html = await readFile(join(target, '404.html'), 'utf8');
    assert.equal(html, await readFile(new URL('../hosting/404.html', import.meta.url), 'utf8'));
    assert.match(html, /<title>Страница не найдена<\/title>/);
    assert.match(html, /name="robots" content="none"/);
    assert.match(html, /Страница, которую вы ищете,/);
    assert.match(html, /href='\/main'/);
    assert.doesNotMatch(html, /Эта страница затерялась|le-not-found|<script(?! src="\/f\/404.js")/);
    const inventory = JSON.parse(await readFile(new URL('../hosting/404-assets.json', import.meta.url), 'utf8'));
    assert.deepEqual(inventory.missingSourceAssets, []);
    for (const local of Object.values(inventory.assets)) {
      assert.ok((await readFile(new URL('../public' + local, import.meta.url))).length, local);
    }
    const apache = await readFile(join(target, '.htaccess'), 'utf8');
    const nginx = await readFile(join(target, 'nginx.conf.example'), 'utf8');
    assert.doesNotMatch(apache + nginx, /(?:Header set|add_header) Content-Security-Policy/);
    assert.match(apache, /ErrorDocument 404 \/404.html/);
    assert.match(apache, /R=301/);
    assert.match(nginx, /try_files \$uri \$uri\/ \$uri.html =404/);
    assert.match(nginx, /noindex, nofollow/);
    assert.doesNotMatch(apache + nginx, /person|try_files[^\n]*\/index.html/);
  } finally { await rm(target, { recursive: true, force: true }); }
});
