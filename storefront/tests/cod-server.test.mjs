import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
// pay now admits orders through the le_rate_limit_take RPC (fail-closed); payDatabase adds that migration to the order DB.
import { payDatabase as orderDatabase } from '../../supabase/functions/pay/tests/helpers.mjs';

test('COD validates current catalog and sends through the existing Telegram configuration', async t => {
  const database = await orderDatabase();
  t.after(() => database.db.close());
  let handle;
  const originalConsoleError = console.error;
  console.error = (...args) => originalConsoleError(...args.map(arg => arg instanceof Error ? arg.message : arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).filter(([key]) => key !== 'stack')) : arg));
  t.after(() => { console.error = originalConsoleError; });
  // Bank callbacks are authenticated by HOOK_SECRET (fail-closed: unconfigured → 503, wrong → 401).
  const env = { TG_BOT_TOKEN: 'test-token', TG_CHAT_IDS: 'test-chat', CORS_ORIGIN: '*', HOOK_SECRET: 'synthetic-hook-secret',
    // This scenario submits ~20 orders from one customer/IP; the real limiter RPC still runs, only its quota is raised.
    // Default limits (5 per contact, 10 orders/checks and 30 replays per IP per 10 min) are covered by supabase/functions/pay/tests.
    ORDER_RATE_LIMIT_CONTACT: '100/600', ORDER_RATE_LIMIT_IP: '100/600', CHECK_RATE_LIMIT_IP: '100/600', REPLAY_RATE_LIMIT_IP: '100/600',
    ALFA_API_USER: 'test-user', ALFA_API_PASS: 'test-pass', SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'mock-key' };
  globalThis.Deno = { env: { get: key => env[key] }, serve: callback => { handle = callback; }, createHttpClient: () => ({}) };
  const compiled = await build({ entryPoints: ['supabase/functions/pay/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`;
  await import(moduleUrl);
  const telegram = [];
  let rejectTelegram = false, bankCalls = 0, bankTimeout = false, telegramMode = '', changedPrice = false, storageDown = false;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/rest/v1/')) {
      if (storageDown) return new Response('{}', { status: 503 });
      return database.request(url.split('/rest/v1/')[1], options);
    }
    if (url.endsWith('/trees.csv')) return { ok: true, text: async () => `id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,${changedPrice ? 2000 : 1000}\n` };
    if (url.endsWith('/promos.csv')) return { ok: true, text: async () => 'promocode,ruble-offer,percent-offer,gift-offer\nCODE,100,0,\n' };
    if (url.includes('api.telegram.org')) {
      const sent = JSON.parse(options.body);
      telegram.push(sent);
      if (telegramMode === 'timeout') throw new Error('mock lost Telegram reply');
      const rejected = rejectTelegram || telegramMode === 'partial' && sent.chat_id === 'second-chat';
      return { ok: !rejected, status: rejected ? 400 : 200,
        json: async () => rejected ? { ok: false, description: 'mock failure' } : { ok: true, result: { message_id: 1 } } };
    }
    if (url.endsWith('/register.do')) { bankCalls++; if (bankTimeout) throw new Error('mock lost bank reply'); return { ok: true, text: async () => JSON.stringify({ formUrl: 'https://payment.example.test/form', orderId: 'test-payment-id' }) }; }
    if (url.endsWith('/getOrderStatusExtended.do')) {
      const mdOrder = new URLSearchParams(options.body).get('orderId');
      return { ok: true, json: async () => ({ orderStatus: 2, amount: 1000 * 100,
        orderNumber: mdOrder === 'poll-payment-id' ? 'LE-1234567890150-180' : 'LE-1234567890126-180',
        orderDescription: 'Миранда — 1000 ₽' }) };
    }
    throw new Error(`Unexpected network request: ${url}`);
  };
  const payload = (orderId, price = 1000, promo = null) => ({ action: 'create-cod-order', paymentMethod: 'cash_on_delivery', orderId,
    customer: { name: 'Иван', email: 'ivan@example.org', phone: '+79991234567', contactPref: 'Telegram' },
    delivery: { address: 'Москва' }, items: [{ kind: 'tree', productId: '1', variantId: '1:Зелёная:180', quantity: 1, price }],
    amount: promo ? 900 : price, promo });
  const request = async body => {
    const response = await handle(new Request('https://example.org/functions/v1/pay?action=create-cod-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request(payload('LE-1234567890123-180', 900))).status, 409);
  assert.equal(telegram.length, 0);
  const success = await request(payload('LE-1234567890124-180', 1000, { code: 'CODE' }));
  assert.equal(success.status, 200);
  assert.equal(success.body.amount, 900);
  assert.equal(telegram.length, 1);
  assert.match(telegram[0].text, /Оплата при получении/);
  assert.match(telegram[0].text, /Миранда.*1\s*000 ₽/);
  assert.doesNotMatch(JSON.stringify(telegram[0].reply_markup), /Alfa/);
  assert.equal((await request(payload('LE-1234567890124-180', 1000, { code: 'CODE' }))).body.duplicate, true);
  assert.equal(telegram.length, 1);
  const cardResponse = await handle(new Request('https://example.org/functions/v1/pay', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload('LE-1234567890126-180'), action: 'pay', paymentMethod: 'card', description: 'Миранда — 1000 ₽', email: 'ivan@example.org', phone: '+79991234567' }) }));
  assert.equal(cardResponse.status, 200);
  assert.equal((await cardResponse.json()).url, 'https://payment.example.test/form');
  assert.equal(telegram.length, 1);
  const cardPayload = { ...payload('LE-1234567890126-180'), action: 'pay', paymentMethod: 'card', description: 'Миранда — 1000 ₽', email: 'ivan@example.org', phone: '+79991234567' };
  const card = () => handle(new Request('https://example.org/functions/v1/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cardPayload) }));
  // New module instance shares only PostgreSQL, no process-local maps.
  await import(moduleUrl + '#second-instance');
  assert.equal((await card()).status, 200);
  assert.equal(bankCalls, 1);
  const hook = () => handle(new Request('https://example.org/functions/v1/pay?action=hook&secret=synthetic-hook-secret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mdOrder: 'test-payment-id', operation: 'deposited', status: '1' }) }));
  assert.equal((await hook()).status, 200);
  assert.equal(telegram.length, 2);
  assert.equal((await hook()).status, 200);
  assert.equal(telegram.length, 2);
  assert.equal((await database.db.query("select status,telegram_sent from le_orders where payment_id='test-payment-id'")).rows[0].status, 'paid');
  assert.equal((await (await card()).json()).paid, true);
  assert.equal(bankCalls, 1);
  rejectTelegram = true;
  const originalError = console.error;
  console.error = () => {};
  try { assert.equal((await request(payload('LE-1234567890125-180'))).status, 502); }
  finally { console.error = originalError; }
  rejectTelegram = false;
  assert.equal((await request(payload('LE-1234567890125-180'))).status, 200);
  changedPrice = true;
  assert.equal((await request(payload('LE-1234567890124-180', 1000, { code: 'CODE' }))).status, 200);
  assert.equal((await request({ ...payload('LE-1234567890124-180', 1000, { code: 'CODE' }), customer: { ...payload('x').customer, name: 'Другой' } })).status, 409);
  changedPrice = false;
  const payRequest = body => handle(new Request('https://example.org/functions/v1/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await payRequest({ ...cardPayload, orderId: 'LE-1234567890130-180', items: [{ ...cardPayload.items[0], price: 900 }], amount: 900 })).status, 409);
  assert.equal(bankCalls, 1);
  assert.equal((await payRequest({ ...cardPayload, orderId: 'LE-1234567890140-180', items: undefined })).status, 400);
  assert.equal((await payRequest({ ...cardPayload, orderId: 'LE-1234567890141-180', paymentMethod: 'cash_on_delivery' })).status, 400);
  env.TG_CHAT_IDS = 'test-chat,second-chat';
  telegramMode = 'partial';
  const partial = payload('LE-1234567890131-180');
  partial.customer = { ...partial.customer, comment: 'partial: separate delivery scenario' };
  const beforePartial = telegram.length;
  assert.equal((await request(partial)).status, 502);
  assert.equal(telegram.length - beforePartial, 2);
  telegramMode = '';
  assert.equal((await request(partial)).status, 200);
  assert.equal(telegram.length - beforePartial, 3);
  assert.equal(telegram.at(-1).chat_id, 'second-chat');
  env.TG_CHAT_IDS = 'test-chat';
  telegramMode = 'timeout';
  const unknown = payload('LE-1234567890132-180');
  unknown.customer = { ...unknown.customer, comment: 'unknown: separate delivery scenario' };
  const beforeUnknown = telegram.length;
  assert.equal((await request(unknown)).status, 502);
  telegramMode = '';
  await import(moduleUrl + '#third-instance');
  assert.equal((await request(unknown)).status, 409);
  assert.equal(telegram.length - beforeUnknown, 1);
  bankTimeout = true;
  const unknownCard = { ...cardPayload, orderId: 'LE-1234567890133-180' };
  assert.equal((await payRequest(unknownCard)).status, 503);
  bankTimeout = false;
  assert.equal((await payRequest(unknownCard)).status, 409);
  assert.equal(bankCalls, 2);
  storageDown = true;
  assert.equal((await payRequest({ ...cardPayload, orderId: 'LE-1234567890134-180' })).status, 503);
  assert.equal(bankCalls, 2);
  storageDown = false;
  // A payment found by the persistent queue is confirmed and delivered once.
  await database.db.query(`insert into le_orders(order_id,fingerprint,payment_method,status,payload,total,payment_id,notification_chat_ids)
    values ('LE-1234567890150-180','poll-fingerprint','card','awaiting_payment',$1::jsonb,1000,'poll-payment-id','["test-chat"]')`,
  [JSON.stringify({ description: 'Миранда — 1000 ₽' })]);
  env.ALFA_CALLBACK_TOKEN = 'mock-poll-token';
  const polling = await handle(new Request('https://example.org/functions/v1/pay?action=poll-payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Poll-Token': 'mock-poll-token' }, body: '{}' }));
  assert.equal(polling.status, 200);
  assert.equal((await polling.json()).notified, 1);
  assert.deepEqual((await database.db.query(`select status,telegram_sent from le_orders where order_id='LE-1234567890150-180'`)).rows[0],
    { status: 'paid', telegram_sent: true });

  env.COD_DELIVERY_RETRY_TOKEN = 'local-only-cod-retry-token-32-characters';
  const retryDelivery = (token = env.COD_DELIVERY_RETRY_TOKEN) => handle(new Request('https://example.org/functions/v1/pay?action=retry-cod-delivery', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cod-Retry-Token': token }, body: '{}' }));
  assert.equal((await retryDelivery('wrong')).status, 401);
  env.TG_CHAT_IDS = 'test-chat,second-chat';
  telegramMode = 'partial';
  const backgroundOrder = payload('LE-1234567890160-180');
  backgroundOrder.customer = { ...backgroundOrder.customer, comment: 'backgroundOrder: separate delivery scenario' };
  assert.equal((await request(backgroundOrder)).status, 502);
  const beforeRetry = telegram.length;
  telegramMode = '';
  assert.equal((await retryDelivery()).status, 200);
  assert.equal(telegram.length, beforeRetry, 'backoff and unknown outcomes must not send');
  await database.db.query("update le_order_effects set next_attempt_at=now()-interval '1 minute' where effect_key=$1", [`telegram:cash_on_delivery:${backgroundOrder.orderId}:second-chat`]);
  const firstInstance = handle;
  await import(moduleUrl + '#background-instance');
  const cronRequest = () => new Request('https://example.org/functions/v1/pay?action=retry-cod-delivery', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cod-Retry-Token': env.COD_DELIVERY_RETRY_TOKEN }, body: '{}' });
  await Promise.all([firstInstance(cronRequest()), handle(cronRequest()), request(backgroundOrder)]);
  assert.equal(telegram.length, beforeRetry + 1, 'concurrent cron instances send only failed recipient once');
  assert.equal(telegram.at(-1).chat_id, 'second-chat');
  assert.equal((await database.db.query('select telegram_sent from le_orders where order_id=$1', [backgroundOrder.orderId])).rows[0].telegram_sent, true);
  telegramMode = 'partial';
  const exhaustedOrder = payload('LE-1234567890161-180');
  exhaustedOrder.customer = { ...exhaustedOrder.customer, comment: 'exhaustedOrder: separate delivery scenario' };
  await request(exhaustedOrder);
  await database.db.query("update le_order_effects set attempt_count=5,next_attempt_at=now()-interval '1 minute' where effect_key=$1", [`telegram:cash_on_delivery:${exhaustedOrder.orderId}:second-chat`]);
  const beforeExhausted = telegram.length;
  await retryDelivery();
  assert.equal(telegram.length, beforeExhausted, 'automatic budget is bounded');
  telegramMode = '';
  // Accepted snapshot whose recipient effects never began is recoverable after a crash.
  await database.db.query(`insert into le_orders(order_id,fingerprint,payment_method,status,payload,total,notification,notification_chat_ids)
    values ('LE-1234567890162-180','never-started','cash_on_delivery','accepted','{}',1000,'Saved COD notification','["test-chat","second-chat"]')`);
  await retryDelivery();
  assert.equal(telegram.length, beforeExhausted + 2);
  await retryDelivery();
  assert.equal(telegram.length, beforeExhausted + 2);

});

test('historical card without recipient snapshot remains available for manual review after polling', async t => {
  const database = await orderDatabase();
  t.after(() => database.db.close());
  let handle;
  const env = { TG_BOT_TOKEN: 'mock-token', TG_CHAT_IDS: 'current-recipient',
    ALFA_API_USER: 'mock-user', ALFA_API_PASS: 'mock-pass', ALFA_CALLBACK_TOKEN: 'mock-poll-token',
    SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'mock-key' };
  globalThis.Deno = { env: { get: key => env[key] }, serve: callback => { handle = callback; }, createHttpClient: () => ({}) };
  const compiled = await build({ entryPoints: ['supabase/functions/pay/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}#historical-card`);
  const orderId = 'LE-1234567890170-180';
  await database.db.query(`insert into le_orders(order_id,fingerprint,payment_method,status,payload,total,payment_id)
    values ($1,'historical-fingerprint','card','awaiting_payment',$2::jsonb,1000,'historical-payment-id')`,
  [orderId, JSON.stringify({ description: 'Saved historical card' })]);
  let telegramCalls = 0, bankChecks = 0;
  globalThis.fetch = async (url, options) => {
    if (url.startsWith('https://db.example.test/rest/v1/')) return database.request(url.split('/rest/v1/')[1], options);
    if (url.endsWith('/getOrderStatusExtended.do')) {
      bankChecks++;
      return { ok: true, json: async () => ({ orderStatus: 2, amount: 100000, orderNumber: orderId }) };
    }
    if (url.includes('api.telegram.org')) telegramCalls++;
    throw new Error(`Unexpected network request: ${url}`);
  };
  const poll = () => handle(new Request('https://example.org/functions/v1/pay?action=poll-payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Poll-Token': env.ALFA_CALLBACK_TOKEN }, body: '{}' }));
  for (const recipients of ['current-recipient', 'replacement-recipient']) {
    env.TG_CHAT_IDS = recipients;
    const response = await poll();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).notified, 0);
  }
  assert.equal(bankChecks, 2, 'valid bank evidence reaches the missing-snapshot guard');
  assert.equal(telegramCalls, 0, 'current recipients must never replace historical recipients');
  assert.deepEqual((await database.db.query(`select status,telegram_sent,notification_chat_ids,payment_id,fingerprint,payload
    from le_orders where order_id=$1`, [orderId])).rows[0], {
    status: 'awaiting_payment', telegram_sent: false, notification_chat_ids: null,
    payment_id: 'historical-payment-id', fingerprint: 'historical-fingerprint', payload: { description: 'Saved historical card' }
  });
  assert.equal((await database.db.query('select count(*)::int as count from le_order_effects')).rows[0].count, 0);
});
