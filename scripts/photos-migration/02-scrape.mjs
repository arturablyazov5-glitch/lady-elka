// Шаг 2. Для товаров из photos-missing.json (status != ok) открывает их страницы на lady-elka.ru,
// достаёт фото карточки (div.product__img__cms = главное, div.product__img-dop__cms = «Ещё фото»,
// атрибут data-cat = тип варианта), переводит превью Taptop /thumb/2/<hash>/<size>/d/<file> в оригинал /d/<file>
// и скачивает оригиналы последовательно с паузой. Кэш: agent-context/photos-work/{pages,images}/, итог: scrape.json.
// Повторный запуск ничего не перекачивает. Флаг --all — обработать все товары, не только без фото.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {CTX, WORK, OLD_SITE, UA, sleep, readJSON, writeJSON, progress} from './lib.mjs';

const PAUSE = 1500;
const missing = readJSON(path.join(CTX, 'photos-missing.json'));
if (!missing) throw new Error('Сначала запустите 01-inventory.mjs');
const targets = missing.products.filter(p => process.argv.includes('--all') || p.status !== 'ok');
const scrapeFile = path.join(WORK, 'scrape.json');
const state = readJSON(scrapeFile, {});
fs.mkdirSync(path.join(WORK, 'pages'), {recursive: true});
fs.mkdirSync(path.join(WORK, 'images'), {recursive: true});

const PLACEHOLDER = /image-placeholder|fgs16_/i;
const toOriginal = src => {
  const u = new URL(src.replace(/&amp;/g, '&'), OLD_SITE);
  const m = u.pathname.match(/^\/thumb\/2\/[^/]+\/[^/]+(\/d\/.+)$/);
  return OLD_SITE + (m ? m[1] : u.pathname);
};

async function get(url, binary = false) {
  const res = await fetch(url, {headers: {'User-Agent': UA}, redirect: 'follow', signal: AbortSignal.timeout(60000)});
  await sleep(PAUSE);
  if (!res.ok) return {status: res.status};
  return {status: res.status, type: res.headers.get('content-type') || '', body: binary ? Buffer.from(await res.arrayBuffer()) : await res.text()};
}

async function page(routePath) {
  const file = path.join(WORK, 'pages', routePath.replace(/^\//, '').replaceAll('/', '__') + '.html');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const r = await get(OLD_SITE + routePath);
  if (r.status !== 200) return null;
  fs.writeFileSync(file, r.body);
  return r.body;
}

function extract(html) {
  const out = [];
  const re = /<div([^>]*class=['"][^'"]*product__img(-dop)?__cms[^'"]*['"][^>]*)>\s*<img\b([^>]*)>/g;
  for (const m of html.matchAll(re)) {
    const src = m[3].match(/\bsrc=['"]([^'"]+)['"]/)?.[1];
    if (!src || PLACEHOLDER.test(src)) continue;
    out.push({kind: m[2] ? 'dop' : 'main', cat: m[1].match(/data-cat=['"]([^'"]*)['"]/)?.[1] ?? '', src, original: toOriginal(src)});
  }
  return out;
}

async function download(entry) {
  const id = crypto.createHash('sha1').update(entry.original).digest('hex').slice(0, 16);
  const existing = fs.readdirSync(path.join(WORK, 'images')).find(f => f.startsWith(id + '.'));
  if (existing) return {file: existing, from: 'cache'};
  for (const [url, from] of [[entry.original, 'original'], [new URL(entry.src, OLD_SITE).href, 'thumb']]) {
    const r = await get(url, true);
    if (r.status === 200 && /^image\//.test(r.type) && r.body.length > 100) {
      const ext = r.type.includes('webp') ? 'webp' : r.type.includes('png') ? 'png' : 'jpg';
      fs.writeFileSync(path.join(WORK, 'images', `${id}.${ext}`), r.body);
      return {file: `${id}.${ext}`, from, url};
    }
  }
  return {file: null, error: 'download failed'};
}

for (const p of targets) {
  if (state[p.id]?.done) continue;
  const rec = {title: p.title, paths: p.paths, entries: [], pageErrors: []};
  for (const routePath of p.paths) {
    const html = await page(routePath);
    if (!html) { rec.pageErrors.push(routePath); continue; }
    for (const e of extract(html)) if (!rec.entries.some(x => x.original === e.original && x.cat === e.cat && x.kind === e.kind)) rec.entries.push({...e, route: routePath});
  }
  for (const e of rec.entries) Object.assign(e, await download(e));
  rec.done = true;
  state[p.id] = rec;
  writeJSON(scrapeFile, state);
  progress(`scrape ${p.id} (${p.title}): ${rec.entries.filter(e => e.file).length} фото${rec.pageErrors.length ? ', ошибки страниц: ' + rec.pageErrors.join(',') : ''}`);
  console.log(p.id, rec.entries.filter(e => e.file).length);
}
