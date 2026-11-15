// Офлайн: edge supabase/functions/catalog с моками Deno/fetch. Сценарий «запись прошла, выгрузка фидов упала».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

async function loadEdge(storageStatus) {
  const values = {SUPABASE_URL: 'https://offline.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', CATALOG_ADMIN_PASSWORD: 'synthetic-admin', CATALOG_SESSION_SECRET: 'synthetic-session', CATALOG_ALLOWED_ORIGINS: 'http://localhost:4180', CATALOG_FEED_RETRY_DELAY_MS: '1'};
  let handler; const calls = [];
  globalThis.Deno = {env: {get: k => values[k]}, serve: fn => { handler = fn; }};
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url), method = options.method || 'GET'; calls.push({path: u.pathname, method});
    if (u.pathname.startsWith('/storage/v1/object/le-catalog-feeds/')) return new Response('{}', {status: storageStatus()});
    if (u.pathname === '/rest/v1/le_promo_codes' && method === 'POST') return Response.json([{id: '00000000-0000-4000-8000-000000000001', ...JSON.parse(options.body), revision: 1}]);
    if (u.pathname === '/rest/v1/le_catalog_settings') return Response.json([{payload: {discount_pct: 0, adjustment_pct: 0, types: [{id: 'green', name: 'Зелёная'}]}, revision: 1}]);
    if (u.pathname === '/rest/v1/rpc/le_catalog_login_attempt') return Response.json({allowed: true});
    if (u.pathname === '/rest/v1/rpc/le_catalog_login_success') return new Response('', {status: 204});
    if (u.pathname.startsWith('/rest/v1/')) return Response.json([]);
    throw new TypeError('unexpected ' + url);
  };
  let code = await fs.readFile(new URL('../../supabase/functions/catalog/index.ts', import.meta.url), 'utf8');
  code = code.replace("'../_shared/billing-store.mjs'", JSON.stringify(new URL('../../supabase/functions/_shared/billing-store.mjs', import.meta.url).href));
  await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code) + `\n//${Math.random()}`).toString('base64'));
  const base = 'https://offline.invalid/functions/v1/catalog', origin = 'http://localhost:4180';
  const login = await handler(new Request(base + '/api/login', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', 'X-Catalog-Request': '1'}, body: JSON.stringify({password: values.CATALOG_ADMIN_PASSWORD})}));
  const {token} = await login.json();
  const createPromo = () => handler(new Request(base + '/api/promos', {method: 'POST', headers: {Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Catalog-Request': '1'}, body: JSON.stringify({code: 'QAFEED', pct: 10})}));
  return {calls, createPromo};
}

test('catalog edge: saved write + failing feed upload → 3 attempts, 201 with exposed X-Feed-Warning (no 502)', async () => {
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  try {
    const failing = await loadEdge(() => 500);
    const response = await failing.createPromo();
    assert.equal(response.status, 201);
    assert.equal((await response.json()).code, 'QAFEED');
    assert.match(decodeURIComponent(response.headers.get('X-Feed-Warning')), /Изменения сохранены, но файлы для сайта не обновились/);
    assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-Feed-Warning/);
    assert.equal(failing.calls.filter(c => c.path === '/rest/v1/le_promo_codes' && c.method === 'POST').length, 1, 'write not repeated');
    assert.equal(failing.calls.filter(c => c.path === '/storage/v1/object/le-catalog-feeds/promos.csv').length, 3, '3 attempts');

    let n = 0;
    const flaky = await loadEdge(() => (++n <= 3 ? 500 : 200));
    const recovered = await flaky.createPromo();
    assert.equal(recovered.status, 201); assert.equal(recovered.headers.get('X-Feed-Warning'), null);

    const healthy = await loadEdge(() => 200);
    const ok = await healthy.createPromo();
    assert.equal(ok.status, 201); assert.equal(ok.headers.get('X-Feed-Warning'), null);
    assert.equal(healthy.calls.filter(c => c.path.startsWith('/storage/v1/object/le-catalog-feeds/')).length, 3);
  } finally { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; }
});
