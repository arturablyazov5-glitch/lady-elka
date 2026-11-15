import { qaConfig } from './qa-config.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export async function qaDigest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function createQaPolicy(config) {
  const retired = (config.retired || []).map(previous => createQaPolicy(previous));
  const isOrder = id => String(id) === config.orderId || retired.some(policy => policy.isOrder(id));
  const applies = payload => isOrder(payload?.orderId) || payload?.items?.some?.(item => item.productId === config.productId);
  const notification = '<b>ТЕСТ ОПЛАТЫ — 1 ₽ — НЕ ОБРАБАТЫВАТЬ</b>\nЗаказ: ' + config.orderId
    + '\nОплата картой — оплачено\nИтого: 1 ₽ (100 копеек, RUB)\nБез доставки, резервирования и изменения остатков.';
  async function validatePayload(payload) {
    const item = payload?.items?.[0];
    if (String(payload?.orderId) !== config.orderId || payload.paymentMethod !== 'card' || payload.amount !== 1 || payload.promo !== null
      || payload.items.length !== 1 || item.productId !== config.productId || item.variantId !== 'qa:100:RUB'
      || item.kind !== 'qa' || item.quantity !== 1 || item.price !== 1
      || await qaDigest(JSON.stringify(canonical(payload))) !== config.fingerprint)
      throw new Error('QA payload is not server approved');
  }
  async function validateRecipients(recipients) {
    if (!Array.isArray(recipients) || recipients.length !== 1 || typeof recipients[0] !== 'string' || !/^[1-9]\d*$/.test(recipients[0])
      || await qaDigest(recipients[0]) !== config.recipientHash)
      throw new Error('QA requires its fixed verified private recipient');
    return recipients;
  }
  async function selectRecipients(stored, configured) {
    if (stored) return validateRecipients(stored.notification_chat_ids);
    const candidates = [];
    for (const id of configured) if (typeof id === 'string' && /^[1-9]\d*$/.test(id) && await qaDigest(id) === config.recipientHash) candidates.push(id);
    return validateRecipients([...new Set(candidates)]);
  }
  async function validateRow(row) {
    const previous = retired.find(policy => policy.isOrder(row?.order_id));
    if (previous) return previous.validateRow(row);
    if (!isOrder(row?.order_id) && !applies(row?.payload)) return;
    if (!isOrder(row.order_id) || Number(row.total) !== 1 || row.payment_method !== 'card'
      || row.fingerprint !== config.fingerprint || row.notification !== notification)
      throw new Error('QA stored order requires review');
    await validatePayload(row.payload);
    await validateRecipients(row.notification_chat_ids);
  }
  async function validateBank(row, bank) {
    if (isOrder(row.order_id) && String(bank.currency) !== '643') throw new Error('QA bank currency must be RUB');
  }
  return { isOrder, applies, notification, validatePayload, validateRecipients, selectRecipients, validateRow, validateBank,
    sessionTimeoutSecs: config.sessionTimeoutSecs || 86400 };
}
export const qaPolicy = createQaPolicy(qaConfig);
