import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { payDatabase } from './helpers.mjs';

test('order admission: bounded adapters and closed new orders', async t => {
  const db = await payDatabase();
  t.after(() => db.db.close());
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; });
  const env = { TG_BOT_TOKEN: 'synthetic', TG_CHAT_IDS: 'first,second', SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic', ALFA_API_USER: 'synthetic', ALFA_API_PASS: 'synthetic' };
  globalThis.Deno = { env: { get: key => env[key] }, serve() {}, createHttpClient: () => ({}) };
  const source = await readFile('supabase/functions/pay/index.ts', 'utf8');
  const compiled = await build({ stdin: { contents: source + '\nexport { handler, boundedRequestBody, readBodyAny, routePay, routeCodOrder, orderStore };',
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
  const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  env.ORDER_INPUT_MAX_BYTES = '1024';
  let calls = 0, registers = 0, sends = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (url.startsWith('https://db.example.test/rest/v1/')) return db.request(url.split('/rest/v1/')[1], options);
    if (url.endsWith('/trees.csv')) return new Response('id,title,active,category,height_cm,price\n1,Tree,1,Green,180,1000\n');
    if (url.endsWith('/register.do')) { registers++; return Response.json({ formUrl: 'https://payment.example.test/', orderId: 'synthetic-payment' }); }
    if (url.startsWith('https://api.telegram.org/')) { sends++; return Response.json({ ok: true, result: { message_id: 1 } }); }
    throw new Error('Unmocked network blocked');
  };
  const event = body => ({ httpMethod: 'POST', path: '/pay', headers: { 'content-type': 'application/json' }, queryStringParameters: { action: 'create-cod-order' }, body });
  for (const body of ['x'.repeat(1025), 'я'.repeat(513)]) assert.equal((await api.handler(event(body))).statusCode, 413);
  assert.equal((await api.handler(event('{'))).statusCode, 400);
  assert.equal((await api.handler(event('[]'))).statusCode, 400);
  assert.equal((await api.handler({ ...event('{}'), httpMethod: 'GET' })).statusCode, 405);
  assert.equal((await api.handler({ ...event('{}'), headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  for (const encoding of ['base64', 'base64url']) {
    assert.equal((await api.handler({ ...event(Buffer.from('я'.repeat(513)).toString(encoding)), isBase64Encoded: true })).statusCode, 413);
    assert.deepEqual((await api.readBodyAny({ ...event(Buffer.from('{"text":"✓"}').toString(encoding)), isBase64Encoded: true })).data, { text: '✓' });
  }
  assert.equal((await api.handler({ ...event('%%%'), isBase64Encoded: true })).statusCode, 400);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(600)); }, cancel() { cancelled = true; } });
  await assert.rejects(api.boundedRequestBody(new Request('http://localhost/pay', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-length': '1' } })), /Payload Too Large/);
  assert.equal(cancelled, true);
  assert.equal(await api.boundedRequestBody(new Request('http://localhost/pay', { method: 'POST', body: '{"a":1}' })), '{"a":1}');
  // Manual notification relay stays closed when HOOK_SECRET is not configured.
  assert.equal((await api.handler({ ...event(JSON.stringify({ paid: true, status: 'paid', invoice_id: 'x' })),
    queryStringParameters: { action: 'send-notification' } })).statusCode, 401);
  assert.equal(calls, 0);
  const payload = { paymentMethod: 'cash_on_delivery', orderId: 'LE-1234567890123-180', amount: 1000,
    customer: { name: 'Test', email: 'test@example.test', phone: '+79991234567', contactPref: 'Telegram' }, delivery: { address: 'Test' },
    items: [{ kind: 'tree', productId: '1', variantId: '1:Green:180', quantity: 1, price: 1000 }] };
  const card = { ...payload, paymentMethod: 'card', orderId: 'LE-1234567890123-181' };
  env.NEW_ORDER_ADMISSION = 'closed';
  assert.equal((await api.routeCodOrder(payload, {})).statusCode, 503);
  assert.equal((await api.routePay(card, {})).statusCode, 503);
  assert.equal((await db.db.query('select count(*)::int as n from le_orders')).rows[0].n, 0);
  assert.equal(registers + sends, 0);
  delete env.NEW_ORDER_ADMISSION;
  assert.equal((await api.routeCodOrder(payload, {})).statusCode, 200);
  assert.equal((await api.routePay(card, {})).statusCode, 200);
  env.NEW_ORDER_ADMISSION = 'closed';
  const effectCount = registers + sends;
  assert.equal(JSON.parse((await api.routeCodOrder(payload, {})).body).duplicate, true);
  assert.equal(JSON.parse((await api.routePay(card, {})).body).duplicate, true);
  assert.equal((await api.routeCodOrder({ ...payload, amount: 2000 }, {})).statusCode, 409);
  assert.equal((await api.routePay({ ...card, amount: 2000 }, {})).statusCode, 409);
  assert.equal(registers + sends, effectCount);
  for (const state of ['running', 'unknown']) {
    await db.db.query("update le_orders set result=null where order_id=$1", [card.orderId]);
    await db.db.query("update le_order_effects set state=$1 where effect_key=$2", [state, `bank:${card.orderId}`]);
    const result = await api.routePay(card, {});
    assert.equal(result.statusCode, 409);
    assert.equal(JSON.parse(result.body).status, 'pending_review');
    assert.equal(registers + sends, effectCount);
  }
  // Form callback parser remains available under closed admission.
  assert.deepEqual((await api.readBodyAny({ body: 'id=123&sum=1000', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).data, { id: '123', sum: '1000' });
});
