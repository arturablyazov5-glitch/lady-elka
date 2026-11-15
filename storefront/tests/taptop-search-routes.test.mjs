import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, mkdir, symlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');

test('isolated offline artifact owns scripts, populated catalogs, search and return routes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'le-routes-test-'));
  try {
    // Entire build inputs, including src; never reuse shared generated output.
    // app/public/js holds shared validators the build imports (catalog-import promo-model, blog-model).
    for (const directory of ['storefront', 'src', 'supabase/functions/_shared', 'app/public/js']) {
      await mkdir(join(temporary, directory, '..'), { recursive: true });
      await cp(join(root, directory), join(temporary, directory), { recursive: true,
        filter: path => !/(?:\/dist|\/production\/dist)(?:\/|$)/.test(path) });
    }
    await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'));
    const deny = 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Build network forbidden")}';
    await run(process.execPath, ['--import', deny, join(temporary, 'storefront/build.mjs'), '--mode=preview']);
    const target = join(temporary, 'storefront/dist');
    // /f/metrika.js: owned Yandex.Metrika loader added by the build (cutover blocker «нет Метрики в сборке»).
    // Intentional request-budget change: all shared runtimes are one content-hashed entry.
    const assets = JSON.parse(await readFile(join(target, 'request-assets.json'), 'utf8'));
    const allowed = new Set([assets.runtime, assets.search]);
    const internalLinks = new Set();
    for (const path of await readdir(target, { recursive: true })) {
      if (!path.endsWith('.html')) continue;
      // 404.html is a standalone copy of the live Taptop 404 (owner requirement, see agent-context/progress-404.md): own /f/404.js, no cart/checkout; covered by 404-*.test.mjs.
      if (path === '404.html') continue;
      const html = await readFile(join(target, path), 'utf8');
      assert.doesNotMatch(html, /MutationObserver|onSubmitFast|__fastBind|swapVivianAndBetty|\$ite\.start|data_do_json|placeholder=["'](?:Товар|Общая сумма)["']|data-s3-anketa-id|data-action-element=['"]ier1m2br4_0['"]/, path);
      if (/data-cart-open/.test(html)) assert.match(html, /data-cart-popup/, `${path}: header cart has no popup`);
      assert.ok(html.includes(`src="${assets.runtime}" defer`), `${path}: owned cart runtime missing`);
      for (const link of html.matchAll(/<a\b[^>]*href=['"]([^'"]*)['"]/gi)) {
        if (!link[1].startsWith('/') || link[1].startsWith('//')) continue;
        internalLinks.add(link[1].split(/[?#]/)[0]);
      }
      const scripts = [];
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/type=['"]application\/(?:ld\+json|json)['"]/.test(match[1])) continue;
        const src = /src=['"]([^'"]+)['"]/.exec(match[1])?.[1];
        assert.ok(allowed.has(src), `${path}: unowned script ${src}`);
        scripts.push(src);
      }
      assert.equal(new Set(scripts).size, scripts.length, `${path}: duplicate scripts`);
    }
    for (const path of internalLinks) {
      const redirects = new Map([['/main', '/'], ['/catalog-decor', '/catalog-tree'], ['/moya-kollekciya', '/blog'], ['/person', '/oferta']]);
      const relative = (redirects.get(path) || path).replace(/^\//, '');
      const candidates = [join(target, relative, 'index.html'), join(target, relative), join(target, relative + '.html')];
      const files = await Promise.all(candidates.map(file => stat(file).then(s => s.isFile(), () => false)));
      assert.ok(files.some(Boolean), `Broken internal route ${path}`);
    }
    // Published sitemap = original minus noindex/alias URLs (seo.mjs filterSitemap).
    const { filterSitemap } = await import('../seo.mjs');
    assert.equal(await readFile(join(target, 'sitemap.xml'), 'utf8'), filterSitemap(await readFile(join(root, 'storefront/audit/original-sitemap.xml'), 'utf8')));
    for (const path of ['catalog', 'catalog/landscape-gardening', 'catalog-tree']) {
      const html = await readFile(join(target, path, 'index.html'), 'utf8');
      assert.ok((html.match(/data-storefront-product=/g) || []).length >= 5, path);
      assert.match(html, /data-storefront-variants/);
      assert.match(html, new RegExp(`https://lady-elka.ru/${path}`));
    }
    const catalog = await readFile(join(target, 'catalog/index.html'), 'utf8');
    assert.ok(catalog.indexOf('data-storefront-product="6"') < catalog.indexOf('data-storefront-product="5"'));
    assert.equal(await readFile(join(target, 'catalog.html'), 'utf8'), catalog);
    assert.match(await readFile(join(target, 'testy/index.html'), 'utf8'), /data-storefront-variants/);
    const index = JSON.parse(await readFile(join(target, 'search-index.json'), 'utf8'));
    // Directory URLs intentionally end in / to avoid Timeweb 308; .html articles remain file URLs.
    // search-index mirrors the filtered sitemap, plus one entry per tree type («Миранда заснеженная»): 67 = 53 + 14.
    assert.equal(index.length, 67);
    assert.ok(index.some(item => item.path === '/catalog/'));
    assert.ok(index.some(item => item.path === '/tree/miranda/'));
    const productResult = index.find(item => item.path === '/tree/darina/');
    assert.equal(productResult.kind, 'product');
    assert.match(productResult.cardHtml, /data-storefront-product="13"/);
    assert.match(productResult.cardHtml, /data-storefront-variants/);
    assert.match(productResult.cardHtml, /data-cart-open/);
    assert.match(productResult.cardHtml, /data-storefront-variant/);
    assert.ok(index.some(item => item.kind === 'article'));
    const legacyPriceArticle = index.find(item => item.path === '/blog/iskusstvennaya-yelka-cena-i-chto-na-nee-vliyaet/');
    assert.match(legacyPriceArticle.description, /качества каркаса/);
    assert.doesNotMatch(legacyPriceArticle.description, /Политика конфиденциальности/);
    const legacyChoiceArticle = index.find(item => item.path === '/blog/novogodnie-iskusstvennye-yelki-kak-vybrat-idealnuyu-yelku-dlya-doma-na-dolgie-gody/');
    assert.match(legacyChoiceArticle.description, /без просветов/);

    const searchPage = await readFile(join(target, 'search/index.html'), 'utf8');
    assert.equal([...searchPage.matchAll(/<link[^>]+rel="stylesheet"/g)].length, 1, 'search styles share one CSS resource');
    assert.doesNotMatch(searchPage, /result-wrapper__list|search-result__list-item/);

    for (let page = 0; page < 7; page++) assert.ok((await readFile(join(target, page ? `search/p/${page}/index.html` : 'search/index.html'), 'utf8')).includes(`src="${assets.search}" defer`), 'one owned hashed search entry');
    const failed = await readFile(join(target, 'pay-return/index.html'), 'utf8');
    assert.match(failed, /Оплата не завершена/);
    assert.doesNotMatch(failed, /Спасибо за заявку|Мы свяжемся с вами в течении/);
    for (const path of ['spasibo', 'testy']) assert.ok((await readFile(join(target, path, 'index.html'), 'utf8')).includes(assets.runtime));
    const manifest = JSON.parse(await readFile(join(target, 'build-manifest.json'), 'utf8'));
    assert.equal(manifest.productionReady, false);
    // Active snapshot (catalog-snapshots/active.json, 2026-10-08) was approved by the owner.
    assert.equal(manifest.snapshot.freshness, 'current-fetch-owner-confirmed');
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5 }); }
});
