import test from 'node:test';
import assert from 'node:assert/strict';
import { availableOptions, initialSelection, resolveVariant } from '../products/variants.mjs';
import { buildOrderPayload, cartTotal, discountTotal } from '../client/order-payload.js';
import { matchingVariants } from '../client/filter.js';
const product = { id: '1', kind: 'tree', title: 'Миранда', variants: [
  { id: '1:Зелёная:180', options: { category: 'Зелёная', height: '180' }, price: 1000 },
  { id: '1:Заснеженная:180', options: { category: 'Заснеженная', height: '180' }, price: 1200 },
  { id: '1:Заснеженная:215', options: { category: 'Заснеженная', height: '215' }, price: 1500 },
] };
test('variant resolver excludes combinations absent from the feed', () => {
  assert.deepEqual(initialSelection(product), { category: 'Зелёная', height: '180' });
  assert.deepEqual(availableOptions(product, 'height', { category: 'Зелёная' }), ['180']);
  assert.equal(resolveVariant(product, { category: 'Зелёная', height: '215' }), null);
  assert.equal(resolveVariant(product, { category: 'Заснеженная', height: '215' }).price, 1500);
});
test('catalog filter checks category, height and price on variants', () => {
  assert.deepEqual(matchingVariants(product, { category: 'Зелёная', height: 215 }), []);
  assert.deepEqual(matchingVariants(product, { category: 'Заснеженная', height: 180, min: 1100, max: 1300 })
    .map(variant => variant.id), ['1:Заснеженная:180']);
  assert.deepEqual(matchingVariants(product, { max: 900 }), []);
});
test('cart merges the same variant and keeps distinct variants separate', async () => {
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const cart = await import('../client/cart-store.js');
  cart.clear();
  cart.add(product, product.variants[1]);
  cart.add(product, product.variants[1]);
  cart.add(product, product.variants[2]);
  assert.deepEqual(cart.getItems().map(item => [item.variantId, item.quantity]), [['1:Заснеженная:180', 2], ['1:Заснеженная:215', 1]]);
  assert.equal(cart.total(), 3900);
  assert.equal(JSON.parse(data.get('lady_elka_cart_v2'))[0].quantity, 2);
  cart.decrement('1', '1:Заснеженная:180');
  cart.remove('1', '1:Заснеженная:215');
  assert.equal(cart.total(), 1200);
});
test('payment payload uses cart items and keeps the existing pay fields and description grammar', () => {
  const items = [{ productId: '1', variantId: '1:Заснеженная:180', title: 'Миранда', kind: 'tree',
    options: { category: 'Заснеженная', height: '180' }, price: 1200, quantity: 2, image: '' }];
  const customer = { name: 'Иван', email: 'ivan@example.org', phone: '+70000000000', address: 'Москва', contactPref: 'Telegram' };
  const payload = buildOrderPayload(items, customer, null, 'http://localhost:4176', 123);
  assert.equal(cartTotal(items), 2400);
  assert.equal(discountTotal(items, { rub: 300 }), 2100);
  assert.equal(payload.amount, 2400);
  assert.match(payload.description, /Миранда 180 см \(Заснеженная\) x2 — 2400 ₽/);
  assert.match(payload.orderId, /^LE-123-180-[a-f0-9]{8}$/);
  assert.equal(payload.successUrl, `http://localhost:4176/spasibo/?oid=${payload.orderId}`);
  assert.equal(payload.failUrl, `http://localhost:4176/pay-return/?fail=1&oid=${payload.orderId}`);
});
