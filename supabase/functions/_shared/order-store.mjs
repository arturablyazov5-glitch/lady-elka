// All calls use service_role. Unique rows and conditional PATCH are the locks.
export function createOrderStore(request) {
  const eq = value => encodeURIComponent(value);
  async function json(path, options = {}) {
    const response = await request(path, options);
    if (!response.ok) throw new Error(`Order storage unavailable (${response.status})`);
    return response.status === 204 ? null : response.json();
  }
  const write = (method, body) => ({ method, headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  async function insert(table, body) {
    return json(`${table}?on_conflict=${table === 'le_orders' ? 'order_id' : 'effect_key'}`, {
      ...write('POST', body), headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }
    });
  }
  async function hash(payload) {
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(payload))));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return {
    async existing(orderId, payload) {
      const order = (await json(`le_orders?order_id=eq.${eq(orderId)}&select=*`))[0];
      if (order && order.fingerprint !== await hash(payload)) {
        const error = new Error('Номер заказа уже используется с другими данными'); error.conflict = true; throw error;
      }
      return order;
    },
    async reserve(orderId, payload) {
      const fingerprint = await hash(payload);
      if (payload.paymentMethod === 'cash_on_delivery') {
        const rows = await json('rpc/le_reserve_cod_order', write('POST', {
          p_order_id: orderId, p_payload: payload, p_fingerprint: fingerprint
        }));
        const order = rows?.[0];
        if (!order) throw new Error('COD reservation unavailable');
        if (order.order_id === orderId && order.fingerprint !== fingerprint) {
          const error = new Error('Номер заказа уже используется с другими данными'); error.conflict = true; throw error;
        }
        return order;
      }
      const rows = await insert('le_orders', { order_id: orderId, fingerprint, payment_method: payload.paymentMethod || 'card',
        payload, total: Number(payload.amount), status: 'received' });
      const order = rows[0] || (await json(`le_orders?order_id=eq.${eq(orderId)}&select=*`))[0];
      if (!order || order.fingerprint !== fingerprint) {
        const error = new Error('Номер заказа уже используется с другими данными'); error.conflict = true; throw error;
      }
      return order;
    },
    async update(orderId, patch, expectedStatus) {
      const rows = await json(`le_orders?order_id=eq.${eq(orderId)}${expectedStatus ? `&status=eq.${eq(expectedStatus)}` : ''}`, write('PATCH', { ...patch, updated_at: new Date().toISOString() }));
      if (!rows?.length && !expectedStatus) throw new Error('Order not found');
    },
    async payment(paymentId) {
      return (await json(`le_orders?payment_id=eq.${eq(paymentId)}&select=*`))[0];
    },
    async effect(key, operation, policy = {}) {
      const token = crypto.randomUUID();
      let rows = await insert('le_order_effects', { effect_key: key, state: 'running', token, attempt_count: 1 });
      if (!rows.length) {
        const previous = (await json(`le_order_effects?effect_key=eq.${eq(key)}&select=*`))[0];
        const due = previous?.next_attempt_at && new Date(previous.next_attempt_at).getTime() <= Date.now();
        if (previous?.state === 'failed' && (!policy.automatic || (due && previous.attempt_count < policy.maxAttempts))) {
          // The count predicate also protects a retry that raced another completed attempt.
          const automaticConditions = policy.automatic
            ? `&next_attempt_at=lte.${eq(new Date().toISOString())}&attempt_count=lt.${policy.maxAttempts}` : '';
          rows = await json(`le_order_effects?effect_key=eq.${eq(key)}&state=eq.failed&attempt_count=eq.${previous.attempt_count}${automaticConditions}`, write('PATCH', {
            state: 'running', token, attempt_count: previous.attempt_count + 1,
            next_attempt_at: null, updated_at: new Date().toISOString(), last_error: null
          }));
        }
      }
      if (!rows.length) {
        const existing = (await json(`le_order_effects?effect_key=eq.${eq(key)}&select=*`))[0];
        if (existing?.state === 'done') return existing.result;
        const error = new Error('Заказ сохранён; результат операции уточняется. Повторная отправка заблокирована.');
        error.pending = true; throw error;
      }
      const finish = async patch => {
        const updated = await json(`le_order_effects?effect_key=eq.${eq(key)}&token=eq.${eq(token)}&state=eq.running`,
          write('PATCH', { ...patch, updated_at: new Date().toISOString() }));
        if (!updated?.length) throw new Error('Operation ownership lost');
      };
      let result;
      try { result = await operation(); }
      catch (error) {
        // Retry ONLY when the provider explicitly rejected the operation.
        if (!error.definite) error.uncertain = true;
        const delay = policy.backoffSeconds
          ? Math.min(3600, policy.backoffSeconds * 2 ** Math.min(rows[0].attempt_count - 1, 10)) : 0;
        await finish({ state: error.definite ? 'failed' : 'unknown',
          next_attempt_at: error.definite && delay ? new Date(Date.now() + delay * 1000).toISOString() : null,
          last_error: String(error).slice(0, 500) }).catch(() => {});
        throw error;
      }
      // A failed acknowledgement must never reset a successfully executed effect.
      await finish({ state: 'done', result, next_attempt_at: null });
      return result;
    }
  };
}
