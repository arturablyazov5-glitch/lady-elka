import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderStore } from '../../_shared/order-store.mjs';
import { payDatabase, loadPay } from './helpers.mjs';

const payload = id => ({
  orderId: `LE-1793042817134-215-${id}`, paymentMethod: 'cash_on_delivery', amount: 39900,
  customer: { name: 'Тестовый Покупатель', email: 'buyer@example.test', phone: '+7 (912) 000-00-00', contactPref: 'Telegram', comment: '' },
  delivery: { address: 'Тестовый город, улица 10, 15' },
  items: [{ kind: 'tree', productId: '1', variantId: '1:Зелёная:215', quantity: 1, price: 39900 }],
  promo: null, successUrl: `https://example.test/thanks?oid=${id}`,
});

test('COD: different IDs and normalized contacts share one atomic reservation; meaningful changes stay separate', async t => {
  const { db, request } = await payDatabase(); t.after(() => db.close());
  const a = createOrderStore(request), b = createOrderStore(request);
  const first = payload('first');
  const next = payload('next');
  next.customer = { ...next.customer, name: ' тестовый   покупатель ', email: ' BUYER@EXAMPLE.TEST ', phone: '89120000000' };
  next.delivery.address = ' тестовый ГОРОД,   улица 10, 15 ';
  const orders = await Promise.all([a.reserve(first.orderId, first), b.reserve(next.orderId, next)]);
  assert.equal(orders[0].order_id, orders[1].order_id);
  assert.equal((await db.query('select count(*)::int n from le_orders')).rows[0].n, 1);
  // Reordered items, JSON keys and ignored generated URLs cannot defeat the guard.
  const reordered = { ...payload('reordered'), items: [ { price:39900, quantity:1, variantId:'1:Зелёная:215', productId:'1', kind:'tree' } ] };
  assert.equal((await a.reserve(reordered.orderId, reordered)).order_id, orders[0].order_id);
  for (const [key, change] of [
    ['phone', p => p.customer.phone = '+79120000001'],
    ['address', p => p.delivery.address += ', другой подъезд'],
    ['quantity', p => { p.items[0].quantity = 2; p.amount = 79800; }],
    ['variant', p => p.items[0].variantId = '1:Зелёная:250'],
    ['comment', p => p.customer.comment = 'Это второй отдельный заказ'],
    ['promo', p => p.promo = { code:'GIFT' }],
  ]) {
    const changed = payload(key); change(changed);
    assert.equal((await a.reserve(changed.orderId, changed)).order_id, changed.orderId);
  }
  await assert.rejects(a.reserve(orders[0].order_id, { ...orders[0].payload, amount:1 }), e => e.conflict);
  await db.query("update le_orders set created_at=now()-interval '11 minutes'");
  const later = payload('later');
  assert.equal((await b.reserve(later.orderId, later)).order_id, later.orderId);
  const rights = await db.query("select has_function_privilege('anon','le_reserve_cod_order(text,jsonb,text)','execute') as anon, has_function_privilege('authenticated','le_reserve_cod_order(text,jsonb,text)','execute') as auth");
  assert.deepEqual(rights.rows[0], { anon:false, auth:false });
});

test('COD: two simultaneous checkout requests and a later new ID produce one order and one Telegram per recipient', async t => {
  const database = await payDatabase(); t.after(() => database.db.close());
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; });
  const env = { TG_BOT_TOKEN:'synthetic', TG_CHAT_IDS:'first,second', SUPABASE_URL:'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY:'synthetic' };
  globalThis.Deno = { env:{ get:key => env[key] }, serve() {}, createHttpClient:()=>({}) };
  let sends = 0;
  globalThis.fetch = async (url, options) => {
    if (url.startsWith('https://db.example.test/rest/v1/')) return database.request(url.split('/rest/v1/')[1], options);
    if (url.endsWith('/trees.csv')) return new Response('id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,215,39900\n');
    if (url.startsWith('https://api.telegram.org/')) { sends++; return Response.json({ok:true,result:{message_id:sends}}); }
    throw new Error('Unmocked network blocked');
  };
  const api = await loadPay(['routeCodOrder']);
  const card = await api.routeCodOrder({ ...payload('card'), paymentMethod:'card' }, {}, true);
  assert.ok(card.notification.startsWith('<b>Оплачено картой</b>\n\n<b>В заказе:</b>'));
  assert.doesNotMatch(card.notification, /Способ оплаты:|Оплата картой — оплачено/);
  const results = await Promise.all([api.routeCodOrder(payload('first'), {}), api.routeCodOrder(payload('second'), {})]);
  assert.ok(results.some(r => r.statusCode === 200));
  const replay = await api.routeCodOrder(payload('third'), {});
  assert.equal(replay.statusCode, 200);
  const result = JSON.parse(replay.body);
  assert.equal(result.duplicate, true);
  const rows = (await database.db.query('select * from le_orders')).rows;
  assert.equal(rows.length, 1);
  assert.equal(result.orderId, rows[0].order_id);
  assert.equal(rows[0].telegram_sent, true);
  assert.equal(sends, 2);
  const effects = (await database.db.query("select * from le_order_effects where effect_key like 'telegram:%'")).rows;
  assert.equal(effects.length, 2);
  assert.ok(effects.every(e => e.state === 'done' && e.attempt_count === 1));
});
