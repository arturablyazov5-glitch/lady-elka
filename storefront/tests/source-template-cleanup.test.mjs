import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
test('capture templates contain data and owned scripts only; checkout controls remain', async () => {
  const publicRoot = join(root, 'public');
  const files = (await readdir(publicRoot, { recursive: true })).filter(file => file.endsWith('.html'));
  assert.equal(files.length, 20);
  for (const file of files) {
    const html = await readFile(join(publicRoot, file), 'utf8');
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = script[1];
      if (/type=['"]application\/(?:ld\+json|json)['"]/i.test(attrs)) {
        assert.doesNotMatch(attrs, /id=['"]data_do_json['"]/);
        JSON.parse(script[2]);
        continue;
      }
      const src = /src=['"]([^'"]+)['"]/.exec(attrs)?.[1];
      assert.ok(['/f/storefront-config.js', '/local-guard.js', '/search.js', '/f/site-runtime.js'].includes(src), `${file}: unexpected executable script ${src}`);
    }
    assert.doesNotMatch(html, /placeholder=['"](?:Товар|Общая сумма)['"]|MutationObserver|\$ite\.start|function swapVivianAndBetty|data_do_json/);
    assert.doesNotMatch(html, /data-action-element=['"]ier1m2br4_0['"]/);
    if (/data-cart-popup/.test(html)) {
      const checkout = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].find(form => /data-pay-now/.test(form[0]))[0];
      assert.doesNotMatch(checkout, /data-field-position/);
      assert.equal([...checkout.matchAll(/data-checkout-field=/g)].length, 8);
      assert.match(html, /data-checkout-field="paymentMethod"/);
      assert.match(html, /data-checkout-field="contactPref"/);
      assert.match(html, /placeholder=['"]Иван Иванов['"]/);
      assert.match(html, /type=['"]tel['"]/);
      assert.match(html, /itogo-wrapper/);
    }
  }
  const catalog = await readFile(join(publicRoot, 'catalog.html'), 'utf8');
  assert.ok(catalog.indexOf("data-title='Бетти'") < catalog.indexOf("data-title='Вивиан'"));
  await assert.rejects(stat(join(publicRoot, 'f/catalog.js')), { code: 'ENOENT' });
  const build = await readFile(join(root, 'build.mjs'), 'utf8');
  assert.match(build, /entryPoints: \[join\(import\.meta\.dirname, 'client', 'index\.js'\)\]/);
  assert.match(build, /outfile: join\(target, 'f', 'catalog\.js'\)/);
});
