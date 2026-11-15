// Buyer-facing messages for pay/lead failures: one handler (client/request-errors.js) for checkout and lead forms.
// fetch is mocked; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConfig } from '../config/runtime.mjs';
globalThis.__LE_STOREFRONT_CONFIG__ = runtimeConfig('fixture');
const { postJson, describeFailure, retryAfterSeconds, holdSubmit, showFailure, RequestFailure } = await import('../client/request-errors.js');
const { requestLead } = await import('../client/forms.js');

const reply = (status, body, headers = {}) => async () => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => headers[name] ?? headers[name.toLowerCase()] ?? null },
  json: async () => { if (typeof body === 'string') throw new SyntaxError('Unexpected token <'); return body; },
});
const fail = async (fetchImpl, subject, opts = {}) => {
  try { await postJson('/x', {}, { fetchImpl, ...opts }); } catch (error) { return { error, d: describeFailure(error, subject) }; }
  assert.fail('expected failure');
};

test('Retry-After: seconds, HTTP date, garbage, clamp', () => {
  assert.equal(retryAfterSeconds('42'), 42);
  assert.equal(retryAfterSeconds(new Date(Date.parse('2026-10-08T10:00:00Z') + 90_000).toUTCString(), Date.parse('2026-10-08T10:00:00Z')), 90);
  assert.equal(retryAfterSeconds('soon'), null);
  assert.equal(retryAfterSeconds(null), null);
  assert.equal(retryAfterSeconds('999999'), 900);
});

for (const subject of ['order', 'lead']) {
  test(`${subject}: every status maps to its own Russian message`, async () => {
    let r = await fail(reply(429, { message: 'x' }, { 'Retry-After': '30' }), subject);
    assert.equal(r.d.kind, 'rate'); assert.equal(r.d.retryAfter, 30); assert.match(r.d.text, /Слишком много попыток, попробуйте через 30 сек/);
    r = await fail(reply(429, { ok: false }, { 'Retry-After': '600' }), subject);
    assert.match(r.d.text, /через 10 мин/);
    r = await fail(reply(429, {}), subject);
    assert.match(r.d.text, /попробуйте чуть позже/); assert.equal(r.d.retryAfter, null);
    for (const fetchImpl of [reply(503, { message: 'limiter down' }), reply(502, '<html>bad gateway</html>'), async () => { throw new TypeError('Failed to fetch'); }]) {
      r = await fail(fetchImpl, subject);
      assert.equal(r.d.contacts, true); assert.match(r.d.text, /^Сервис временно недоступен, попробуйте позже или свяжитесь с нами:/);
      assert.doesNotMatch(r.d.text, /Unexpected|fetch|limiter/);
    }
    r = await fail((url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), subject, { timeoutMs: 5 });
    assert.equal(r.d.kind, 'timeout'); assert.equal(r.d.contacts, true); assert.match(r.d.note, /номер заяв|номер заказ/);
    r = await fail(reply(400, { error: 'Invalid order', message: 'Bad items' }), subject);
    assert.equal(r.d.kind, 'invalid'); assert.match(r.d.text, /не принят/);
    r = await fail(reply(413, { ok: false, message: 'Слишком большая заявка' }), subject);
    assert.equal(r.d.kind, 'too-large'); assert.match(r.d.text, /сократите/);
    r = await fail(reply(401, { error: 'Unauthorized' }), subject);
    assert.equal(r.d.kind, 'auth'); assert.match(r.d.text, /Обновите страницу/);
  });
}

test('409: catalog change asks the cart to re-price; promo change shows the server text', async () => {
  let r = await fail(reply(409, { error: 'Catalog changed', message: 'Товар или цена изменились.' }), 'order');
  assert.equal(r.d.priceChanged, true);
  r = await fail(reply(409, { error: 'Promo changed', message: 'Промокод больше не действует. Проверьте корзину.' }), 'order');
  assert.equal(r.d.priceChanged, undefined); assert.match(r.d.text, /Промокод больше не действует/);
});

