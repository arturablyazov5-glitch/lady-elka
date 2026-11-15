import {databaseBilling} from '../_shared/billing-store.mjs';
const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ADMIN_PASSWORD = Deno.env.get('CATALOG_ADMIN_PASSWORD') || '';
const SESSION_SECRET = Deno.env.get('CATALOG_SESSION_SECRET') || '';
const FEED_BUCKET = 'le-catalog-feeds';
const ALLOWED_ORIGINS = new Set((Deno.env.get('CATALOG_ALLOWED_ORIGINS') || 'https://arturablyazov5-glitch.github.io,http://localhost:4180').split(',').map(s => s.trim()).filter(Boolean));
const encoder = new TextEncoder();

type Json = Record<string, unknown>;
// Доп. заголовки ответа конкретного запроса (X-Feed-Warning, Retry-After) — подмешиваются в response().
const extraHeaders = new WeakMap<Request, Record<string, string>>();

function routeOf(url: URL) {
  const marker = '/functions/v1/catalog';
  if (url.pathname.startsWith(marker)) return url.pathname.slice(marker.length) || '/';
  const index = url.pathname.indexOf('/catalog');
  return index >= 0 ? (url.pathname.slice(index + '/catalog'.length) || '/') : url.pathname;
}

function cors(req: Request, publicRead = false) {
  const origin = req.headers.get('origin');
  const allowed = publicRead ? '*' : (origin && ALLOWED_ORIGINS.has(origin) ? origin : '');
  return {
    ...(allowed ? {'Access-Control-Allow-Origin': allowed} : {}),
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-catalog-request',
    'Access-Control-Max-Age': '86400',
    ...(publicRead ? {} : {'Access-Control-Expose-Headers': 'X-Feed-Warning, Retry-After'}),
    'Vary': 'Origin',
  };
}

function response(req: Request, status: number, data: unknown, type = 'application/json; charset=utf-8', publicRead = false) {
  const body = req.method === 'HEAD' || status === 204 ? null : (typeof data === 'string' ? data : JSON.stringify(data));
  return new Response(body, {status, headers: {'Content-Type': type, 'Cache-Control': publicRead ? 'public, max-age=60' : 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors(req, publicRead), ...(extraHeaders.get(req) || {})}});
}

// Лимит в БАЙТАХ при чтении потока: превышение → cancel и 413 сразу, тело целиком в память не попадает.
// Content-Length — только дополнительный ранний сигнал (его можно не прислать или подделать).
const LOGIN_BODY_LIMIT = 4096;
async function readBody(req: Request, max: number) {
  const tooLarge = () => Object.assign(new Error('Слишком большой запрос'), {status: 413});
  const declared = Number(req.headers.get('content-length'));
  if (req.headers.has('content-length') && Number.isFinite(declared) && declared > max) { await req.body?.cancel().catch(() => {}); throw tooLarge(); }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function jsonBody(req: Request, max = 12_000_000) {
  const raw = new TextDecoder().decode(await readBody(req, max));
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Некорректный JSON'), {status: 400}); }
}

function base64url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function hmacKey() {
  if (!SESSION_SECRET) throw new Error('Не настроен CATALOG_SESSION_SECRET');
  return crypto.subtle.importKey('raw', encoder.encode(SESSION_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}

async function issueSession() {
  const payload = base64url(encoder.encode(JSON.stringify({exp: Date.now() + 24 * 60 * 60 * 1000, nonce: crypto.randomUUID()})));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

async function validSession(req: Request) {
  const token = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(), decodeBase64url(signature), encoder.encode(payload));
    if (!valid) return false;
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64url(payload)));
    return Number(parsed.exp) > Date.now();
  } catch { return false; }
}

async function sameSecret(left: unknown, right: string) {
  const key = await hmacKey();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(String(left ?? ''))),
    crypto.subtle.sign('HMAC', key, encoder.encode(right)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.length === y.length && x.every((byte, index) => byte === y[index]);
}

