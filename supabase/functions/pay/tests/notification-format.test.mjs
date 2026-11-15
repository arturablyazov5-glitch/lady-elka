import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutNotification, normalizeOrderPhone } from '../../_shared/order-notification.mjs';

test('normalizes Russian phones and rejects malformed input', () => {
  for (const phone of ['+7 (919) 649-45-00', '8 919 6494500', '9196494500']) assert.equal(normalizeOrderPhone(phone), '+79196494500');
  for (const phone of ['', '123', '+7 (919) 649-45-000', 'abc79196494500']) assert.equal(normalizeOrderPhone(phone), '');
});
test('checkout uses readable blocks, trusted line totals and normalized contact', () => {
  const text = checkoutNotification({items:[{name:'Миранда',options:'Зелёная · 230 см',quantity:1,price:44299}],total:43299,discount:1000,promoCode:'Home',name:'Покупатель',phone:'+7 (919) 649-45-00',email:'test@example.test',address:'Адрес',contactPref:'Telegram'});
  assert.equal(text, '<b>В заказе:</b>\n• Миранда 230 см (Зелёная) — 44 299 ₽\n\nПромокод «Home» дал скидку 1 000 ₽\n<b>Итого: 43 299 ₽</b>\n\nПокупатель: Покупатель\nСвязаться можно в Telegram (+79196494500)\n\nEmail: test@example.test\nАдрес: Адрес');
  assert.doesNotMatch(text,/Дата:|сумма|× 1/);
});
test('multiple quantities and HTML are preserved safely', () => {
  const text = checkoutNotification({items:[{name:'<ёлка>',options:'Зелёная · 270 см',quantity:2,price:79000}],total:158000,name:'A&B',phone:'89196494500',email:'a@b.ru',address:'A',contactPref:'Позвонить',payment:'Оплата картой — оплачено'});
  assert.match(text,/&lt;ёлка&gt; 270 см \(Зелёная\) × 2 — 158 000 ₽/);
  assert.match(text,/A&amp;B/);
  assert.match(text,/по телефону: \+79196494500/);
});

 test('one item without discount omits redundant total; multiple items retain it', () => {
  const data = {items:[{name:'Вита',options:'Зелёная · 210 см',quantity:1,price:24000}],total:24000,name:'Тест',phone:'79880066137',email:'test@example.test',address:'Тест',contactPref:'Позвонить'};
  const text = checkoutNotification(data);
  assert.doesNotMatch(text, /Итого:|\n\n\n/);
  assert.match(text, /24 000 ₽\n\nПокупатель:/);
  assert.match(checkoutNotification({...data,items:[...data.items,...data.items],total:48000}), /Итого: 48 000 ₽/);
  assert.match(checkoutNotification({...data,items:[{...data.items[0],quantity:2}],total:48000}), /Итого: 48 000 ₽/);
 });