test('lead request: success only on ok:true; failure message is human text', async () => {
  globalThis.fetch = reply(200, { ok: true, id: 'a' });
  assert.equal((await requestLead({})).ok, true);
  globalThis.fetch = reply(200, { ok: false });
  await assert.rejects(requestLead({}), /Заявка не принята/);
  globalThis.fetch = reply(429, { ok: false }, { 'Retry-After': '120' });
  await assert.rejects(requestLead({}), error => error.kind === 'rate' && /через 2 мин/.test(error.message));
  globalThis.fetch = reply(503, { ok: false });
  await assert.rejects(requestLead({}), /Сервис временно недоступен.*\+7 \(925\) 936-63-00, Telegram, WhatsApp/);
  delete globalThis.fetch;
});

test('notice: contact links come from site markup; role switches to alert for errors', () => {
  const made = [];
  const node = tag => { const el = { tag, children: [], style: {}, dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { this.children.push(...c); }, addEventListener(type, fn) { this.click = fn; }, set textContent(v) { this.text = v; this.children = []; }, get textContent() { return this.text; } }; made.push(el); return el; };
  const doc = { createElement: node, createTextNode: text => ({ text }),
    querySelector: sel => sel.startsWith('a[href^="tel:"]') ? { getAttribute: () => 'tel:+7 (925) 936-63-00', textContent: ' +7 (925) 936-63-00 ' } : null };
  const notice = node('p'); notice.ownerDocument = doc;
  showFailure(notice, describeFailure(new RequestFailure('unavailable', { status: 503 }), 'lead'));
  assert.equal(notice.attrs.role, 'alert');
  const links = notice.children.filter(c => c.tag === 'a');
  assert.deepEqual(links.map(l => l.href), ['tel:+7(925)936-63-00', 'https://t.me/lady_elka', 'https://wa.me/79259366300']);
  let ran = 0;
  showFailure(notice, { kind: 'conflict', text: 'Цены изменились.' }, { action: { label: 'Обновить корзину', run: () => ran++ } });
  const button = notice.children.find(c => c.tag === 'button');
  assert.equal(button.textContent, 'Обновить корзину'); button.click(); assert.equal(ran, 1);
});

test('holdSubmit keeps the button disabled for Retry-After with a countdown, then restores it', () => {
  let tick; const button = { disabled: false }, label = { textContent: 'Отправить' };
  holdSubmit([button], [label], ['Отправить'], 3, { setTimer: fn => (tick = fn, 1), clearTimer() {} });
  assert.equal(button.disabled, true); assert.equal(label.textContent, 'Повторить через 3 сек');
  tick(); assert.equal(label.textContent, 'Повторить через 2 сек');
  tick(); tick(); assert.equal(button.disabled, false); assert.equal(label.textContent, 'Отправить');
  holdSubmit([button], [label], ['Отправить'], 0); assert.equal(button.disabled, false);
});

// Checkout harness modelled on checkout.test.mjs: real cart-store + checkout, fake form/notice, mocked fetch.
async function checkoutHarness() {
  const storage = new Map();
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  globalThis.sessionStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  globalThis.location = { origin: 'http://localhost:4176', assign() { throw new Error('no redirect expected'); } };
  const notice = { textContent: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, after() {} };
  globalThis.document = { createElement: () => notice };
  const cart = await import('../client/cart-store.js');
  const { initCheckout } = await import('../client/checkout.js');
  cart.clear();
  cart.add({ id: '1', title: 'Миранда', kind: 'tree' }, { id: '1:Зелёная:180', price: 1000, options: { category: 'Зелёная', height: '180' } });
  const values = { name: 'Иван', email: 'ivan@example.org', phone: '+7 (999) 123-45-67', address: 'Москва', contactPref: 'Telegram', paymentMethod: 'cash_on_delivery' };
  const controls = Object.fromEntries(Object.entries(values).map(([k, v]) => [`[data-checkout-field="${k}"]`, { value: v, addEventListener() {}, removeEventListener() {} }]));
  const label = { textContent: 'купить' };
  const button = { disabled: false, querySelector: () => label, after() {}, setAttribute() {} };
  let submit;
  const form = { querySelectorAll(s) { const c = this.querySelector(s); return c ? [c] : []; }, querySelector(s) {
    if (s === '[data-checkout-field="comment"]') return { value: '' };
    if (s === '[data-pay-now]') return button;
    if (s === '[data-checkout-field="consent"]') return { checked: true };
    return controls[s] || null;
  }, addEventListener(name, fn) { if (name === 'submit') submit = fn; }, reset() { throw new Error('form must not reset on failure'); } };
  initCheckout(form, () => null);
  let feedPrice = 1000, posts = 0;
  const feeds = url => url.endsWith('/trees.csv') ? { ok: true, text: async () => `id,title,active,category,height_cm,price\n1,Миранда,1,Зелёная,180,${feedPrice}\n` }
    : url.endsWith('/decor.csv') ? { ok: true, text: async () => 'id,title,active,category,variants,price\n' } : null;
  const setPay = handler => { globalThis.fetch = async (url, opts) => feeds(url) || (posts++, handler(url, opts)); };
  const run = () => submit({ preventDefault() {}, stopImmediatePropagation() {} });
  return { cart, notice, button, label, controls, run, setPay, setFeedPrice: p => { feedPrice = p; }, posts: () => posts };
}

