// Общие функции миграции фото со старого сайта lady-elka.ru в Supabase.
// Ключ service_role берётся из окружения (SUPABASE_SERVICE_ROLE_KEY) или из supabase CLI
// (`supabase projects api-keys`) только в память процесса — никуда не печатается и не пишется.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REF = 'mgnotvaahftrbifqtahf';
export const SUPABASE_URL = `https://${REF}.supabase.co`;
export const IMAGE_BUCKET = 'le-catalog-images';
export const OLD_SITE = 'https://lady-elka.ru';
export const UA = 'Mozilla/5.0 (LadyElka photo migration; owner-run)';
export const CTX = path.join(ROOT, 'agent-context');
export const WORK = path.join(ROOT, 'agent-context', 'photos-work'); // кэш скачанного (не секрет)
export const sleep = ms => new Promise(r => setTimeout(r, ms));

let cachedKey = null;
export function serviceKey() {
  if (cachedKey) return cachedKey;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return (cachedKey = process.env.SUPABASE_SERVICE_ROLE_KEY);
  const out = execFileSync('supabase', ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  const key = JSON.parse(out).find(k => k.name === 'service_role')?.api_key;
  if (!key) throw new Error('Нет service_role ключа (supabase CLI не залогинен?)');
  return (cachedKey = key);
}
const auth = () => ({apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`});

export async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {...init, headers: {...auth(), 'Content-Type': 'application/json', ...(init.headers || {})}});
  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const listProducts = () => rest('le_catalog_products?select=id,payload,revision,updated_at&order=created_at.asc,id.asc');

export async function listBucket() {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${IMAGE_BUCKET}`, {method: 'POST', headers: {...auth(), 'Content-Type': 'application/json'}, body: JSON.stringify({prefix: '', limit: 10000})});
  if (!res.ok) throw new Error(`list ${res.status}`);
  return new Set((await res.json()).map(o => o.name));
}

// Загрузка без x-upsert: существующий объект НЕ перезаписывается (Supabase вернёт 400/409 Duplicate).
export async function uploadObject(name, bytes, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${name}`, {method: 'POST', headers: {...auth(), 'Content-Type': contentType, 'Cache-Control': '3600'}, body: bytes});
  if (res.ok) return 'uploaded';
  const text = await res.text();
  if (/Duplicate|already exists/i.test(text)) return 'exists';
  throw new Error(`upload ${name} ${res.status}: ${text.slice(0, 200)}`);
}
export const publicUrl = name => `${SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${name}`;

export async function checkUrl(url) {
  try {
    let res = await fetch(url, {method: 'HEAD', redirect: 'follow', headers: {'User-Agent': UA}, signal: AbortSignal.timeout(20000)});
    if (res.status === 405 || res.status === 403) res = await fetch(url, {headers: {'User-Agent': UA, Range: 'bytes=0-0'}, signal: AbortSignal.timeout(20000)});
    const type = res.headers.get('content-type') || '';
    return {ok: res.ok && /^image\//.test(type), status: res.status, type};
  } catch (e) { return {ok: false, status: 0, error: String(e.message || e)}; }
}

export function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export function writeJSON(file, data) { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(file + '.tmp', file); }
export function progress(line) { fs.appendFileSync(path.join(CTX, 'progress-photos.md'), `- ${new Date().toISOString()} ${line}\n`); }
export const norm = s => String(s || '').toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
