import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderStore } from '../../supabase/functions/_shared/order-store.mjs';
import { orderDatabase } from './helpers/order-db.mjs';

test('PostgreSQL migration permissions, cross-instance claims, replay and payload conflict', async t => {
  const { db, request } = await orderDatabase(); t.after(() => db.close());
  const a = createOrderStore(request), b = createOrderStore(request);
  const payload = { paymentMethod: 'card', amount: 1000, customer: { name: 'Иван' } };
  await Promise.all([a.reserve('LE-1', payload), b.reserve('LE-1', payload)]);
  assert.equal((await db.query('select * from le_orders')).rows.length, 1);
  await assert.rejects(b.reserve('LE-1', { ...payload, amount: 1 }), error => error.conflict);
  let calls = 0, release;
  const first = a.effect('bank:LE-1', async () => { calls++; await new Promise(resolve => { release = resolve; }); return { paymentId: 'bank-1' }; });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(b.effect('bank:LE-1', () => { calls++; }), error => error.pending);
  release(); await first;
  assert.deepEqual(await b.effect('bank:LE-1', () => { calls++; }), { paymentId: 'bank-1' });
  assert.equal(calls, 1);
  const rights = await db.query("select has_table_privilege('anon','le_orders','SELECT') as anon, has_table_privilege('authenticated','le_order_effects','UPDATE') as authenticated");
  assert.equal(rights.rows[0].anon, false); assert.equal(rights.rows[0].authenticated, false);
  await db.exec('set role service_role');
  assert.equal((await db.query('select order_id from le_orders')).rows.length, 1);
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query('select * from le_orders'), /permission denied/);
  await db.exec('reset role');
});

test('Explicit rejection can retry; ambiguous outcome and lost persistence acknowledgement cannot', async t => {
  const { db, request } = await orderDatabase(); t.after(() => db.close());
  const store = createOrderStore(request);
  await assert.rejects(store.effect('reject', () => { const e = new Error('400 rejection'); e.definite = true; throw e; }));
  assert.deepEqual(await store.effect('reject', () => ({ ok: true })), { ok: true });
  await assert.rejects(store.effect('timeout', () => { throw new Error('lost provider response'); }));
  await assert.rejects(store.effect('timeout', () => assert.fail('must not resend')), error => error.pending);
  const noCommit = createOrderStore(async (path, options) => {
    if (options?.method === 'PATCH' && JSON.parse(options.body).state === 'done') throw new Error('DB fails before commit');
    return request(path, options);
  });
  await assert.rejects(noCommit.effect('no-commit', () => ({ messageId: 6 })));
  await assert.rejects(store.effect('no-commit', () => assert.fail('must not resend')), error => error.pending);
  const lostAck = createOrderStore(async (path, options) => {
    const response = await request(path, options);
    if (options?.method === 'PATCH' && JSON.parse(options.body).state === 'done') throw new Error('response lost after DB commit');
    return response;
  });
  let sent = 0;
  await assert.rejects(lostAck.effect('lost-ack', () => { sent++; return { messageId: 7 }; }));
  assert.deepEqual(await store.effect('lost-ack', () => assert.fail('must not resend')), { messageId: 7 });
  assert.equal(sent, 1);
  const unavailable = createOrderStore(async () => { throw new Error('DB unavailable'); });
  await assert.rejects(unavailable.effect('no-db', () => assert.fail('must not send')));
});

test('Alfa recovery atomically links an existing payment and preserves queue delivery state', async t => {
  const { db, request } = await orderDatabase(); t.after(() => db.close());
  const store = createOrderStore(request);
  const callRecovery = async args => {
    const response = await request('rpc/le_recover_bank_order', { method: 'POST', body: JSON.stringify(args) });
    const rows = await response.json();
    return rows[0];
  };

  const unpaidOrderId = 'LE-1780000000001-180-abcd1234';
  const unpaidPayload = { paymentMethod: 'card', amount: 1599, description: 'Елка' };
  await store.reserve(unpaidOrderId, unpaidPayload);
  await assert.rejects(store.effect(`bank:${unpaidOrderId}`, async () => { throw new Error('bank reply lost'); }));
  await assert.rejects(callRecovery({ p_order_id: unpaidOrderId, p_payment_id: 'bank-unpaid-1',
    p_bank_status: 1, p_bank_amount_kopecks: 159900,
    p_payment_url: 'https://payment.alfabank.ru/payment?mdOrder=bank-unpaid-1', p_description: 'Елка' }), /Bank status requires manual review/);
  await assert.rejects(callRecovery({ p_order_id: unpaidOrderId, p_payment_id: 'bank-unpaid-1',
    p_bank_status: 0, p_bank_amount_kopecks: 159900, p_payment_url: '', p_description: 'Елка' }), /Unpaid recovery requires/);
  const unpaidResult = await callRecovery({ p_order_id: unpaidOrderId, p_payment_id: 'bank-unpaid-1',
    p_bank_status: 0, p_bank_amount_kopecks: 159900,
    p_payment_url: 'https://payment.alfabank.ru/payment?mdOrder=bank-unpaid-1', p_description: 'Елка' });
  assert.equal(unpaidResult.paid, false);
  assert.equal((await db.query(`select payment_id,status,result->>'url' as url from le_orders where order_id=$1`, [unpaidOrderId])).rows[0].status, 'awaiting_payment');
  assert.equal((await db.query("select status from payment_orders where md_order='bank-unpaid-1'")).rows[0].status, 'pending');
  assert.deepEqual(await store.effect(`bank:${unpaidOrderId}`, async () => assert.fail('must not register again')), unpaidResult);

  const paidOrderId = 'LE-1780000000002-180-abcd1234';
  const paidPayload = { paymentMethod: 'card', amount: 2000, description: 'Туя' };
  await store.reserve(paidOrderId, paidPayload);
  await assert.rejects(store.effect(`bank:${paidOrderId}`, async () => { throw new Error('bank reply lost'); }));
  await db.query(`insert into payment_orders(md_order,order_number,amount,description,status,created_at,notified_at)
    values ('bank-paid-2',$1,2000,'Туя','paid','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`, [paidOrderId]);
  const paidResult = await callRecovery({ p_order_id: paidOrderId, p_payment_id: 'bank-paid-2',
    p_bank_status: 2, p_bank_amount_kopecks: 200000, p_payment_url: '', p_description: 'Туя' });
  assert.equal(paidResult.paid, true);
  const order = (await db.query('select payment_id,status,result->>\'url\' as url from le_orders where order_id=$1', [paidOrderId])).rows[0];
  assert.deepEqual(order, { payment_id: 'bank-paid-2', status: 'paid', url: '' });
  const queue = (await db.query("select status,notified_at,created_at from payment_orders where md_order='bank-paid-2'")).rows[0];
  assert.equal(queue.status, 'paid');
  assert.equal(new Date(queue.notified_at).toISOString(), '2026-01-02T00:00:00.000Z');
  assert.equal((await db.query("select state from le_order_effects where effect_key='bank:" + paidOrderId + "'")).rows[0].state, 'done');
});