test('checkout: 429 / 503 / network / timeout keep data, re-enable (after Retry-After) and never double-submit', async () => {
  const h = await checkoutHarness();
  h.setPay(reply(429, { message: 'x' }, { 'Retry-After': '45' }));
  await h.run();
  assert.match(h.notice.textContent, /Слишком много попыток, попробуйте через 45 сек/);
  assert.equal(h.notice.attrs.role, 'alert');
  assert.equal(h.button.disabled, true); assert.match(h.label.textContent, /Повторить через 45 сек/);
  await h.run(); assert.equal(h.posts(), 1, 'held button blocks resubmits');
  assert.equal(h.cart.getItems().length, 1); assert.equal(h.controls['[data-checkout-field="name"]'].value, 'Иван');
  // Cancel the hold the way a remount does.
  h.button.disabled = false;
  h.setPay(reply(503, { message: 'Сервис недоступен' }));
  await h.run();
  assert.match(h.notice.textContent, /Сервис временно недоступен, попробуйте позже или свяжитесь с нами: \+7 \(925\) 936-63-00/);
  assert.equal(h.button.disabled, false); assert.equal(h.label.textContent, 'купить');
  h.setPay(async () => { throw new TypeError('Failed to fetch'); });
  await h.run();
  assert.match(h.notice.textContent, /Сервис временно недоступен/);
  for (const [status, re] of [[400, /Заказ не принят/], [413, /сократите комментарий/], [401, /Обновите страницу/]]) {
    h.setPay(reply(status, { error: 'x' })); await h.run(); assert.match(h.notice.textContent, re);
    assert.equal(h.button.disabled, false);
  }
  assert.equal(h.cart.getItems().length, 1);
});

test('checkout: 409 catalog change re-prices the cart for real; unchanged feed offers «Обновить корзину»', async () => {
  const h = await checkoutHarness();
  // Server knows a newer price than the client: the feed changes between the pre-check and the POST.
  h.setPay(async () => { h.setFeedPrice(1200); return reply(409, { error: 'Catalog changed', message: 'Товар или цена изменились.' })(); });
  await h.run();
  assert.match(h.notice.textContent, /Цены обновились, корзина пересчитана/);
  assert.equal(h.cart.getItems()[0].price, 1200);
  assert.equal(h.button.disabled, false);
  // Client-side pre-check also re-prices before any POST.
  h.setFeedPrice(1500);
  const before = h.posts();
  await h.run();
  assert.equal(h.posts(), before); assert.equal(h.cart.getItems()[0].price, 1500);
  assert.match(h.notice.textContent, /Цены обновились, корзина пересчитана/);
  // 409 while the feed still shows the cart price: no fake success, manual refresh button instead (no DOM -> text only).
  h.setPay(reply(409, { error: 'Catalog changed' }));
  await h.run();
  assert.match(h.notice.textContent, /Обновите корзину/);
  assert.equal(h.cart.getItems().length, 1);
});
