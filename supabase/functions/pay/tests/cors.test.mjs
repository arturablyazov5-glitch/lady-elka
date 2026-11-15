import test from 'node:test';
import assert from 'node:assert/strict';
import { payDatabase, loadPay } from './helpers.mjs';
import { postJson, RequestFailure } from '../../../../storefront/client/request-errors.js';

test('pay runtime exposes Retry-After on success, errors and preflight', async t => {
  const db = await payDatabase();
  t.after(() => db.db.close());
  const saved = { fetch: globalThis.fetch, Deno: globalThis.Deno, error: console.error, log: console.log };
  t.after(() => { globalThis.fetch = saved.fetch; globalThis.Deno = saved.Deno; console.error = saved.error; console.log = saved.log; });
  console.error = console.log = () => {};
  const env = { CORS_ORIGIN: 'https://lady-elka.ru,https://www.lady-elka.ru', SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic', TG_BOT_TOKEN: 'synthetic', TG_CHAT_IDS: '101',
    ALFA_API_USER: 'synthetic', ALFA_API_PASS: 'synthetic', HOOK_SECRET: 'synthetic', ORDER_RATE_LIMIT_IP: '1/600' };
  let serve, crashOnce = false, rpcDown = false, registrations = 0;
  globalThis.Deno = { env: { get: key => {
    if (key === 'CORS_ORIGIN' && crashOnce) { crashOnce = false; throw new Error('Synthetic handler crash'); }
    return env[key];
  } }, serve: fn => { serve = fn; }, createHttpClient: () => ({}) };
  await loadPay(['handler']);
  globalThis.fetch = async (url, options) => {
    url = String(url);
    if (url.startsWith('https://db.example.test/rest/v1/')) {
      const path = url.split('/rest/v1/')[1];
      if (rpcDown && path === 'rpc/le_rate_limit_take') return new Response(null, { status: 503 });
      return db.request(path, options);
    }
    if (url.endsWith('/trees.csv')) return new Response('id,title,active,category,height_cm,price\n1,Tree,1,Green,180,1000\n');
    if (url.endsWith('/register.do')) return Response.json({ formUrl: 'https://payment.example.test/', orderId: `synthetic-payment-${++registrations}` });
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: { message_id: 1 } });
    throw new Error('Unmocked network blocked');
  };
  let sequence = 0;
  for (const origin of env.CORS_ORIGIN.split(',')) {
    const payload = method => ({ orderId: `LE-1234567890123-${++sequence}`, paymentMethod: method, amount: 1000, description: 'Tree',
      customer: { name: 'Test', email: 'test@example.test', phone: '+79991234567', contactPref: 'Telegram' }, delivery: { address: 'Test' },
      items: [{ kind: 'tree', productId: '1', variantId: '1:Green:180', quantity: 1, price: 1000 }] });
    const request = (data = {}, options = {}) => new Request('https://edge.example.test/pay', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.5' },
      body: JSON.stringify(data), ...options,
    });
    const check = async (req, status) => {
      const response = await serve(req);
      assert.equal(response.status, status, await response.clone().text());
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
      return response;
    };
    await check(request({}, { method: 'OPTIONS', body: undefined }), 204);
    await check(request({}, { method: 'GET', body: undefined }), 404);
    await check(new Request('https://edge.example.test/pay?action=pay', { headers: { Origin: origin } }), 405);
    await check(request({}, { body: '{' }), 400);
    await check(request(), 401);
    await check(request(payload('card'), { headers: { Origin: origin, 'Content-Type': 'text/plain' } }), 415);
    env.ORDER_INPUT_MAX_BYTES = '1024';
    await check(request({}, { body: 'x'.repeat(1025) }), 413);
    delete env.ORDER_INPUT_MAX_BYTES;
    env.NEW_ORDER_ADMISSION = 'closed';
    await check(request(payload('card')), 503);
    delete env.NEW_ORDER_ADMISSION;
    rpcDown = true;
    await check(request(payload('card')), 503);
    rpcDown = false;
    // Reset only the synthetic database so each allowed origin exercises the same limiter path.
    await db.db.exec('delete from le_rate_limits');
    const card = payload('card');
    await check(request(card), 200);
    await check(request({ ...card, amount: 2000 }), 409);
    const limited = await check(request(payload('card')), 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    const exposed = limited.headers.get('Access-Control-Expose-Headers').toLowerCase().split(',').map(s => s.trim());
    const visibleHeaders = new Headers([...limited.headers].filter(([name]) => exposed.includes(name)));
    await assert.rejects(postJson('https://edge.example.test/pay', {}, {
      fetchImpl: async () => new Response(await limited.text(), { status: 429, headers: visibleHeaders }),
    }), error => error instanceof RequestFailure && error.retryAfter > 0);
    await db.db.exec('delete from le_rate_limits');
    await check(request({ ...payload('cash_on_delivery'), action: 'create-cod-order' }), 200);
    // pay uses 200 for successful intake; pending notifications have separate error statuses, no 202 branch.
    crashOnce = true;
    await check(request(), 500);
  }
});
