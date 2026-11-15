// Шаг 4. Проверка по тому, что реально читает сайт: публичные trees.csv/decor.csv в le-catalog-feeds.
// Для каждого товара (id) — сколько строк-вариантов без фото и доступны ли все ссылки (HEAD, кэш url-checks.json).
// Итог: agent-context/photos-after.json.
import path from 'node:path';
import {CTX, WORK, SUPABASE_URL, checkUrl, readJSON, writeJSON, sleep, progress} from './lib.mjs';

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const cacheFile = path.join(WORK, 'url-checks.json');
const cache = readJSON(cacheFile, {});
const products = new Map();
for (const feed of ['trees.csv', 'decor.csv']) {
  const rows = parseCSV(await (await fetch(`${SUPABASE_URL}/storage/v1/object/public/le-catalog-feeds/${feed}?t=${Date.now()}`)).text());
  for (const r of rows) {
    const p = products.get(r.id) || {id: r.id, feed, title: r.title, rows: 0, rowsWithoutPhotos: 0, urls: new Set()};
    const photos = r.photos.split('|').map(s => s.trim()).filter(Boolean);
    p.rows++; if (!photos.length) p.rowsWithoutPhotos++;
    photos.forEach(u => p.urls.add(u));
    products.set(r.id, p);
  }
}
for (const p of products.values()) for (const u of p.urls) {
  if (cache[u]?.ok) continue;
  cache[u] = await checkUrl(u); writeJSON(cacheFile, cache); await sleep(u.includes('supabase.co') ? 50 : 400);
}
const list = [...products.values()].map(p => ({id: p.id, feed: p.feed, title: p.title, rows: p.rows, rowsWithoutPhotos: p.rowsWithoutPhotos, photos: p.urls.size, broken: [...p.urls].filter(u => !cache[u]?.ok)}));
const totals = {products: list.length, withoutAnyPhoto: list.filter(p => p.photos === 0).length, withSomeRowsWithoutPhoto: list.filter(p => p.rowsWithoutPhotos).length, withBrokenUrls: list.filter(p => p.broken.length).length};
writeJSON(path.join(CTX, 'photos-after.json'), {generatedAt: new Date().toISOString(), totals, products: list});
progress(`verify feeds: ${JSON.stringify(totals)}`);
console.log(JSON.stringify(totals));
