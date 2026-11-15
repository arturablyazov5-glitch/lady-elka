import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { isolatedStoragePath } from './isolation.mjs';
import { preparePayV2, migrationPath } from '../../../scripts/prepare-pay-v2.mjs';
import { runtimeConfig } from '../../../storefront/config/runtime.mjs';
import { payDatabase } from '../pay/tests/helpers.mjs';
import { names } from '../../../scripts/prepare-pay-v2.mjs';

test('deployed entry rejects every effect before parsing input or calling a provider', async t => {
  await preparePayV2();
  const saved = { Deno: globalThis.Deno, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, saved));
  let serve, calls = 0;
  globalThis.Deno = { env: { get: () => 'open' }, serve: handler => { serve = handler; } };
  globalThis.fetch = () => { calls++; throw new Error('External effect forbidden'); };
  const result = await build({ entryPoints: ['supabase/functions/pay-v2/index.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false });
  await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
    for (const action of ['', 'pay', 'create-cod-order', 'poll-payments', 'retry-cod-delivery', 'hook', 'send-notification', 'check-payment']) {
      const request = new Request('https://example.test/functions/v1/pay-v2?action=' + action, {
        method, headers: { origin: 'https://lady-elka.ru', 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{"amount":100,"description":"test","callback_query":{}}' }),
      });
      const response = await serve(request);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://lady-elka.ru');
    }
  }
  const ready = await serve(new Request('https://example.test/functions/v1/pay-v2?action=readiness'));
  assert.deepEqual(await ready.json(), { service: 'pay-v2', state: 'prepared', admission: 'closed', confirmation: 'alfa-api-poll' });
  assert.equal((await serve(new Request('https://example.test/functions/v1/pay-v2', { method: 'OPTIONS', headers: { origin: 'https://www.lady-elka.ru' } }))).status, 204);
  assert.equal((await serve(new Request('https://example.test/functions/v1/pay-v2', { headers: { origin: 'https://evil.test' } }))).status, 403);
  assert.equal(calls, 0);
  assert.equal(runtimeConfig('production').payment.endsWith('/pay-v2'), true);
  assert.equal(runtimeConfig('fixture').payment, '/functions/v1/pay');
});

test('storage namespace blocks legacy table and RPC access', () => {
  assert.equal(isolatedStoragePath('payment_orders?md_order=eq.x'), 'le_v2_payment_orders?md_order=eq.x');
  assert.equal(isolatedStoragePath('le_orders?order_id=eq.x'), 'le_v2_orders?order_id=eq.x');
  assert.equal(isolatedStoragePath('rpc/le_reserve_cod_order'), 'rpc/le_v2_reserve_cod_order');
  assert.equal(isolatedStoragePath('rpc/le_rate_limit_take'), 'rpc/le_v2_rate_limit_take');
  assert.equal(isolatedStoragePath('rpc/le_recover_bank_order'), 'rpc/le_v2_recover_bank_order');
  for (const path of ['unknown', '../payment_orders', 'payment_orders_backup', 'rpc/other'])
    assert.throws(() => isolatedStoragePath(path));
});

test('isolated migration preserves legacy queue and denies public access', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec("create table payment_orders(md_order text primary key, marker text); insert into payment_orders values ('legacy','keep');");
  await db.exec(await readFile(migrationPath, 'utf8'));
  await db.exec(await readFile('supabase/migrations/20261027100100_v2_cod_duplicate_guard.sql', 'utf8'));
  const codPayload = { orderId:'v2-first', paymentMethod:'cash_on_delivery', amount:1000, customer:{phone:'+79991234567'}, items:[] };
  const reserveCod = async id => (await db.query('select order_id from public.le_v2_reserve_cod_order($1,$2,$3)', [id, {...codPayload,orderId:id}, id])).rows[0].order_id;
  assert.equal(await reserveCod('v2-first'), 'v2-first');
  assert.equal(await reserveCod('v2-second'), 'v2-first');
  assert.deepEqual((await db.query('select * from payment_orders')).rows, [{ md_order: 'legacy', marker: 'keep' }]);
  assert.equal((await db.query("select to_regclass('public.le_orders') is null as unchanged")).rows[0].unchanged, true);
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['le_v2_orders', 'le_v2_order_effects', 'le_v2_payment_orders', 'le_v2_rate_limits']) {
      const q = await db.query('select has_table_privilege($1,$2,\'SELECT\') as readable, has_table_privilege($1,$2,\'INSERT\') as writable', [role, 'public.' + table]);
      assert.deepEqual(q.rows[0], { readable: false, writable: false });
    }
    assert.equal((await db.query("select has_function_privilege($1,'public.le_v2_rate_limit_take(text[],integer[],integer[])','EXECUTE') as allowed", [role])).rows[0].allowed, false);
  }
  await db.exec('set role service_role;');
  assert.equal((await db.query("select public.le_v2_rate_limit_take(array['test'],array[1],array[60]) as retry")).rows[0].retry, 0);
  assert.ok((await db.query("select public.le_v2_rate_limit_take(array['test'],array[1],array[60]) as retry")).rows[0].retry > 0);
});

