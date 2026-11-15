import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('pay handler rejects stale catalog prices, invalid quantities, and client totals', async t => {
  const originalFetch = globalThis.fetch;
  const originalDeno = globalThis.Deno;
  const originalConsoleError = console.error;
  const env = {
    CORS_ORIGIN: '*',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key',
  };
  let handle;
  let catalogPrice = 1000;
  globalThis.Deno = {
    env: { get: key => env[key] },
    serve: callback => { handle = callback; },
    createHttpClient: () => ({}),
  };
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = originalDeno;
    console.error = originalConsoleError;
  });

  const compiled = await build({ entryPoints: ['supabase/functions/pay/index.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false });
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

  globalThis.fetch = async url => {
    // Order admission rate limiter (fail-closed since 20261008160000_order_rate_limits): 0 = admitted.
    if (String(url).includes('/rest/v1/rpc/le_rate_limit_take')) return new Response('0', { status: 200 });
    if (String(url).includes('/rest/v1/')) return new Response('[]', { status: 200 });
    if (String(url).endsWith('/trees.csv')) return new Response(
      `id,title,active,category,height_cm,price\r\n1,Миранда,TRUE,Зелёная,180,${catalogPrice}\r\n`, { status: 200 });
    throw new Error(`Unexpected request: ${url}`);
  };

  const makePayload = (orderId, { quantity = 1, price = 1000, amount = 1000 } = {}) => ({
    action: 'create-cod-order', paymentMethod: 'cash_on_delivery', orderId,
    customer: { name: 'Иван', email: 'ivan@example.org', phone: '+79991234567', contactPref: 'Telegram' },
    delivery: { address: 'Москва' },
    items: [{ kind: 'tree', productId: '1', variantId: '1:Зелёная:180', quantity, price }],
    amount,
  });
  const request = async payload => handle(new Request('https://example.org/functions/v1/pay?action=create-cod-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }));

  assert.equal((await request(makePayload('LE-1234567890201-180', { quantity: 0 }))).status, 400);
  assert.equal((await request(makePayload('LE-1234567890202-180', { amount: 999 }))).status, 409);
  catalogPrice = 1200;
  assert.equal((await request(makePayload('LE-1234567890203-180'))).status, 409);
});