// Источник для лимита входа: адрес клиента от шлюза Supabase (как в lead), в БД — только солёный sha256.
// Подделанный x-forwarded-for даёт атакующему лишь новые «источники» — их всё равно ограничивает общий бюджет endpoint в БД.
async function loginSource(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${SESSION_SECRET}:catalog-login:${ip}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function db(path: string, options: RequestInit = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Supabase Edge Function не получила служебные ключи');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {})},
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const where = `${err.message || ''} ${err.details || ''}`;
    const duplicate = err.code === '23505' && (/le_promo_code/.test(where) ? 'Такой промокод уже есть — регистр и «ё» не различаются' : 'Товар с таким артикулом уже существует');
    const error = new Error(duplicate || (err.code === '23514' ? 'Проверьте значения: данные не проходят ограничения' : err.message || `Supabase: ${res.status}`));
    Object.assign(error, {status: err.code === '23505' ? 409 : err.code === '23514' ? 400 : 502});
    throw error;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const billing=databaseBilling(db,(key: string)=>Deno.env.get(key));

async function listProducts() { return (await db('le_catalog_products?select=payload,revision,updated_at&order=created_at.asc,id.asc')).map((r: Json) => ({...(r.payload as Json), revision: r.revision, updated_at: r.updated_at})); }
async function getSettings() { const [row] = await db('le_catalog_settings?id=eq.1&select=payload,revision,updated_at'); if (!row) throw new Error('Не созданы настройки каталога'); return {...row.payload, revision: row.revision, updated_at: row.updated_at}; }
async function listPromos() { return (await db('le_promo_codes?select=id,code,comment,rub,pct,gift,active,revision,created_at,updated_at&order=created_at.desc')).map((r: Json) => ({...r, rub: Number(r.rub), pct: Number(r.pct)})); }
async function listPaidOrders() { try { return await db('payment_orders?select=description,amount,created_at&status=eq.paid&order=created_at.desc&limit=2000'); } catch { return []; } }

function calculatePrice(base: number, settings: any) {
  const price = Math.round((base * (100 + settings.adjustment_pct)) / 100);
  return {price, offer: settings.discount_pct ? Math.ceil(price * 100 / (100 - settings.discount_pct)) : 0, discount_pct: -settings.discount_pct};
}
function resolveType(v: any, settings: any) { return settings.types.find((t: any) => t.id === v.type_id) || settings.types.find((t: any) => t.name === v.category || t.aliases?.includes(v.category)); }
// Тип (Зелёная/С освещением/Заснеженная и т.п.) резолвим и для декора тоже — у декора он
// не обязателен ("Без типа"), но если назначен, фронтенд должен получить актуальное имя из
// настроек (см. exportCSV: у декора теперь тоже есть колонка category).
function pricedProduct(p: any, settings: any) { return {...p, variants: p.variants.map((v: any) => { const base = v.base_price ?? v.price; const type = resolveType(v, settings); return {...v, base_price: base, ...calculatePrice(base, settings), ...(type ? {type_id: type.id, category: type.name} : {})}; })}; }

function validateSettings(s: any) {
  if (!s || !Number.isFinite(s.discount_pct) || s.discount_pct < 0 || s.discount_pct >= 100) throw new Error('Скидка должна быть от 0 до 99%');
  if (!Number.isFinite(s.adjustment_pct) || s.adjustment_pct <= -100 || s.adjustment_pct > 1000) throw new Error('Изменение цены должно быть больше −100% и не больше +1000%');
  if (!Array.isArray(s.types) || !s.types.length || s.types.length > 100) throw new Error('Добавьте хотя бы один тип товара');
  const names = new Set(), ids = new Set();
  for (const t of s.types) { const name = String(t?.name || '').trim(); if (!/^[a-z0-9-]{1,80}$/.test(t?.id || '') || !name || name.length > 100) throw new Error('Проверьте название типа'); const key = name.toLowerCase().replaceAll('ё', 'е'); if (names.has(key) || ids.has(t.id)) throw new Error('Названия типов не должны повторяться'); names.add(key); ids.add(t.id); }
  return s;
}

function validateProduct(p: any) {
  if (!p || !['trees', 'decor'].includes(p.kind) || typeof p.sku !== 'string' || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(p.sku) || p.id !== `${p.kind}:${p.sku}`) throw new Error('Укажите корректный артикул');
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200) throw new Error('Укажите название товара');
  if (!Array.isArray(p.variants) || !p.variants.length || p.variants.length > 200) throw new Error('Добавьте хотя бы один вариант');
  const keys = new Set();
  for (const v of p.variants) {
    if (typeof v.key !== 'string' || keys.has(v.key)) throw new Error('Повторяющийся вариант'); keys.add(v.key);
    for (const key of ['price', 'height_cm', 'diameter_cm', 'branches', 'offer', 'source_price']) if (!Number.isFinite(v[key]) || v[key] < 0 || v[key] > 1e9) throw new Error('Проверьте цены и размеры: нужны положительные числа');
    if (v.price <= 0 || (p.kind === 'trees' && (v.height_cm <= 0 || typeof v.category !== 'string' || !v.category.trim()))) throw new Error('У каждого варианта должны быть цена, высота и комплектация');
    if (!Number.isFinite(v.base_price) || v.base_price <= 0 || v.base_price > 1e8) throw new Error('Укажите базовую цену больше нуля');
    if (!Number.isFinite(v.discount_pct) || Math.abs(v.discount_pct) >= 100) throw new Error('Скидка должна быть меньше 100%');
    if (typeof v.active !== 'boolean' || typeof v.description !== 'string' || v.description.length > 20000 || typeof v.variants !== 'string' || v.variants.length > 200) throw new Error('Некорректные данные варианта');
    if (!Array.isArray(v.photos) || v.photos.length > 50 || v.photos.some((photo: string) => { try { return !['http:', 'https:'].includes(new URL(photo).protocol); } catch { return true; } })) throw new Error('Для фотографий нужны ссылки http или https');
  }
  return p;
}

function prepareProduct(input: any, settings: any) {
  if (!input || !Array.isArray(input.variants)) throw new Error('Некорректная карточка товара');
  for (const v of input.variants) if (input.kind === 'trees' && !settings.types.some((t: any) => t.id === v.type_id)) throw new Error('Выберите тип из настроек');
  return validateProduct(pricedProduct(input, settings));
}

const normalizeCode = (s: unknown) => String(s ?? '').trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ');
function validatePromo(input: any) {
  if (!input || typeof input !== 'object') throw new Error('Некорректный промокод');
  const code = String(input.code ?? '').trim(), comment = String(input.comment ?? '').trim();
  if (!code || code.length > 40 || !/^[\p{L}\p{N}_-]+$/u.test(code)) throw new Error('В промокоде только буквы, цифры, дефис и подчёркивание');
  if (comment.length > 200) throw new Error('Комментарий не длиннее 200 символов');
  const rub = input.rub === '' || input.rub == null ? 0 : Number(input.rub), pct = input.pct === '' || input.pct == null ? 0 : Number(input.pct), gift = !!input.gift;
  if (!Number.isInteger(rub) || rub < 0 || rub > 1_000_000) throw new Error('Скидка в рублях — целое число от 0 до 1 000 000');
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100 || Math.round(pct * 100) !== pct * 100) throw new Error('Скидка в процентах — число от 0 до 99,99');
  if (rub > 0 && pct > 0) throw new Error('Выберите одну скидку: либо в рублях, либо в процентах');
  if (!rub && !pct && !gift) throw new Error('Укажите скидку или включите подарок');
  return {code, comment, rub, pct, gift, active: input.active !== false};
}

