import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { payDatabase } from './helpers.mjs';

test('offline payment hardening: evidence, return contract, snapshots and redirect guard', async t => {
  const db = await payDatabase();
  t.after(() => db.db.close());
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; });
  const env = { TG_BOT_TOKEN: 'synthetic', TG_CHAT_IDS: 'first,second', SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic', ALFA_API_USER: 'synthetic', ALFA_API_PASS: 'synthetic', HOOK_SECRET: 'synthetic-hook-secret' };
  globalThis.Deno = { env: { get: key => env[key] }, serve() {}, createHttpClient: () => ({}) };
  const source = await readFile('supabase/functions/pay/index.ts', 'utf8');
  const compiled = await build({ stdin: { contents: source + '\nexport { alfaPaymentEvidence, paymentReturnUrl, checkedFetch, routePay, routeCodOrder, pollAlfaOrder, routeHook };',
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
  const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const evidence = { orderStatus: 2, orderNumber: 'LE-1234567890123-180', amount: 100000 };
  assert.deepEqual(api.alfaPaymentEvidence(evidence), { orderNumber: evidence.orderNumber, amount: 100000 });
  for (const invalid of [ { orderStatus: 2 }, { ...evidence, orderNumber: undefined }, { ...evidence, amount: undefined },
    { ...evidence, amount: '' }, { ...evidence, amount: -1 }, { ...evidence, amount: 1.2 },
    { ...evidence, paymentAmountInfo: { depositedAmount: 90000 } }, { ...evidence, paymentState: 'CREATED' },
    { ...evidence, orderStatus: 0, paymentState: 'DEPOSITED' } ]) assert.equal(api.alfaPaymentEvidence(invalid), null);
  assert.equal(api.alfaPaymentEvidence({ ...evidence, orderId: 'wrong' }, 'expected'), null);
  assert.ok(api.alfaPaymentEvidence({ orderNumber: 'x', paymentAmountInfo: { paymentState: 'DEPOSITED', depositedAmount: '100000' } }));
  const oid = evidence.orderNumber;
  assert.equal(api.paymentReturnUrl(`http://localhost:4176/spasibo?oid=${oid}`, false, oid), `http://localhost:4176/spasibo?oid=${oid}`);
  assert.equal(api.paymentReturnUrl(`https://lady-elka.ru/spasibo/?oid=${oid}`, false, oid), `https://lady-elka.ru/spasibo/?oid=${oid}`);
  assert.equal(api.paymentReturnUrl(`https://lady-elka.ru/pay-return/?fail=1&oid=${oid}`, true, oid), `https://lady-elka.ru/pay-return/?fail=1&oid=${oid}`);
  assert.throws(() => api.paymentReturnUrl('https://lady-elka.ru/spasibo//', false, oid));
  for (const url of ['https://evil.test/spasibo', 'https://lady-elka.ru/else', 'https://lady-elka.ru/spasibo?next=https://evil.test',
    'https://lady-elka.ru/spasibo#x', 'https://user@lady-elka.ru/spasibo', 'http://localhost:9999/spasibo',
    'https://lady-elka.ru/spasibo?oid=other', 'https://lady-elka.ru/spasibo?oid=x&oid=x']) assert.throws(() => api.paymentReturnUrl(url, false, oid));
  let fetchCount = 0;
  env.LOCAL_INTEGRATION_NETWORK_GUARD = '1';
  globalThis.fetch = async (url, options) => { fetchCount++; assert.equal(options.redirect, 'error'); throw new TypeError('synthetic redirect rejected'); };
  await assert.rejects(api.checkedFetch('http://kong:8000/redirect', { redirect: 'follow' }));
  assert.throws(() => api.checkedFetch('https://evil.test/', {}));
  assert.equal(fetchCount, 1);
  delete env.LOCAL_INTEGRATION_NETWORK_GUARD;
  let bank = evidence, sends = [], registers = 0, rejectSecond = true;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/rest/v1/')) return db.request(url.split('/rest/v1/')[1], options);
    if (url.endsWith('/trees.csv')) return new Response('id,title,active,category,height_cm,price\n1,Tree,1,Green,180,1000\n');
    if (url.endsWith('/register.do')) { registers++; return new Response(JSON.stringify({ formUrl: 'https://payment.example.test/', orderId: 'synthetic-payment' })); }
    if (url.endsWith('/getOrderStatusExtended.do')) return Response.json(bank);
    if (url.includes('api.telegram.org')) {
      const body = JSON.parse(options.body); sends.push(body.chat_id);
      return Response.json(body.chat_id === 'second' && rejectSecond ? { ok: false, description: 'synthetic rejection' } : { ok: true, result: { message_id: 1 } }, { status: body.chat_id === 'second' && rejectSecond ? 400 : 200 });
    }
    throw new Error('Unmocked network request blocked');
  };
  const payload = { paymentMethod: 'card', orderId: oid, amount: 1000, customer: { name: 'Test', email: 'test@example.test', phone: '+79991234567', contactPref: 'Telegram' },
    delivery: { address: 'Test' }, items: [{ kind: 'tree', productId: '1', variantId: '1:Green:180', quantity: 1, price: 1000 }] };
  env.TG_BOT_TOKEN = '';
  assert.equal((await api.routeCodOrder({ ...payload, paymentMethod: 'cash_on_delivery' }, {})).statusCode, 503);
  assert.equal((await db.db.query('select count(*)::int as n from le_orders')).rows[0].n, 0);
  assert.equal((await api.routePay(payload, {})).statusCode, 503);
  assert.equal(registers, 0);
  env.TG_BOT_TOKEN = 'synthetic';
  env.TG_CHAT_IDS = ' , ';
  assert.equal((await api.routeCodOrder({ ...payload, paymentMethod: 'cash_on_delivery' }, {})).statusCode, 503);
  assert.equal((await db.db.query('select count(*)::int as n from le_orders')).rows[0].n, 0);
  env.TG_CHAT_IDS = 'first,second';
  assert.equal((await api.routePay(payload, {})).statusCode, 200);
  assert.deepEqual((await db.db.query('select notification_chat_ids from le_orders')).rows[0].notification_chat_ids, ['first', 'second']);
  const input = { md_order: 'synthetic-payment', order_number: oid, amount: 1000, description: '' };
  for (const invalid of [{ orderStatus: 2 }, { ...evidence, amount: 99900 }, { ...evidence, orderNumber: 'wrong' }, { ...evidence, paymentAmountInfo: { depositedAmount: 90000 } }]) {
    bank = invalid;
    try { assert.equal(await api.pollAlfaOrder(input, {}), false); } catch (error) { assert.match(error.message, /evidence/); }
    const hook = await api.routeHook({ httpMethod: 'POST', queryStringParameters: { secret: 'synthetic-hook-secret' }, __data: { mdOrder: 'synthetic-payment', operation: 'deposited', status: '1' } }, {});
    assert.equal(hook.statusCode, 409);
    assert.equal(sends.length, 0);
    assert.equal((await db.db.query('select status from le_orders')).rows[0].status, 'awaiting_payment');
  }
  bank = evidence;
  await assert.rejects(api.pollAlfaOrder(input, {}));
  env.TG_CHAT_IDS = 'third'; rejectSecond = false;
  assert.equal(await api.pollAlfaOrder(input, {}), true);
  assert.deepEqual(sends, ['first', 'second', 'second']);
  assert.equal(await api.pollAlfaOrder(input, {}), false);
  const duplicateHook = await api.routeHook({ httpMethod: 'POST', queryStringParameters: { secret: 'synthetic-hook-secret' }, __data: { mdOrder: 'synthetic-payment', operation: 'deposited', status: '1' } }, {});
  assert.equal(duplicateHook.statusCode, 200);
  assert.equal(JSON.parse(duplicateHook.body).duplicate, true);
  assert.equal(sends.length, 3);
  await db.db.query("update le_orders set notification_chat_ids=null,telegram_sent=false,status='awaiting_payment'");
  await db.db.query("update payment_orders set notified_at=null");
  await assert.rejects(api.pollAlfaOrder(input, {}), /snapshot/);
  assert.equal(sends.length, 3);
  assert.equal((await db.db.query('select status from le_orders')).rows[0].status, 'awaiting_payment');
});
