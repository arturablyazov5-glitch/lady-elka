// V2 relies on independent Alfa API evidence; merchant callback and old queues stay untouched.
export function bankState(order, expected, evidence) {
  if (String(order.errorCode ?? '0') !== '0' || String(order.orderNumber) !== expected.orderId
      || Number(order.amount) !== Math.round(Number(expected.total) * 100)
      || [order.orderId, order.mdOrder].some(id => id !== undefined && String(id) !== expected.paymentId))
    throw new Error('Bank evidence does not match stored order');
  const paid = evidence(order, expected.paymentId);
  if (paid) return 'paid';
  const state = Number(order.orderStatus);
  if (!Number.isInteger(state) || ![0, 1, 3, 4, 5, 6].includes(state)
      || String(order.paymentState || order.paymentAmountInfo?.paymentState || '').toUpperCase() === 'DEPOSITED')
    throw new Error('Contradictory bank status');
  return [3, 6].includes(state) ? 'cancelled' : state === 4 ? 'refunded' : 'awaiting_payment';
}

export function createV2Operations({ store, request, getBank, evidence, notifyPaid, response, admit, validateRow = async () => {}, validateBank = async () => {}, now = () => new Date().toISOString() }) {
  async function reconcile(row, headers) {
    await validateRow(row);
    if (row.status === 'paid') {
      await notifyPaid(row, null, headers);
      await store.update(row.order_id, { last_checked_at: now(), last_error: null });
      return 'paid';
    }
    const bank = await getBank(row.payment_id);
    await validateBank(row, bank);
    const state = bankState(bank, { orderId: row.order_id, total: row.total, paymentId: row.payment_id }, evidence);
    if (state === 'paid') {
      // The paid status is persisted BEFORE delivery. Failure never turns paid back into unpaid.
      await store.update(row.order_id, { status: 'paid', last_checked_at: now(), last_error: null });
      await notifyPaid(row, bank, headers);
    } else {
      await store.update(row.order_id, { last_checked_at: now(), last_error: null });
    }
    return state;
  }
  return {
    async status(payload, headers, client) {
      const limited = await admit('check', client, {}, headers);
      if (limited) return limited;
      // The exact saved payload proves ownership. An order number alone cannot query the bank or expose PII.
      let row;
      try { row = await store.existing(String(payload.orderId || ''), payload); }
      catch { return response(404, { message: 'Заказ не найден' }, headers); }
      if (!row) return response(404, { message: 'Заказ не найден' }, headers);
      try { await validateRow(row); }
      catch { return response(503, { message: 'Заказ требует проверки' }, headers); }
      if (row.payment_method !== 'card') return response(400, { message: 'Заказ оформлен с оплатой при получении' }, headers);
      if (!row.payment_id) return response(200, { ok: true, orderId: row.order_id, paid: false, status: 'pending_review' }, headers);
      if (row.status === 'paid') return response(200, { ok: true, orderId: row.order_id, paid: true, status: 'paid' }, headers);
      try {
        const status = await reconcile(row, headers);
        return response(200, { ok: true, orderId: row.order_id, paid: status === 'paid', status }, headers);
      } catch {
        // A Telegram failure after authoritative payment confirmation must not conceal a paid order.
        const saved = await store.existing(row.order_id, payload);
        if (saved?.status === 'paid') return response(200, { ok: true, orderId: row.order_id, paid: true, status: 'paid' }, headers);
        return response(503, { message: 'Статус оплаты пока недоступен. Попробуйте позже.' }, headers);
      }
    },
    async poll(headers) {
      // Only persistent V2 card orders. Queue-only diagnostic invoices are never processed or notified.
      const base = 'le_orders?select=*&payment_method=eq.card&payment_id=not.is.null&telegram_sent=eq.false';
      const order = '&order=last_checked_at.asc.nullsfirst,created_at.asc&limit=10';
      const cutoff = encodeURIComponent(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
      const paidQueue = await request(base + '&status=eq.paid' + order);
      const awaitingQueue = await request(base + '&status=eq.awaiting_payment&created_at=gte.' + cutoff + order);
      if (!paidQueue.ok || !awaitingQueue.ok) throw new Error('Payment queue unavailable');
      const rows = [...await paidQueue.json(), ...await awaitingQueue.json()];
      let checked = 0, paid = 0, failed = 0;
      const deadline = Date.now() + 45000;
      for (const row of rows) {
        if (Date.now() >= deadline) break;
        checked++;
        try { if (await reconcile(row, headers) === 'paid') paid++; }
        catch {
          failed++;
          await store.update(row.order_id, { last_checked_at: now(), last_error: 'payment_or_delivery_check_failed' });
        }
      }
      return response(200, { ok: true, checked, paid, failed }, headers);
    }
  };
}
