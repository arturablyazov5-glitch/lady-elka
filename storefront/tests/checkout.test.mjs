import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConfig } from '../config/runtime.mjs';
globalThis.__LE_STOREFRONT_CONFIG__ = runtimeConfig('fixture');

test('COD preserves cart on error, blocks double submit, and clears it after success', async () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.location = { origin: 'http://localhost:4176', assign() { throw new Error('COD must not redirect'); } };
  globalThis.document = { createElement: () => ({ textContent: '', style: {}, setAttribute() {} }) };
  const cart = await import('../client/cart-store.js');
  const { initCheckout } = await import('../client/checkout.js');
  cart.clear();
  cart.add({ id: '1', title: 'Миранда', kind: 'tree' }, { id: '1:Зелёная:180', price: 1000,
    options: { category: 'Зелёная', height: '180' } });
  const fields = new Map([
    ['[data-checkout-field="name"]', 'Иван'], ['[data-checkout-field="email"]', 'ivan@example.org'],
    ['[data-checkout-field="phone"]', '+7 (999) 123-45-67'], ['[data-checkout-field="address"]', 'Москва'],
    ['[data-checkout-field="contactPref"]', 'Telegram'], ['[data-checkout-field="paymentMethod"]', 'cash_on_delivery']
  ]);
  const label = { textContent: 'купить' };
  const button = { disabled: false, querySelector: () => label, after() {} };
  const notice = { textContent: '', style: {}, setAttribute() {} };
  document.createElement = () => notice;
  let submit;
  const form = { querySelectorAll(selector) { const control = this.querySelector(selector); return control ? [control] : []; }, querySelector(selector) {
    if (selector === '[data-checkout-field="comment"]') return { value: '' };
    if (selector === '[data-pay-now]') return button;
    if (selector === '[data-checkout-field="consent"]') return { checked: true };
    // Phone gets the real input mask; model the element's listener API.
    return fields.has(selector) ? { value: fields.get(selector), addEventListener() {}, removeEventListener() {} } : null;
  }, addEventListener(_name, listener) { submit = listener; }, reset() {} };
  initCheckout(form, () => null);
  let calls = 0, sentPayload, firstOrderId;
  let release;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/trees.csv')) return { ok: true, text: async () => 'id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,1000\n' };
    if (url.endsWith('/decor.csv')) return { ok: true, text: async () => 'id,title,active,category,variants,price\n' };
    const requestNumber = ++calls;
    sentPayload = JSON.parse(options.body);
    if (requestNumber === 1) firstOrderId = sentPayload.orderId;
    else assert.equal(sentPayload.orderId, firstOrderId);
    assert.match(url, /action=create-cod-order$/);
    return new Promise(resolve => { release = () => resolve({ ok: requestNumber > 1,
      json: async () => requestNumber > 1 ? { ok: true, orderId: sentPayload.orderId } : { message: 'Попробуйте ещё раз' } }); });
  };
  const event = () => ({ preventDefault() {}, stopImmediatePropagation() {} });
  const first = submit(event());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, true);
  await submit(event());
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(cart.getItems().length, 1);
  assert.equal(button.disabled, false);
  assert.match(notice.textContent, /Сервис временно недоступен/);
  assert.ok(storage.get('lady_elka_pending_order_v1'));
  // Reinitialize the page to model F5: only sessionStorage carries the pending ID.
  initCheckout(form, () => null);
  const second = submit(event());
  await new Promise(resolve => setImmediate(resolve));
  release();
  await second;
  assert.equal(cart.getItems().length, 0);
  assert.equal(storage.has('lady_elka_pending_order_v1'), false);
  assert.match(notice.textContent, /Заказ №/);
});

test('checkout clears the cart after Alfa recovery confirms the order was already paid', async () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.location = { origin: 'http://localhost:4176', assign() { throw new Error('Paid recovery must not open a new payment page'); } };
  let notice = { textContent: '', style: {}, setAttribute() {} };
  globalThis.document = { createElement: () => notice };
  const cart = await import('../client/cart-store.js');
  const { initCheckout } = await import('../client/checkout.js');
  cart.clear();
  cart.add({ id: '1', title: 'Миранда', kind: 'tree' }, { id: '1:Зелёная:180', price: 1000,
    options: { category: 'Зелёная', height: '180' } });
  const fields = new Map([
    ['[data-checkout-field="name"]', 'Иван'], ['[data-checkout-field="email"]', 'ivan@example.org'],
    ['[data-checkout-field="phone"]', '+7 (999) 123-45-67'], ['[data-checkout-field="address"]', 'Москва'],
    ['[data-checkout-field="contactPref"]', 'Telegram'], ['[data-checkout-field="paymentMethod"]', 'card']
  ]);
  const label = { textContent: 'купить' };
  const button = { disabled: false, querySelector: () => label, after() {} };
  let submit;
  const form = { querySelectorAll(selector) { const control = this.querySelector(selector); return control ? [control] : []; }, querySelector(selector) {
    if (selector === '[data-checkout-field="comment"]') return { value: '' };
    if (selector === '[data-pay-now]') return button;
    if (selector === '[data-checkout-field="consent"]') return { checked: true };
    // Phone gets the real input mask; model the element's listener API.
    return fields.has(selector) ? { value: fields.get(selector), addEventListener() {}, removeEventListener() {} } : null;
  }, addEventListener(_name, listener) { submit = listener; }, reset() {} };
  initCheckout(form, () => null);
  globalThis.fetch = async url => {
    if (url.endsWith('/trees.csv')) return { ok: true, text: async () => 'id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,1000\n' };
    if (url.endsWith('/decor.csv')) return { ok: true, text: async () => 'id,title,active,category,variants,price\n' };
    return { ok: true, json: async () => ({ paid: true, orderId: 'LE-1780000000003-180-abcd1234' }) };
  };
  await submit({ preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(cart.getItems().length, 0);
  assert.equal(storage.has('lady_elka_pending_order_v1'), false);
  assert.match(notice.textContent, /оплачен/);
});