function promoUsage(orders: any[]) {
  const stats = new Map();
  for (const order of orders) { const code = String(order.description || '').match(/\|\s*Промо:\s*([^|]+)/)?.[1]; if (!code) continue; const key = normalizeCode(code); const stat = stats.get(key) || {orders: 0, amount: 0, last: null}; stat.orders++; stat.amount += Number(order.amount) || 0; if (!stat.last || order.created_at > stat.last) stat.last = order.created_at; stats.set(key, stat); }
  return stats;
}

const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
function exportCSV(products: any[], kind: 'trees' | 'decor') {
  // У декора колонка category появилась не сразу — фронтенд (src/catalog/sheets.js) её
  // всегда искал (для селектора «Тип» у декора вроде венков), но раньше она не экспортировалась,
  // и v.category всегда приходил пустым — второй селект никогда не появлялся.
  const columns = kind === 'trees' ? ['id','title','category','height_cm','price','diameter_cm','branches','offer','discount_pct','photos','active','description'] : ['id','title','category','price','variants','photos','active','description'];
  return [columns.map(cell).join(','), ...products.filter(p => p.kind === kind).flatMap(p => p.variants.map((v: any) => columns.map(h => cell(h === 'id' ? p.sku : h === 'title' ? p.title : h === 'active' ? (v.active ? 'TRUE' : 'FALSE') : h === 'photos' ? v.photos.join(' | ') : v[h])).join(',')))].join('\r\n') + '\r\n';
}
function exportPromoCSV(promos: any[]) { return [['promocode','Комментарий','ruble-offer','percent-offer','gift-offer'].map(cell).join(','), ...promos.filter(p => p.active).map(p => [p.code,p.comment,p.rub || 0,p.pct || 0,p.gift ? 'Сумка для хранения' : ''].map(cell).join(','))].join('\r\n') + '\r\n'; }

