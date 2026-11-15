// Шаг 1. Инвентаризация: какие товары (le_catalog_products) без фото / с частично пустыми
// вариантами / с битыми ссылками. Отчёт: agent-context/photos-missing.json (или путь из argv[2]).
// Идемпотентно; проверки URL кэшируются в agent-context/photos-work/url-checks.json (--recheck сбрасывает).
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, CTX, WORK, listProducts, checkUrl, readJSON, writeJSON, sleep, progress} from './lib.mjs';

const out = process.argv.find(a => a.endsWith('.json')) || path.join(CTX, 'photos-missing.json');
const recheck = process.argv.includes('--recheck');
const cacheFile = path.join(WORK, 'url-checks.json');
const cache = recheck ? {} : readJSON(cacheFile, {});
const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'storefront/product-routes.json'), 'utf8'));

const products = await listProducts();
const urls = [...new Set(products.flatMap(p => p.payload.variants.flatMap(v => v.photos || [])))];
for (const url of urls) {
  if (cache[url]) continue;
  cache[url] = await checkUrl(url);
  writeJSON(cacheFile, cache);
  await sleep(url.includes('supabase.co') ? 50 : 400); // старые домены — вежливо
}

const report = {generatedAt: new Date().toISOString(), totals: {}, products: []};
for (const {id, payload: p} of products) {
  const variants = p.variants.map(v => ({key: v.key, category: v.category || '', height_cm: v.height_cm, variants: v.variants, active: v.active, photos: (v.photos || []).length, broken: (v.photos || []).filter(u => !cache[u]?.ok)}));
  const noPhoto = variants.filter(v => !v.photos);
  const broken = [...new Set(variants.flatMap(v => v.broken))];
  const brokenOnlyVariants = variants.filter(v => v.photos && v.broken.length === v.photos);
  const status = noPhoto.length === variants.length ? 'no-photos' : (noPhoto.length || brokenOnlyVariants.length) ? 'partial' : broken.length ? 'some-broken' : 'ok';
  report.products.push({id, sku: p.sku, kind: p.kind, title: p.title, paths: routes.filter(r => r.id === p.sku).map(r => r.path), status,
    variantsTotal: variants.length, variantsWithoutPhotos: noPhoto.map(v => `${v.key} ${v.category} ${v.height_cm || v.variants || ''}`.trim()),
    variantsOnlyBroken: brokenOnlyVariants.map(v => v.key), brokenUrls: broken.map(u => ({url: u, ...cache[u]}))});
}
const count = s => report.products.filter(p => p.status === s).length;
report.totals = {products: products.length, ok: count('ok'), noPhotos: count('no-photos'), partial: count('partial'), someBroken: count('some-broken'),
  needFix: report.products.filter(p => p.status !== 'ok').length, urlsChecked: urls.length, urlsBroken: urls.filter(u => !cache[u]?.ok).length};
writeJSON(out, report);
progress(`inventory → ${path.relative(ROOT, out)}: ${JSON.stringify(report.totals)}`);
console.log(JSON.stringify(report.totals));