test('parked v2 business handler validates, deduplicates and completes a card order with isolated HTTP paths', async t => {
  const database = await payDatabase();
  t.after(() => database.db.close());
  const saved = { Deno: globalThis.Deno, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, saved));
  const env = { TG_BOT_TOKEN: 'synthetic', TG_CHAT_IDS: '123', LE_V2_HOOK_SECRET: 'synthetic',
    ALFA_API_USER: 'synthetic', ALFA_API_PASS: 'synthetic', ALFA_API_BASE: 'https://bank.example.invalid/payment/rest',
    SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', CORS_ORIGIN: '*' };
  globalThis.Deno = { env: { get: key => env[key] }, serve() {}, createHttpClient: () => ({}) };
  const compiled = await build({ stdin: { contents: await readFile('supabase/functions/pay-v2/index.ts', 'utf8') + '\nexport { handler };',
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
  const { handler } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64') + '#business');
  let registrations = 0, notifications = 0;
  const storagePaths = [];
  const orderId = 'LE-1791810000000-180', paymentId = '00000000-0000-0000-0000-000000000001';
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === 'db.example.invalid') {
      const path = parsed.pathname.slice('/rest/v1/'.length) + parsed.search;
      storagePaths.push(path);
      assert.match(path, /^(?:rpc\/)?le_v2_/);
      // Existing PostgreSQL fixture uses the canonical names; only its local
      // adapter translates them. Real migration isolation is tested above.
      const localPath = path.replace(/^(rpc\/)?([a-z0-9_]+)(?=\?|$)/, (_, rpc = '', name) =>
        rpc + Object.keys(names).find(key => names[key] === name));
      return database.request(localPath, options);
    }
    if (parsed.pathname.endsWith('/trees.csv')) return new Response('id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,1000\n');
    if (parsed.pathname.endsWith('/promos.csv')) return new Response('promocode,ruble-offer,percent-offer,gift-offer\n');
    if (parsed.pathname.endsWith('/register.do')) {
      registrations++;
      return Response.json({ formUrl: 'https://bank.example.invalid/form', orderId: paymentId });
    }
    if (parsed.pathname.endsWith('/getOrderStatusExtended.do'))
      return Response.json({ orderId: paymentId, orderStatus: 2, amount: 100000, orderNumber: orderId });
    if (parsed.host === 'api.telegram.org') {
      notifications++;
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error('Unexpected provider');
  };
  const payload = { paymentMethod: 'card', orderId, amount: 1000, description: 'Synthetic',
    customer: { name: 'Synthetic', email: 'synthetic@example.invalid', phone: '+79991234567', contactPref: 'Telegram' },
    delivery: { address: 'Synthetic' },
    items: [{ kind: 'tree', productId: '1', variantId: '1:Зелёная:180', quantity: 1, price: 1000 }], promo: null };
  const call = (body, query = {}) => handler({ httpMethod: 'POST', path: '/functions/v1/pay-v2',
    headers: { 'content-type': 'application/json' }, queryStringParameters: query, body: JSON.stringify(body) });
  assert.equal((await call(payload)).statusCode, 200);
  assert.equal((await call(payload)).statusCode, 200);
  assert.equal(registrations, 1);
  const hook = () => call({ mdOrder: paymentId, operation: 'deposited', status: '1' }, { secret: 'synthetic' });
  assert.equal((await hook()).statusCode, 200);
  assert.equal((await hook()).statusCode, 200);
  assert.equal(notifications, 1);
  assert.equal((await database.db.query('select status from le_orders')).rows[0].status, 'paid');
  assert.ok(storagePaths.length > 0);
});