async function uploadFeed(filename: string, csv: string) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${FEED_BUCKET}/${filename}`, {
    method: 'POST',
    headers: {apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'x-upsert': 'true'},
    body: csv,
  });
  if (!res.ok) throw Object.assign(new Error(`Не удалось обновить готовый файл ${filename}`), {status: 502});
}

async function publishFeeds() {
  const [products, settings, promos] = await Promise.all([listProducts(), getSettings(), listPromos()]);
  const priced = products.map((product: any) => pricedProduct(product, settings));
  await Promise.all([
    uploadFeed('trees.csv', exportCSV(priced, 'trees')),
    uploadFeed('decor.csv', exportCSV(priced, 'decor')),
    uploadFeed('promos.csv', exportPromoCSV(promos)),
  ]);
}

// Запись в базу уже прошла: сбой выгрузки фидов не должен превращаться в ошибку сохранения
// (иначе повтор даёт 409/«артикул уже существует»). 3 попытки; при неудаче — ответ успешный + X-Feed-Warning (как app/server/index.mjs).
const FEED_WARNING = 'Изменения сохранены, но файлы для сайта не обновились (нет связи с Supabase). Сохраните любую карточку ещё раз чуть позже — файлы пересоберутся целиком.';
const FEED_RETRY_DELAY_MS = Number(Deno.env.get('CATALOG_FEED_RETRY_DELAY_MS') || 1000);
async function syncFeeds(req: Request, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { await publishFeeds(); return; }
    catch (error) { console.error(`Не удалось обновить фиды (попытка ${i + 1}): ${(error as Error).message}`); if (i < retries - 1) await new Promise(r => setTimeout(r, FEED_RETRY_DELAY_MS * (i + 1))); }
  }
  extraHeaders.set(req, {...(extraHeaders.get(req) || {}), 'X-Feed-Warning': encodeURIComponent(FEED_WARNING)});
}

async function uploadWebp(data: string) {
  const binary = atob(data), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (bytes.length < 12 || bytes.length > 6 * 1024 * 1024) throw Object.assign(new Error('Размер сжатого фото должен быть до 6 МБ'), {status: 400});
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== 'RIFF' || new TextDecoder().decode(bytes.slice(8, 12)) !== 'WEBP') throw Object.assign(new Error('Фото должно быть сжато в WebP'), {status: 400});
  const filename = `${crypto.randomUUID()}.webp`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/le-catalog-images/${filename}`, {method: 'POST', headers: {apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/webp', 'Cache-Control': '3600'}, body: bytes});
  if (!res.ok) throw Object.assign(new Error('Не удалось загрузить фото в Supabase'), {status: 502});
  return `${SUPABASE_URL}/storage/v1/object/public/le-catalog-images/${filename}`;
}

// GitHub credential lives only in Edge environment; never forwarded to Postgres or clients.
const GITHUB_REPO_API = 'https://api.github.com/repos/arturablyazov5-glitch/lady-elka-cloud-preview';
const GITHUB_RUN_PREFIX = 'https://github.com/arturablyazov5-glitch/lady-elka-cloud-preview/actions/runs/';
const githubHeaders = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
let publishStatusCache: {until: number, data: Json} | null = null;
let publishStatusPending: Promise<Json> | null = null;
async function publishStatus(): Promise<Json> {
  if (publishStatusCache && publishStatusCache.until > Date.now()) return publishStatusCache.data;
  if (publishStatusPending) return publishStatusPending;
  publishStatusPending = (async () => {
    // Public API deliberately receives NO Authorization header.
    const res = await fetch(`${GITHUB_REPO_API}/actions/workflows/catalog-sync.yml/runs?per_page=1&branch=main`,
      {headers: githubHeaders, signal: AbortSignal.timeout(10000)});
    if (!res.ok) throw new Error('status unavailable');
    const body = await res.json(), run = body.workflow_runs?.[0];
    if (!Array.isArray(body.workflow_runs)) throw new Error('invalid runs');
    let lastRun: Json | null = null;
    if (run) {
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isFinite(Date.parse(run.created_at))) throw new Error('invalid run');
      const status = run.status === 'completed' ? (['success', 'neutral', 'skipped'].includes(run.conclusion) ? 'success' : 'failure')
        : run.status === 'in_progress' ? 'in_progress' : 'queued';
      // Whitelist fields and reconstruct link. Never relay GitHub error bodies/URLs.
      lastRun = {id: run.id, date: new Date(run.created_at).toISOString(), status,
        conclusion: ['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral'].includes(run.conclusion) ? run.conclusion : null,
        url: `${GITHUB_RUN_PREFIX}${run.id}`};
    }
    const data = {lastRun};
    publishStatusCache = {until: Date.now() + 25000, data};
    return data;
  })();
  try { return await publishStatusPending; } finally { publishStatusPending = null; }
}
async function publishSite(req: Request) {
  const token = Deno.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) return response(req, 503, {error: 'Обновление сайта ещё не настроено. Обратитесь к администратору.'});
  let gate: any;
  try { gate = await db('rpc/le_catalog_publish_take', {method: 'POST', body: '{}', signal: AbortSignal.timeout(10000)}); }
  catch { console.error('catalog publish: limiter unavailable'); return response(req, 503, {error: 'Обновление сайта временно недоступно. Повторите позже.'}); }
  if (gate?.allowed === false && Number.isFinite(gate.retry_after) && gate.retry_after > 0) {
    const wait = Math.min(60, Math.ceil(gate.retry_after));
    extraHeaders.set(req, {'Retry-After': String(wait)});
    return response(req, 429, {error: `Слишком часто. Повторите через ${wait} с.`, retryAfter: wait});
  }
  if (gate?.allowed !== true) return response(req, 503, {error: 'Обновление сайта временно недоступно. Повторите позже.'});
  try {
    const res = await fetch(`${GITHUB_REPO_API}/dispatches`, {method: 'POST',
      headers: {...githubHeaders, 'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify({event_type: 'catalog_changed'}), signal: AbortSignal.timeout(10000)});
    // Consume no upstream body: it may echo request credentials or internal details.
    await res.body?.cancel().catch(() => {});
    if (res.status !== 204) {
      console.error('catalog publish: GitHub refused dispatch');
      return response(req, 502, {error: 'GitHub не принял обновление сайта. Повторите через минуту или обратитесь к администратору.'});
    }
    publishStatusCache = null;
    return response(req, 202, {accepted: true, message: 'Запрос на обновление сайта принят. Пересборка занимает 5–10 минут. Следите за статусом публикации.'});
  } catch {
    console.error('catalog publish: dispatch response unavailable');
    return response(req, 502, {error: 'Не удалось получить подтверждение GitHub. Проверьте статус публикации перед повтором через минуту.'});
  }
}

Deno.serve(async req => {
  const url = new URL(req.url), route = routeOf(url);
  const publicRead = route === '/feeds/trees.csv' || route === '/feeds/decor.csv' || route === '/feeds/promos.csv' || route === '/pub';
  try {
    const origin = req.headers.get('origin');
    if (!publicRead && origin && !ALLOWED_ORIGINS.has(origin)) return response(req, 403, {error: 'Недопустимый источник запроса'});
    if (req.method === 'OPTIONS') return response(req, 204, '', undefined, publicRead);
    if (publicRead) {
      if (!['GET', 'HEAD'].includes(req.method)) return response(req, 405, {error: 'Только чтение'}, undefined, true);
      const gid = url.searchParams.get('gid');
      if (route === '/feeds/promos.csv' || (route === '/pub' && gid === '301234033')) return response(req, 200, exportPromoCSV(await listPromos()), 'text/csv; charset=utf-8', true);
      const kind = route === '/feeds/decor.csv' || (route === '/pub' && gid === '500105078') ? 'decor' : 'trees';
      const [raw, settings] = await Promise.all([listProducts(), getSettings()]);
      return response(req, 200, exportCSV(raw.map((p: any) => pricedProduct(p, settings)), kind), 'text/csv; charset=utf-8', true);
    }
    if(route==='/billing-webhook' && req.method==='POST'){const b=await jsonBody(req);return response(req,200,await billing.webhook(b.object?.id));}
    if(route==='/billing-renewal' && req.method==='POST'){const secret=Deno.env.get('LE_RENEWAL_SECRET');if(!secret||req.headers.get('x-renewal-secret')!==secret)return response(req,401,{error:'Нет доступа'});return response(req,200,await billing.renew());}
    if (!route.startsWith('/api/')) return response(req, 404, {error: 'Не найдено'});
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('x-catalog-request') !== '1') return response(req, 403, {error: 'Недопустимый запрос'});
    if (route === '/api/login' && req.method === 'POST') {
      const body = await jsonBody(req, LOGIN_BODY_LIMIT);
      const source = await loginSource(req);
      let gate: any;
      try { gate = await db('rpc/le_catalog_login_attempt', {method: 'POST', body: JSON.stringify({p_source: source})}); }
      catch (error) { console.error('Лимит входа недоступен:', (error as Error).message); return response(req, 503, {error: 'Вход временно недоступен. Повторите позже.'}); }
      if (!gate?.allowed) {
        const wait = Math.max(1, Math.ceil(Number(gate?.retry_after) || 60));
        extraHeaders.set(req, {'Retry-After': String(wait)});
        return response(req, 429, {error: `Слишком много попыток входа. Повторите через ${Math.ceil(wait / 60)} мин.`});
      }
      if (!ADMIN_PASSWORD || !(await sameSecret(body.password, ADMIN_PASSWORD))) return response(req, 401, {error: 'Неверный пароль'});
      await db('rpc/le_catalog_login_success', {method: 'POST', body: JSON.stringify({p_source: source})}).catch(error => console.error('Сброс лимита входа:', (error as Error).message));
      return response(req, 200, {ok: true, token: await issueSession()});
    }
    if (!(await validSession(req))) return response(req, 401, {error: 'Войдите для управления каталогом'});
    if (route === '/api/publish-site' && req.method === 'POST') return publishSite(req);
    if (route === '/api/publish-status' && req.method === 'GET') {
      try { return response(req, 200, await publishStatus()); }
      catch { console.error('catalog publish: status unavailable'); return response(req, 502, {error: 'Не удалось проверить последнюю публикацию. Повторите позже.'}); }
    }
    if(route.startsWith('/api/billing/'))return response(req,200,await billing.handle(route.split('/').pop(),req.method,req.method==='POST'?await jsonBody(req):{}));
    if (route === '/api/catalog' && req.method === 'GET') { const [raw, settings] = await Promise.all([listProducts(), getSettings()]); return response(req, 200, {products: raw.map((p: any) => pricedProduct(p, settings)), settings, database: 'Supabase', origin: `${url.origin}/functions/v1/catalog`}); }
    if (route === '/api/photos' && req.method === 'POST') { const body = await jsonBody(req); if (typeof body.data !== 'string') return response(req, 400, {error: 'Выберите фотографию'}); const photoUrl = await uploadWebp(body.data); return response(req, 201, {url: photoUrl, format: 'webp', quality: 80}); }
    if (route === '/api/settings' && req.method === 'PUT') {
      const input = validateSettings(await jsonBody(req)), old = await getSettings();
      if (input.revision !== old.revision) return response(req, 409, {error: 'Настройки изменились в другом окне. Обновите страницу и повторите.'});
      const products = await listProducts(), used = new Set(products.filter((p: any) => p.kind === 'trees').flatMap((p: any) => p.variants.map((v: any) => resolveType(v, old)?.id)));
      if (old.types.some((t: any) => used.has(t.id) && !input.types.some((n: any) => n.id === t.id))) return response(req, 400, {error: 'Нельзя удалить тип, который используется в товарах.'});
      const payload = {discount_pct: input.discount_pct, adjustment_pct: input.adjustment_pct, types: input.types.map((t: any) => { const prior = old.types.find((p: any) => p.id === t.id); return {id: t.id, name: t.name.trim(), aliases: prior ? [...new Set([...(prior.aliases || []), prior.name])] : []}; })};
      const rows = await db(`le_catalog_settings?id=eq.1&revision=eq.${old.revision}`, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify({payload, revision: old.revision + 1, updated_at: new Date().toISOString()})});
      if (!rows.length) return response(req, 409, {error: 'Настройки изменились в другом окне. Обновите страницу.'});
      await syncFeeds(req);
      return response(req, 200, {...rows[0].payload, revision: rows[0].revision});
    }
    if (route === '/api/promos' && req.method === 'GET') { const [promos, orders] = await Promise.all([listPromos(), listPaidOrders()]); const usage = promoUsage(orders); return response(req, 200, {promos: promos.map((p: any) => ({...p, usage: usage.get(normalizeCode(p.code)) || {orders: 0, amount: 0, last: null}})), origin: `${url.origin}/functions/v1/catalog`}); }
    if (route === '/api/promos' && req.method === 'POST') { const rows = await db('le_promo_codes', {method: 'POST', headers: {Prefer: 'return=representation'}, body: JSON.stringify(validatePromo(await jsonBody(req)))}); await syncFeeds(req); return response(req, 201, {...rows[0], rub: Number(rows[0].rub), pct: Number(rows[0].pct)}); }
    if (route.startsWith('/api/promos/') && ['PUT', 'DELETE'].includes(req.method)) {
      const id = decodeURIComponent(route.slice('/api/promos/'.length)); if (!/^[0-9a-f-]{36}$/i.test(id)) return response(req, 400, {error: 'Неверный промокод'});
      if (req.method === 'DELETE') { const rows = await db(`le_promo_codes?id=eq.${id}`, {method: 'DELETE', headers: {Prefer: 'return=representation'}}); if (!rows.length) return response(req, 404, {error: 'Промокод уже удалён'}); await syncFeeds(req); return response(req, 200, {ok: true}); }
      const raw = await jsonBody(req), input = validatePromo(raw); if (!Number.isInteger(raw.revision) || raw.revision < 1) return response(req, 400, {error: 'Неверная версия промокода'});
      const rows = await db(`le_promo_codes?id=eq.${id}&revision=eq.${raw.revision}`, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify({...input, revision: raw.revision + 1, updated_at: new Date().toISOString()})});
      if (!rows.length) return response(req, 409, {error: 'Промокод изменён в другом окне.'});
      await syncFeeds(req);
      return response(req, 200, {...rows[0], rub: Number(rows[0].rub), pct: Number(rows[0].pct)});
    }
    if (route === '/api/products' && req.method === 'POST') { const settings = await getSettings(), p = prepareProduct(await jsonBody(req), settings), {revision: _r, updated_at: _u, ...payload} = p; const rows = await db('le_catalog_products', {method: 'POST', headers: {Prefer: 'return=representation'}, body: JSON.stringify({id: p.id, payload})}); await syncFeeds(req); return response(req, 201, {...rows[0].payload, revision: rows[0].revision, updated_at: rows[0].updated_at}); }
    if (route.startsWith('/api/products/') && req.method === 'PUT') { const id = decodeURIComponent(route.slice('/api/products/'.length)), settings = await getSettings(), p = prepareProduct(await jsonBody(req), settings); if (p.id !== id || !Number.isInteger(p.revision) || p.revision < 1) return response(req, 400, {error: 'Неверная версия товара'}); const {revision, updated_at: _u, ...payload} = p; const rows = await db(`le_catalog_products?id=eq.${encodeURIComponent(id)}&revision=eq.${revision}`, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify({payload, revision: revision + 1, updated_at: new Date().toISOString()})}); if (!rows.length) return response(req, 409, {error: 'Товар уже изменён в другом окне.'}); await syncFeeds(req); return response(req, 200, {...rows[0].payload, revision: rows[0].revision, updated_at: rows[0].updated_at}); }
    if (route.startsWith('/api/products/') && req.method === 'DELETE') { const id = decodeURIComponent(route.slice('/api/products/'.length)); const rows = await db(`le_catalog_products?id=eq.${encodeURIComponent(id)}`, {method: 'DELETE', headers: {Prefer: 'return=representation'}}); if (!rows.length) return response(req, 404, {error: 'Товар уже удалён'}); await syncFeeds(req); return response(req, 200, {ok: true}); }
    return response(req, 404, {error: 'Не найдено'});
  } catch (error) {
    console.error(error);
    return response(req, Number((error as any).status) || (error instanceof TypeError ? 502 : 400), {error: (error as Error).message || 'Ошибка сервера'}, undefined, publicRead);
  }
});
