// Шаг 3. Конвертирует скачанные оригиналы в WebP так же, как редактор каталога (EXIF-поворот,
// длинная сторона ≤4000px, WebP 80%), загружает в Supabase Storage le-catalog-images/<uuid>.webp
// (uuid детерминирован от содержимого — повторный запуск не плодит копии, существующее не перезаписывается),
// прописывает URL в le_catalog_products.payload.variants[].photos ТОЛЬКО для вариантов без фото
// (с проверкой revision), затем перевыпускает trees.csv/decor.csv тем же экспортом, что и функция catalog.
// Флаги: --dry-run (ничего не пишет в Supabase), --no-feeds.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {WORK, SUPABASE_URL, serviceKey, rest, listProducts, listBucket, uploadObject, publicUrl, readJSON, writeJSON, progress} from './lib.mjs';

const dry = process.argv.includes('--dry-run');
const scrape = readJSON(path.join(WORK, 'scrape.json'));
if (!scrape) throw new Error('Сначала запустите 02-scrape.mjs');
const uploadsFile = path.join(WORK, 'uploads.json');
const uploads = readJSON(uploadsFile, {});
const webpDir = path.join(WORK, 'webp');
fs.mkdirSync(webpDir, {recursive: true});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const uuidOf = buf => { const h = crypto.createHash('sha256').update(buf).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

// 1. Конвертация + загрузка
const bucket = dry ? new Set() : await listBucket();
for (const rec of Object.values(scrape)) for (const e of rec.entries) {
  if (!e.file || uploads[e.file]) continue;
  const src = path.join(WORK, 'images', e.file);
  const name = uuidOf(fs.readFileSync(src)) + '.webp';
  const out = path.join(webpDir, name);
  if (!fs.existsSync(out)) execFileSync('magick', [src, '-auto-orient', '-resize', '4000x4000>', '-background', 'white', '-alpha', 'remove', '-strip', '-quality', '80', `webp:${out}`]);
  const bytes = fs.readFileSync(out);
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`${name} больше 8 МБ`);
  const status = bucket.has(name) ? 'exists' : dry ? 'dry-run' : await uploadObject(name, bytes, 'image/webp');
  if (dry) { uploads[e.file] = {name, url: publicUrl(name), status}; continue; } // только в памяти
  uploads[e.file] = {name, url: publicUrl(name), bytes: bytes.length, status, source: e.original};
  writeJSON(uploadsFile, uploads);
}
if (!dry) progress(`upload: в uploads.json ${Object.keys(uploads).length} файлов`);

// 2. Привязка к товарам: главные фото страницы, затем «Ещё фото»; одинаковые файлы — один раз.
function photosFor(rec) {
  const ordered = [...rec.entries.filter(e => e.kind === 'main'), ...rec.entries.filter(e => e.kind !== 'main')];
  return [...new Set(ordered.filter(e => e.file && uploads[e.file]).map(e => uploads[e.file].url))].slice(0, 50);
}
const products = await listProducts();
if (!dry) writeJSON(path.join(WORK, `backup-products-${stamp}.json`), products);
let changed = 0;
for (const row of products) {
  const rec = scrape[row.id];
  if (!rec) continue;
  const photos = photosFor(rec);
  if (!photos.length) { console.log(row.id, 'нет фото на старом сайте'); continue; }
  let n = 0;
  const variants = row.payload.variants.map(v => (v.photos || []).length ? v : (n++, {...v, photos}));
  if (!n) continue;
  console.log(row.id, `вариантов обновлено: ${n}, фото: ${photos.length}`);
  if (dry) continue;
  const res = await rest(`le_catalog_products?id=eq.${encodeURIComponent(row.id)}&revision=eq.${row.revision}`, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify({payload: {...row.payload, variants}, revision: row.revision + 1, updated_at: new Date().toISOString()})});
  if (!res.length) throw new Error(`${row.id}: товар изменён параллельно (revision), перезапустите`);
  changed++;
  progress(`link ${row.id}: ${n} вариантов ← ${photos.length} фото`);
}

// 3. Перевыпуск фидов (как publishFeeds в supabase/functions/catalog): функция отдаёт CSV из БД,
//    кладём его в le-catalog-feeds. Старые CSV сохраняются локально в photos-work/feeds-backup-*.
if (!dry && !process.argv.includes('--no-feeds')) {
  const backupDir = path.join(WORK, `feeds-backup-${stamp}`);
  fs.mkdirSync(backupDir, {recursive: true});
  for (const f of ['trees.csv', 'decor.csv']) {
    const old = await (await fetch(`${SUPABASE_URL}/storage/v1/object/public/le-catalog-feeds/${f}?t=${Date.now()}`)).text();
    fs.writeFileSync(path.join(backupDir, f), old);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/catalog/feeds/${f}?t=${Date.now()}`);
    const csv = await res.text();
    if (!res.ok || csv.split('\r\n')[0] !== old.split(/\r?\n/)[0] || csv.split('\r\n').length !== old.split(/\r?\n/).length) throw new Error(`${f}: новый CSV не совпадает по структуре со старым — фиды не тронуты`);
    if (csv === old) { console.log(f, 'без изменений'); continue; }
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/le-catalog-feeds/${f}`, {method: 'POST', headers: {apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'x-upsert': 'true'}, body: csv});
    if (!up.ok) throw new Error(`${f}: загрузка фида ${up.status}`);
    console.log(f, 'обновлён');
  }
  progress(`feeds: trees.csv/decor.csv перевыпущены (бэкап ${path.basename(backupDir)}), товаров изменено ${changed}`);
}
