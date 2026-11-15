// Scenarios from agent-context/review-pay-lead-catalog.md, items 1, 2, 3, 4, 6, 7.
// Every external provider is synthetic; unmocked network access throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { payDatabase, loadPay } from './helpers.mjs';

const HOOK_SECRET = 'Zq9xHOOKsyntheticVALUEW7k2';
const PII_PHONE = '+79990001122';
const PII_STREET = 'Тайная';

async function setup(t, extraEnv = {}) {
  const db = await payDatabase();
  t.after(() => db.db.close());
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  const originalConsole = { log: console.log, error: console.error, warn: console.warn };
  const logs = [];
  for (const level of ['log', 'error', 'warn']) console[level] = (...args) => logs.push(args.map(arg => {
    if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
    try { return typeof arg === 'string' ? arg : JSON.stringify(arg); } catch { return String(arg); }
  }).join(' '));
  t.after(() => { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; Object.assign(console, originalConsole); });
  const env = { TG_BOT_TOKEN: 'synthetic', TG_CHAT_IDS: 'first', SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic', ALFA_API_USER: 'synthetic', ALFA_API_PASS: 'synthetic',
    PK_HOST: 'pk.example.test', PK_USER: 'synthetic', PK_PASS: 'synthetic', ...extraEnv };
  globalThis.Deno = { env: { get: key => env[key] }, serve() {}, createHttpClient: () => ({}) };
  const api = await loadPay(['handler', 'routeCodOrder', 'routePay']);
  const state = { tg: [], bank: 0, register: 0, pk: 0, pkInvoice: null, tgFail: false, rpcDown: false };
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.startsWith('https://db.example.test/rest/v1/')) {
      const path = url.split('/rest/v1/')[1];
      if (state.rpcDown && path.startsWith('rpc/')) return new Response('{"message":"down"}', { status: 500 });
      return db.request(path, options);
    }
    if (url.endsWith('/trees.csv')) return new Response('id,title,active,category,height_cm,price\n1,Tree,1,Green,180,1000\n');
    if (url.endsWith('/register.do')) { state.register++; return Response.json({ formUrl: 'https://payment.example.test/', orderId: `pay-${state.register}` }); }
    if (url.endsWith('/getOrderStatusExtended.do')) { state.bank++; return Response.json({ errorCode: '6', errorMessage: 'synthetic' }); }
    if (url.includes('/info/invoice/')) { state.pk++; return state.pkInvoice ? Response.json(state.pkInvoice) : new Response('null', { status: 404 }); }
    if (url.includes('api.telegram.org')) {
      state.tg.push(JSON.parse(options.body));
      return state.tgFail ? Response.json({ ok: false, error_code: 400, description: 'Bad Request: synthetic' }, { status: 400 })
        : Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unmocked network request blocked: ${url}`);
  };
  const call = async (body, { qs = {}, headers = {} } = {}) => {
    const out = await api.handler({ httpMethod: 'POST', path: '/functions/v1/pay', queryStringParameters: qs, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.5', ...headers } });
    let json = null; try { json = JSON.parse(out.body); } catch {}
    return { status: out.statusCode, headers: out.headers, body: json };
  };
  const paymentOrder = (mdOrder, orderNumber, amount) => db.db.query(
    'insert into payment_orders(md_order, order_number, amount, description, status) values ($1,$2,$3,$4,$5)',
    [mdOrder, orderNumber, amount, 'synthetic', 'pending']);
  const notifiedAt = async mdOrder => (await db.db.query('select notified_at from payment_orders where md_order=$1', [mdOrder])).rows[0]?.notified_at ?? null;
  return { db, env, api, state, call, logs, paymentOrder, notifiedAt };
}

test('1: webhook and callbacks are rejected before processing when HOOK_SECRET is missing or wrong', async t => {
  const { env, state, call, logs } = await setup(t);
  for (const body of [{ invoice_id: 'fake', paid: true, amount: 1 }, { id: 'fake', status: 'paid', sum: 1 },
    { mdOrder: 'fake', operation: 'deposited', status: '1' }, { callback_query: { id: '1', data: 'order_status_menu' } }]) {
    const result = await call(body);
    assert.ok(result.status >= 400, `missing secret must reject ${JSON.stringify(body)}, got ${result.status}`);
    assert.notEqual(result.body?.notified, true);
  }
  assert.deepEqual([state.tg.length, state.bank, state.pk], [0, 0, 0]);
  env.HOOK_SECRET = HOOK_SECRET;
  for (const qs of [{}, { secret: 'wrong' }, { secret: `${HOOK_SECRET}x` }]) {
    assert.equal((await call({ invoice_id: 'fake', paid: true, amount: 1, secret: qs.secret ? undefined : '' }, { qs })).status, 401);
  }
  assert.deepEqual([state.tg.length, state.bank, state.pk], [0, 0, 0]);
  // 7: no fragments of the configured secret in logs.
  const text = logs.join('\n');
  assert.ok(!text.includes(HOOK_SECRET.slice(0, 4)) && !text.includes(HOOK_SECRET.slice(-4)), 'secret fragments must not be logged');
});

test('2: PayKeeper needs exact paid status from the API and a stored invoice/order/amount match', async t => {
  const { env, state, call, paymentOrder, notifiedAt } = await setup(t, { HOOK_SECRET });
  const orderId = `LE-${Date.now()}-180-pk`;
  await paymentOrder('777', orderId, 1500);
  const hook = body => call(body, { qs: { secret: HOOK_SECRET } });
  // Webhook claims are not evidence: "unpaid" contains "paid", and the API says the invoice is not paid.
  state.pkInvoice = { id: '777', status: 'created', pay_amount: 1500, orderid: orderId };
  assert.notEqual((await hook({ id: '777', sum: 99999, status: 'unpaid', orderid: orderId })).body?.notified, true);
  assert.notEqual((await hook({ id: '777', sum: 1500, status: 'paid', paid: true, orderid: orderId })).body?.notified, true);
  state.pkInvoice = { id: '777', status: 'unpaid', pay_amount: 1500, orderid: orderId };
  assert.notEqual((await hook({ id: '777', status: 'paid', paid: true })).body?.notified, true);
  assert.equal(state.tg.length, 0);
  assert.equal(await notifiedAt('777'), null);
  // API says paid, but amount / order number / invoice id disagree with the stored order.
  for (const invoice of [{ id: '777', status: 'paid', pay_amount: 1400, orderid: orderId },
    { id: '777', status: 'paid', pay_amount: 1500, orderid: 'LE-1-other' },
    { id: '778', status: 'paid', pay_amount: 1500, orderid: orderId }]) {
    state.pkInvoice = invoice;
    const result = await hook({ id: '777', status: 'paid', sum: 1500 });
    assert.equal(result.status, 409, JSON.stringify(invoice));
  }
  // Unknown invoice confirmed by the API but never stored by us.
  state.pkInvoice = { id: '999', status: 'paid', pay_amount: 10, orderid: 'LE-1-x' };
  assert.equal((await hook({ id: '999', status: 'paid', sum: 10 })).status, 409);
  // The public check route follows the same rules.
  state.pkInvoice = { id: '777', status: 'unpaid', pay_amount: 1500, orderid: orderId };
  assert.notEqual((await call({ invoice_id: '777' }, { qs: { action: 'check-payment' } })).body?.notified, true);
  assert.equal(state.tg.length, 0);
  assert.equal(await notifiedAt('777'), null);
  // Confirmed and matching: exactly one notification with the stored amount, then deduplicated.
  state.pkInvoice = { id: '777', status: 'paid', pay_amount: 1500, orderid: orderId, service_name: 'Ёлка' };
  const ok = await hook({ id: '777', sum: 1, status: 'paid' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.notified, true);
  assert.equal(state.tg.length, 1);
  assert.match(state.tg[0].text, /1\s500 ₽/);
  assert.ok(await notifiedAt('777'));
  assert.notEqual((await hook({ id: '777', status: 'paid' })).body?.notified, true);
  assert.notEqual((await call({ invoice_id: '777' }, { qs: { action: 'check-payment' } })).body?.notified, true);
  assert.equal(state.tg.length, 1);
  env.PK_HOST = '';
  assert.ok((await hook({ id: '777', status: 'paid' })).status >= 500, 'unconfigured PayKeeper cannot confirm');
});

test('3: a PayKeeper payment confirmed later than ten minutes is still notified once', async t => {
  const { state, call, paymentOrder, notifiedAt } = await setup(t, { HOOK_SECRET });
  const late = `LE-${Date.now() - 11 * 60 * 1000}-180-late`;
  const later = `LE-${Date.now() - 3 * 24 * 60 * 60 * 1000}-180-old`;
  await paymentOrder('888', late, 1000);
  await paymentOrder('889', later, 2000);
  state.pkInvoice = { id: '888', status: 'paid', pay_amount: 1000, orderid: late };
  const hook = await call({ id: '888', status: 'paid' }, { qs: { secret: HOOK_SECRET } });
  assert.equal(hook.body?.notified, true);
  state.pkInvoice = { id: '889', status: 'paid', pay_amount: 2000, orderid: later };
  const check = await call({ invoice_id: '889' }, { qs: { action: 'check-payment' } });
  assert.equal(check.body?.notified, true);
  assert.equal(state.tg.length, 2);
  assert.ok(await notifiedAt('888'));
  assert.ok(await notifiedAt('889'));
  // Redelivery of either is deduplicated by the stored payment / effect, not by age.
  await call({ id: '888', status: 'paid' }, { qs: { secret: HOOK_SECRET } });
  state.pkInvoice = { id: '888', status: 'paid', pay_amount: 1000, orderid: late };
  await call({ invoice_id: '888' }, { qs: { action: 'check-payment' } });
  assert.equal(state.tg.length, 2);
});

const customer = (n = 0) => ({ name: 'Test', email: n ? `buyer${n}@example.test` : 'Buyer@Example.test ', phone: n ? `+7999${String(n).padStart(7, '0')}` : '+7 (999) 123-45-67', contactPref: 'Telegram' });
const order = (id, method, who = customer()) => ({ paymentMethod: method, orderId: `LE-1234567890${id}-180`, amount: 1000, description: 'Tree',
  customer: who, delivery: { address: 'Test' }, items: [{ kind: 'tree', productId: '1', variantId: '1:Green:180', quantity: 1, price: 1000 }] });

test('4: order creation is rate limited atomically per address, contact and global external budget', async t => {
  const { db, env, state, call } = await setup(t);
  const cod = (body, headers) => call(body, { qs: { action: 'create-cod-order' }, headers });
  // Same buyer (normalized email/phone variants), new order IDs, rotating spoofed X-Forwarded-For.
  const accepted = [];
  for (let i = 0; i < 6; i++) {
    const who = i % 2 ? { ...customer(), email: 'buyer@example.test', phone: '89991234567' } : customer();
    who.comment = `Отдельный заказ ${i}`; // Keep these rate-limit fixtures semantically distinct.
    const result = await cod(order(100 + i, 'cash_on_delivery', who), { 'x-forwarded-for': `198.51.100.${i}` });
    if (result.status === 200) accepted.push(order(100 + i, 'cash_on_delivery', who));
    else {
      assert.equal(result.status, 429);
      assert.ok(Number(result.headers['Retry-After']) > 0);
      assert.match(result.headers['Access-Control-Expose-Headers'] || '', /Retry-After/i);
    }
  }
  assert.equal(accepted.length, 5, 'contact limit 5 per window');
  assert.equal(state.tg.length, 5);
  assert.equal((await db.db.query('select count(*)::int n from le_orders')).rows[0].n, 5);
  // Replays of an accepted order are budgeted separately and still answer.
  assert.equal((await cod(accepted[0])).body?.duplicate, true);
  // Same address with fresh contacts: the per-address bucket (10) stops card registrations.
  let refused = null;
  for (let i = 1; i <= 8; i++) {
    const result = await call(order(200 + i, 'card', customer(i)), { headers: { 'x-forwarded-for': `192.0.2.${i}` } });
    if (result.status === 429) { refused = i; break; }
    assert.equal(result.status, 200);
  }
  assert.equal(refused, 6, 'address bucket counts only admitted attempts');
  assert.equal(state.register, 5);
  // Global external budget across addresses and contacts.
  env.EXTERNAL_RATE_LIMIT_GLOBAL = '12/3600';
  const statuses = [];
  for (let i = 1; i <= 3; i++) statuses.push((await call(order(300 + i, 'card', customer(50 + i)), { headers: { 'cf-connecting-ip': `203.0.113.${100 + i}` } })).status);
  assert.deepEqual(statuses, [200, 200, 429]);
  assert.equal(state.register, 7);
  // The limiter is fail-closed: without it no order is stored and no provider is called.
  delete env.EXTERNAL_RATE_LIMIT_GLOBAL;
  state.rpcDown = true;
  const before = [state.register, state.tg.length, (await db.db.query('select count(*)::int n from le_orders')).rows[0].n];
  assert.equal((await call(order(401, 'card', customer(90)), { headers: { 'cf-connecting-ip': '203.0.113.250' } })).status, 503);
  assert.equal((await cod(order(402, 'cash_on_delivery', customer(91)), { 'cf-connecting-ip': '203.0.113.251' })).status, 503);
  assert.deepEqual([state.register, state.tg.length, (await db.db.query('select count(*)::int n from le_orders')).rows[0].n], before);
});

test('6: legacy Telegram formatting escapes every string field', async t => {
  const { state, call } = await setup(t, { HOOK_SECRET });
  const result = await call({ secret: HOOK_SECRET, status: 'paid', invoice_id: 'manual-1', amount: 100,
    cartItems: [{ name: 'Ёлка', category: '<a href="https://evil.test">link</a>', height: '<b>180</b>', price: 100 }] },
  { qs: { action: 'send-notification' } });
  assert.equal(result.status, 200);
  assert.equal(state.tg.length, 1);
  assert.doesNotMatch(state.tg[0].text, /<a href|<b>180/);
  assert.match(state.tg[0].text, /&lt;a href=&quot;https:\/\/evil\.test&quot;&gt;/);
});

test('2/6: manual relay uses exact statuses', async t => {
  const { state, call } = await setup(t, { HOOK_SECRET });
  const result = await call({ secret: HOOK_SECRET, status: 'unpaid', invoice_id: 'manual-2', amount: 100 }, { qs: { action: 'send-notification' } });
  assert.equal(result.status, 400);
  assert.equal(state.tg.length, 0);
});

test('7: logs carry no order text, customer data or Telegram message bodies', async t => {
  const { state, call, logs, paymentOrder } = await setup(t, { HOOK_SECRET });
  const orderId = `LE-${Date.now()}-180-pii`;
  await paymentOrder('555', orderId, 1000);
  const serviceName = `Ёлка 180 см (Green) — 1000 ₽ | Покупатель: Иван | Телефон: ${PII_PHONE} | Адрес: ул. ${PII_STREET} 5`;
  state.pkInvoice = { id: '555', status: 'paid', pay_amount: 1000, orderid: orderId, service_name: serviceName, client_phone: PII_PHONE };
  state.tgFail = true;
  await call({ id: '555', status: 'paid', service_name: serviceName, description: serviceName }, { qs: { secret: HOOK_SECRET } });
  assert.equal(state.tg.length, 1);
  assert.ok(state.tg[0].text.includes(PII_STREET), 'the message itself keeps the address');
  const text = logs.join('\n');
  assert.ok(!text.includes(PII_PHONE) && !text.includes(PII_STREET), `PII leaked into logs:\n${text}`);
});
