import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConfig } from '../config/runtime.mjs';
import * as cart from '../client/cart-store.js';
import { initCheckout } from '../client/checkout.js';

const pendingKey = 'lady_elka_pending_order_v1';
const draftKey = 'lady_elka_checkout_draft_v1';
function setup(method = 'cash_on_delivery') {
  globalThis.__LE_STOREFRONT_CONFIG__ = runtimeConfig('fixture');
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  globalThis.sessionStorage = storage;
  globalThis.localStorage = { ...storage };
  globalThis.location = { origin: 'http://localhost:4176', assign(url) { redirects.push(url); } };
  const redirects = [], posts = [];
  cart.clear();
  cart.add({ id: '1', title: 'Миранда', kind: 'tree' },
    { id: '1:Зелёная:180', price: 1000, options: { category: 'Зелёная', height: '180' } });
  let reply = async payload => ({ ok: true, json: async () => ({ ok: true, orderId: payload.orderId }) });
  let rejectCatalog = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url, location.origin).origin, location.origin, 'external request forbidden');
    if (options?.method === 'POST') {
      const payload = JSON.parse(options.body);
      posts.push({ url, payload });
      assert.deepEqual(JSON.parse(values.get(pendingKey)).payload, payload);
      return reply(payload);
    }
    if (rejectCatalog) throw new Error('catalog must not be loaded on retry');
    if (url.endsWith('/trees.csv')) return { ok: true, text: async () => 'id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,1000\n' };
    if (url.endsWith('/decor.csv')) return { ok: true, text: async () => 'id,title,active,category,variants,price\n' };
    throw new Error(`Unexpected mock request: ${url}`);
  };
  function page() {
    const fields = new Map(Object.entries({
      '[data-checkout-field="name"]': 'Иван', '[data-checkout-field="email"]': 'ivan@example.org',
      '[data-checkout-field="phone"]': '+7 (999) 123-45-67', '[data-checkout-field="address"]': 'Москва',
      '[data-checkout-field="contactPref"]': 'Telegram', '[data-checkout-field="paymentMethod"]': method,
      '[data-checkout-field="comment"]': 'Комментарий'
    }).map(([key, value]) => [key, { value, addEventListener() {}, removeEventListener() {} }]));
    const consent = { checked: true }, label = { textContent: 'купить' };
    const button = { disabled: false, querySelector: () => label, after() {} };
    const notice = { textContent: '', style: {}, setAttribute() {}, appendChild() {} };
    globalThis.document = { createElement: tag => tag === 'p' ? notice : {} };
    let submit, resets = 0;
    const form = {
      querySelectorAll(selector) { const control = this.querySelector(selector); return control ? [control] : []; },
      querySelector(selector) {
        if (selector === '[data-pay-now]') return button;
        if (selector === '[data-checkout-field="consent"]') return consent;
        return fields.get(selector);
      },
      addEventListener(name, listener) { if (name === 'submit') submit = listener; },
      reset() { resets++; }
    };
    initCheckout(form, () => null);
    return { fields, button, label, notice, get resets() { return resets; },
      submit: () => submit({ preventDefault() {}, stopImmediatePropagation() {} }) };
  }
  return { storage, values, posts, redirects, page,
    reply(fn) { reply = fn; }, rejectCatalog() { rejectCatalog = true; } };
}

for (const method of ['cash_on_delivery', 'card'])
for (const failure of ['missing', 'getter throws', 'quota', 'read throws', 'silent no-op', 'corrupt readback']) {
  test(`checkout-storage-hardening: ${method}, ${failure} blocks POST and preserves form/cart`, async () => {
    const env = setup(method);
    if (failure === 'missing') globalThis.sessionStorage = undefined;
    if (failure === 'getter throws') Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true, get() { throw new Error('SecurityError'); }
    });
    if (failure === 'quota') env.storage.setItem = key => { if (key === pendingKey) throw new Error('QuotaExceededError'); };
    if (failure === 'read throws') env.storage.getItem = key => { if (key === pendingKey) throw new Error('SecurityError'); return env.values.get(key) ?? null; };
    if (failure === 'silent no-op') env.storage.setItem = (key, value) => { if (key !== pendingKey) env.values.set(key, value); };
    if (failure === 'corrupt readback') env.storage.getItem = key => key === pendingKey ? '{"corrupt":true}' : env.values.get(key) ?? null;
    const page = env.page();
    try {
      await page.submit();
      assert.equal(env.posts.length, 0);
      assert.equal(cart.getItems().length, 1);
      assert.equal(page.fields.get('[data-checkout-field="name"]').value, 'Иван');
      assert.equal(page.resets, 0);
      assert.equal(page.button.disabled, false);
      assert.equal(page.label.textContent, 'купить');
      assert.match(page.notice.textContent, /Отправка остановлена/);
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: env.storage });
    }
  });
}

test('checkout-storage-hardening: storage recovery allows retry and F5 replays identical payload after lost response', async () => {
  const env = setup();
  const write = env.storage.setItem;
  env.storage.setItem = (key, value) => { if (key === pendingKey) throw new Error('quota'); write(key, value); };
  const page = env.page();
  await page.submit();
  assert.equal(env.posts.length, 0);
  assert.ok(env.values.get(draftKey));
  env.storage.setItem = write;
  env.reply(async () => { throw new Error('response lost after acceptance'); });
  await page.submit();
  assert.equal(env.posts.length, 1);
  const first = env.posts[0].payload;
  assert.equal(cart.getItems().length, 1);
  assert.ok(env.values.get(pendingKey));
  env.rejectCatalog();
  const restored = env.page();
  env.reply(async payload => ({ ok: true, json: async () => ({ ok: true, orderId: payload.orderId }) }));
  await restored.submit();
  assert.deepEqual(env.posts[1].payload, first);
  assert.equal(cart.getItems().length, 0);
  assert.equal(env.values.has(pendingKey), false);
  assert.equal(env.values.has(draftKey), false);
  assert.equal(restored.resets, 1);
});

test('checkout-storage-hardening: accepted card retry is blocked on failed readback, then recovers unchanged after F5', async () => {
  const env = setup('card');
  const page = env.page();
  env.reply(async payload => ({ ok: false, json: async () => ({ accepted: true, orderId: payload.orderId, message: 'Повторите попытку' }) }));
  await page.submit();
  const first = env.posts[0].payload;
  assert.match(page.notice.textContent, /сохранён/);
  env.rejectCatalog();
  const read = env.storage.getItem;
  env.storage.getItem = key => key === pendingKey ? null : read(key);
  await page.submit();
  assert.equal(env.posts.length, 1);
  assert.equal(cart.getItems().length, 1);
  env.storage.getItem = read;
  const restored = env.page();
  env.reply(async () => ({ ok: true, json: async () => ({ url: 'http://localhost:4176/mock-bank' }) }));
  await restored.submit();
  assert.deepEqual(env.posts[1].payload, first);
  assert.deepEqual(env.redirects, ['http://localhost:4176/mock-bank']);
  assert.equal(cart.getItems().length, 1);
  assert.ok(env.values.get(draftKey));
});

test('checkout-storage-hardening: safe preview still sends no payment POST', async () => {
  const env = setup();
  globalThis.__LE_STOREFRONT_CONFIG__ = runtimeConfig('preview');
  await env.page().submit();
  assert.equal(env.posts.length, 0);
  assert.equal(cart.getItems().length, 1);
});
