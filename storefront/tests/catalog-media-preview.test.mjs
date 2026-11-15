import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validatePreviewInput, setPreviewInput, loadFeed, readFeedText, defaultManifest, validateActiveSnapshot } from '../products/build-feed.mjs';
import { treeProducts, decorProducts } from '../products/model.mjs';
import { presentProduct } from '../products/presentation.mjs';
const run = promisify(execFile), root = resolve(import.meta.dirname, '../..');
const candidate = join(root, 'storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json');
const media = join(root, 'storefront/catalog-media/2026-10-03-public-feed/manifest.json');
const input = () => validatePreviewInput(candidate, media);
test('actual candidate: 142 assets, 1166 exact ordered references including inactive rows', async () => {
  const preview = await input(); assert.equal(preview.mapping.size, 142); assert.equal(preview.references, 1166);
  setPreviewInput(preview);
  try {
    const rows = await loadFeed('trees'); assert.equal(rows.length, 248); assert.equal(rows.filter(row => ['false', '0'].includes(row.active.toLowerCase())).length, 14);
    const products = treeProducts(rows), routes = JSON.parse(await readFile(join(root, 'storefront/product-routes.json')));
    for (const product of products.values()) {
      const route = routes.find(route => route.id === product.id && route.kind === 'tree');
      const view = presentProduct(product, route);
      for (const variant of view.variants) {
        assert.equal(variant.image, variant.photos[0] || '');
        assert.deepEqual(variant.photos, product.variants.find(raw => raw.id === variant.id).photos);
        assert.ok(variant.photos.every(url => url.startsWith('/media/catalog-pinned/')));
      }
    }
    assert.equal(products.get('13').variants.find(v => v.height === 150).price, 22000);
    assert.equal(products.get('13').variants.find(v => v.height === 230).price, 46000);
    assert.equal(products.get('18').variants.length, 0);
    assert.equal(products.get('19').variants.length, 0);
    assert.equal(decorProducts(await loadFeed('decor')).size, 5);
  } finally { setPreviewInput(null); }
});
test('default active snapshot has accepted prices and pinned media', async () => {
  const active = await validateActiveSnapshot();
  assert.equal(defaultManifest, active.manifestPath); setPreviewInput(active);
  try {
    const route = JSON.parse(await readFile(join(root, 'storefront/product-routes.json'))).find(r => r.id === '13');
    const view = presentProduct(treeProducts(await loadFeed('trees')).get('13'), route);
    const raw = treeProducts((await import('../../supabase/functions/_shared/product-rules.mjs')).csvRecords(await readFeedText('trees'))).get('13');
    assert.deepEqual(view.variants.map(v => v.price), raw.variants.map(v => v.price));
    assert.ok(view.variants[0].image.startsWith('/media/catalog-pinned/'));
    assert.equal(await readFeedText('trees'), await readFeedText('trees', defaultManifest));
  } finally { setPreviewInput(null); }
});
test('mapping, provenance, reference order and symlink tampering fail closed', async () => {
  const temporary = await mkdtemp(join(root, 'storefront/catalog-media/preview-test-'));
  try {
    const raw = JSON.parse(await readFile(media));
    for (const mutate of [m => m.assets.shift(), m => m.assets[0].sha256 = '0'.repeat(64), m => m.references.reverse(), m => delete m.candidateFiles['manifest.json'], m => m.assets[0].localPath = '/etc/hosts']) {
      const modified = structuredClone(raw); mutate(modified); const file = join(temporary, 'manifest.json'); await writeFile(file, JSON.stringify(modified));
      await assert.rejects(validatePreviewInput(candidate, file));
    }
    await symlink('/etc/hosts', join(temporary, 'outside')); const modified = structuredClone(raw); modified.assets[0].localPath = join(temporary, 'outside');
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(modified)); await assert.rejects(validatePreviewInput(candidate, join(temporary, 'manifest.json')), /escapes/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test('isolated offline builds preserve shared report and default counts; candidate refuses production before clearing output', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'le-media-preview-'));
  try {
    const reportPath = join(root, 'storefront/audit/build-report.json'), before = await readFile(reportPath);
    const deny = join(temporary, 'deny.mjs'); await writeFile(deny, "globalThis.fetch=()=>{throw new Error('External fetch forbidden')}");
    for (const candidateMode of [false, true]) {
      const output = join(temporary, candidateMode ? 'candidate' : 'default');
      const args = ['--import', deny, 'storefront/build.mjs', '--mode=preview', `--output=${output}`, ...(candidateMode ? [`--input-manifest=${candidate}`, `--media-manifest=${media}`] : [])];
      await run(process.execPath, args, { cwd: root });
      const manifest = JSON.parse(await readFile(join(output, 'build-manifest.json')));
      assert.equal(manifest.productionReady, false); assert.equal(JSON.parse(await readFile(join(output, 'search-index.json'))).length, 67);
      assert.equal(JSON.parse(await readFile(join(output, 'audit/build-report.json'))).generated, 42);
      if (candidateMode) {
        assert.equal(manifest.candidatePreview.references, 1166);
        const html = await readFile(join(output, 'tree/darina/index.html'), 'utf8'); assert.match(html, /catalog-pinned/); assert.match(html, /22000/);
        const cards = await readFile(join(output, 'catalog/index.html'), 'utf8');
        const card = /data-storefront-product="13"[^]*?<script type="application\/json" data-storefront-variants>([^]*?)<\/script>/.exec(cards);
        const view = JSON.parse(card[1]); assert.ok(card[0].includes(`src="${view.variants[0].photos[0]}"`));
        await assert.rejects(run(process.execPath, ['storefront/build.mjs', '--mode=production', `--output=${output}`, `--input-manifest=${candidate}`, `--media-manifest=${media}`], { cwd: root }), /preview mode/);
        assert.match(await readFile(join(output, '__offline/catalog/trees.csv'), 'utf8'), /catalog-pinned/);
      } else assert.equal(manifest.snapshot.id, (await validateActiveSnapshot()).manifest.id);
      await rm(output, { recursive: true, force: true });
    }
    assert.deepEqual(await readFile(reportPath), before);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
