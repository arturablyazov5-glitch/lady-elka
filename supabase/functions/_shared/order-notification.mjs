const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const rub = value => `${new Intl.NumberFormat('ru-RU').format(value).replace(/\s/g, ' ')} ₽`;

export function normalizeOrderPhone(value) {
  const raw = String(value ?? '').trim();
  if (!/^[+\d\s().-]+$/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10) digits = `7${digits}`;
  if (/^8\d{10}$/.test(digits)) digits = `7${digits.slice(1)}`;
  return /^7\d{10}$/.test(digits) ? `+${digits}` : '';
}

export function checkoutNotification({ items, total, discount, promoCode, gift, name, phone, email, address, contactPref, comment, payment }) {
  const lines = items.map(item => {
    const options = String(item.options || '').split(' · ');
    const height = options.find(option => /^\d+(?:[.,]\d+)? см$/.test(option));
    const rest = options.filter(option => option !== height).join(' · ');
    return `• ${escape(item.name)}${height ? ` ${escape(height)}` : ''}${rest ? ` (${escape(rest)})` : ''}${item.quantity > 1 ? ` × ${item.quantity}` : ''} — ${rub(item.price * item.quantity)}`;
  }).join('\n');
  const showTotal = items.reduce((sum, item) => sum + item.quantity, 0) > 1 || discount > 0;
  const promo = promoCode && discount > 0 ? `Промокод «${escape(promoCode)}» дал скидку ${rub(discount)}` : '';
  const contact = /telegram|whatsapp/i.test(contactPref)
    ? `Связаться можно в ${escape(contactPref)}${phone ? ` (${escape(normalizeOrderPhone(phone))})` : ''}`
    : `Связаться можно по телефону: ${escape(normalizeOrderPhone(phone))}`;
  return [payment ? `<b>Способ оплаты: ${escape(payment)}</b>` : '', `<b>В заказе:</b>\n${lines}`,
    [promo, gift ? `Подарок: ${escape(gift)}` : '', showTotal ? `<b>Итого: ${rub(total)}</b>` : ''].filter(Boolean).join('\n'),
    `Покупатель: ${escape(name)}\n${contact}`,
    [`Email: ${escape(email)}`, `Адрес: ${escape(address)}`, comment ? `Комментарий: ${escape(comment)}` : ''].filter(Boolean).join('\n')
  ].filter(Boolean).join('\n\n');
}
