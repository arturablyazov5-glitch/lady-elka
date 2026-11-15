// Офлайн: edge supabase/functions/catalog + настоящая миграция лимита входа в PGlite (общее хранилище вместо памяти инстанса).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {PGlite} from '@electric-sql/pglite';

const base = 'https://offline.invalid/functions/v1/catalog';
async function loadEdge(rpc) {
  const values = {SUPABASE_URL: 'https://offline.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', CATALOG_ADMIN_PASSWORD: 'synthetic-admin', CATALOG_SESSION_SECRET: 'synthetic-session', CATALOG_ALLOWED_ORIGINS: 'http://localhost:4180'};
  let handler;
  globalThis.Deno = {env: {get: k => values[k]}, serve: fn => { handler = fn; }};
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/rest/v1/rpc/')) return rpc(u.pathname.slice('/rest/v1/rpc/'.length), JSON.parse(options.body));
    return Response.json([]);
  };
  let code = await fs.readFile(new URL('../../supabase/functions/catalog/index.ts', import.meta.url), 'utf8');
  code = code.replace("'../_shared/billing-store.mjs'", JSON.stringify(new URL('../../supabase/functions/_shared/billing-store.mjs', import.meta.url).href));
  await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code) + `\n//${Math.random()}`).toString('base64'));
  return handler;
}
const login = (handler, password, ip = '203.0.113.7', init = {}) => handler(new Request(base + '/api/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Catalog-Request': '1', 'X-Forwarded-For': ip, ...init.headers}, body: init.body ?? JSON.stringify({password}), ...(init.duplex ? {duplex: 'half'} : {})}));

async function sqlBackend() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const migration = await fs.readFile(new URL('../../supabase/migrations/20261008150000_catalog_login_limit.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration); // idempotent
  const rpc = async (name, body) => {
    assert.ok(['le_catalog_login_attempt', 'le_catalog_login_success'].includes(name));
    const {rows} = await db.query(`select public.${name}($1) as r`, [body.p_source]);
    return name === 'le_catalog_login_success' ? new Response('', {status: 204}) : Response.json(rows[0].r);
  };
  return {db, rpc};
}

test('login brute force: shared DB counter per source, backoff with 429/Retry-After, success resets, global budget', async () => {
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno, {db, rpc} = await sqlBackend();
  try {
    const handler = await loadEdge(rpc);
    for (let i = 0; i < 5; i++) assert.equal((await login(handler, 'wrong-' + i)).status, 401);
    const blocked = await login(handler, 'wrong-6');
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('Retry-After'), '30');
    assert.match((await blocked.json()).error, /Слишком много попыток/);
    assert.equal((await login(handler, 'synthetic-admin')).status, 429, 'correct password is not checked while blocked');
    // Another Edge instance (fresh module, same DB) sees the same counter.
    const second = await loadEdge(rpc);
    assert.equal((await login(second, 'wrong-x')).status, 429);
    // Other source unaffected; success clears its own counter.
    assert.equal((await login(second, 'wrong', '198.51.100.2')).status, 401);
    assert.equal((await login(second, 'synthetic-admin', '198.51.100.2')).status, 200);
    assert.equal((await db.query(`select count(*)::int as n from le_catalog_login_limits where key like 'src:%' and attempts > 0`)).rows[0].n, 1);
    // After the block expires the next failure doubles the wait (exponential backoff).
    await db.exec(`update le_catalog_login_limits set blocked_until = now() - interval '1 second' where key like 'src:%' and blocked_until is not null`);
    assert.equal((await login(handler, 'wrong-7')).status, 401);
    assert.equal((await login(handler, 'wrong-8')).headers.get('Retry-After'), '60');
    // Raw IPs are never stored.
    assert.equal((await db.query(`select count(*)::int as n from le_catalog_login_limits where key like '%203.0.113%'`)).rows[0].n, 0);
    // Global budget: rotating/spoofed sources are capped at 100 attempts per 15 minutes in total.
    await db.exec(`update le_catalog_login_limits set attempts = 100, window_start = now() where key = 'global'`);
    const global = await login(handler, 'synthetic-admin', '192.0.2.99');
    assert.equal(global.status, 429); assert.ok(Number(global.headers.get('Retry-After')) > 800);
    await db.exec(`update le_catalog_login_limits set window_start = now() - interval '16 minutes' where key = 'global'`);
    assert.equal((await login(handler, 'synthetic-admin', '192.0.2.99')).status, 200);
    // Parallel attempts from one new source cannot pass more than 5 password checks.
    const statuses = (await Promise.all(Array.from({length: 12}, (_, i) => login(handler, 'p' + i, '192.0.2.50')))).map(r => r.status);
    assert.equal(statuses.filter(s => s === 401).length, 5); assert.equal(statuses.filter(s => s === 429).length, 7);
    // Anon/authenticated roles cannot read or call the limiter.
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(db.exec(`set role ${role}; select * from public.le_catalog_login_limits;`)); await db.exec('reset role');
      await assert.rejects(db.exec(`set role ${role}; select public.le_catalog_login_attempt(repeat('a',64));`)); await db.exec('reset role');
    }
  } finally { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; await db.close(); }
});

test('login fails closed (503) when the shared limiter is unavailable', async () => {
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  try {
    const handler = await loadEdge(async () => Response.json({message: 'function not found'}, {status: 404}));
    assert.equal((await login(handler, 'synthetic-admin')).status, 503);
  } finally { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; }
});

test('body limit counts bytes while streaming and cancels early; login has a small separate limit', async () => {
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  try {
    let rpcCalls = 0;
    const handler = await loadEdge(async () => { rpcCalls++; return Response.json({allowed: true}); });
    let pulled = 0, cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream({pull(controller) { if (pulled >= 16 * 1024 * 1024) return controller.close(); pulled += chunk.byteLength; controller.enqueue(chunk); }, cancel() { cancelled = true; }}, {highWaterMark: 0});
    const big = await login(handler, '', undefined, {body: stream, duplex: true});
    assert.equal(big.status, 413); assert.ok(cancelled, 'stream cancelled'); assert.ok(pulled <= 2 * chunk.byteLength, `read ${pulled} bytes`);
    // Declared Content-Length above the limit is rejected before reading.
    let touched = false;
    const declared = new ReadableStream({pull() { touched = true; }}, {highWaterMark: 0});
    assert.equal((await login(handler, '', undefined, {body: declared, duplex: true, headers: {'Content-Length': '5000'}})).status, 413); assert.equal(touched, false);
    // Lying small Content-Length does not bypass the byte count.
    assert.equal((await login(handler, '', undefined, {body: JSON.stringify({password: 'x'.repeat(5000)}), headers: {'Content-Length': '1'}})).status, 413);
    // Multi-byte UTF-8: limit is in bytes, not characters (2100 × 2-byte «ё» = 4200 B > 4096, but < 4096 chars).
    assert.equal((await login(handler, '', undefined, {body: JSON.stringify({password: 'ё'.repeat(2100)})})).status, 413);
    assert.equal(rpcCalls, 0, 'oversized bodies never reach the limiter or password check');
    assert.equal((await login(handler, 'wrong')).status, 401);
  } finally { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; }
});
