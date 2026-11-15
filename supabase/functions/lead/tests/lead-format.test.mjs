// New lead notification look: banner photo + HTML caption + contact buttons, 1024 caption limit, fallbacks, retries.
// Telegram is synthetic; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadHandler, normalizeLead, telegramText, leadCaption, leadKeyboard, leadFullComment, DEFAULT_LEAD_PHOTO_URL } from '../handler.mjs';
import { visibleLength, plainText, contactButtons, CAPTION_LIMIT } from '../../_shared/telegram-notify.mjs';
import { leadDatabase } from './database.mjs';

const PERSONAL = '101', GROUP = '-100202';
let seq = 0;
const input = (extra = {}) => ({ id: crypto.randomUUID(), type: 'consultation', name: 'Анна <b>&', phone: `8 (999) 123-${String(4500 + ++seq).slice(-4, -2)}-${String(seq).padStart(2, '0').slice(-2)}`,
  email: 'anna@example.test', comment: 'Нужна ёлка 2,1 м <script>alert(1)</script>', page: 'https://lady-elka.ru/catalog/karolina?utm=secret"x', consent: true, ...extra });
const row = (extra = {}) => { const payload = normalizeLead(input(extra)); return { id: crypto.randomUUID(), created_at: '2026-10-10T11:05:00Z', payload }; };

test('caption: typed bold title, blocks, escaping, clickable phone text, no noise or duplicates', () => {
  const r = row({ product: 'Ёлка «Каролина» 210 см', contact_method: 'WhatsApp' });
  const { caption, truncated } = leadCaption(r);
  assert.equal(truncated, false);
  assert.equal(caption, telegramText(r));
  const lines = caption.split('\n');
  assert.equal(lines[0], '<b>🎄 Консультация</b>');
  for (const block of ['<b>Заявка:</b>', '<b>Клиент:</b>', '<b>Откуда:</b>']) assert.equal(lines.filter(l => l === block).length, 1);
  assert.ok(caption.includes('Нужна ёлка 2,1 м &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(caption.includes('Анна &lt;b&gt;&amp;'));
  assert.ok(!/<script>|<b>&/.test(caption));
  assert.ok(caption.includes('Товар: Ёлка «Каролина» 210 см'));
  assert.ok(caption.includes('Связаться: WhatsApp'));
  assert.match(caption, /\n\+7 999 123-\d\d-\d\d\n/);
  assert.ok(caption.includes('<a href="https://lady-elka.ru/catalog/karolina">lady-elka.ru/catalog/karolina</a>')); // query dropped
  assert.ok(!caption.includes('10.10.2026'));
  assert.ok(!caption.includes('(МСК)'));
  assert.ok(!caption.includes('№ '));
  assert.ok(!caption.includes(r.id));
  assert.ok(!caption.includes('согласие на обработку данных'));
  assert.ok(caption.endsWith('lady-elka.ru/catalog/karolina</a>'));
  assert.ok(!caption.includes('—'), 'no empty-field placeholders');
  // Question without name/email: no empty lines for missing fields, no Заявка duplicates.
  const q = { id: crypto.randomUUID(), created_at: '2026-10-10T11:05:00Z', payload: normalizeLead({ ...input({ type: 'question' }), name: '', email: '' }) };
  const qc = leadCaption(q).caption;
  assert.ok(qc.startsWith('<b>❓ Вопрос / обратная связь</b>'));
  assert.ok(!qc.includes('\n\n\n')); assert.ok(!qc.includes('@'));
  // Wholesale: city/business inside Заявка.
  const w = { id: crypto.randomUUID(), created_at: '2026-10-10T11:05:00Z', payload: normalizeLead(input({ type: 'wholesale', comment: '', city: 'Казань', business: 'Декор' })) };
  const wc = leadCaption(w).caption;
  assert.ok(wc.startsWith('<b>📦 Оптовый прайс</b>')); assert.ok(wc.includes('<b>Заявка:</b>\nГород: Казань\nСфера деятельности: Декор'));
});

test('optional product/contact_method do not change normalized payloads of existing leads (fingerprint-stable)', () => {
  const base = input();
  assert.deepEqual(Object.keys(normalizeLead(base)).sort(), ['comment','consent','email','name','page','phone','type'].concat(['business','city']).sort());
  assert.throws(() => normalizeLead({ ...base, product: 'x'.repeat(201) }));
  assert.throws(() => normalizeLead({ ...base, contact_method: 5 }));
});

test('caption limit 1024 (visible length): long comment shortened with «…»; full text is a separate message', () => {
  const emoji = '🎄'.repeat(20);
  const r = row({ comment: emoji + ' ' + 'Очень длинный вопрос & <тег>. '.repeat(48).slice(0, 1450) });
  const { caption, truncated } = leadCaption(r);
  assert.equal(truncated, true);
  assert.ok(visibleLength(caption) <= CAPTION_LIMIT);
  assert.ok(visibleLength(caption) > CAPTION_LIMIT - 40, 'uses the available space');
  assert.match(caption, /…\n/);
  assert.ok(!/&[a-z#0-9]*…/.test(caption), 'never cuts inside an HTML entity');
  assert.ok(!caption.includes('\ud83c…'), 'never splits a surrogate pair');
  const full = leadFullComment(r);
  assert.ok(full.includes(`<code>${r.id.slice(0, 8)}</code>`)); assert.ok(full.includes('&lt;тег&gt;'));
  assert.equal(visibleLength('<b>a</b>&amp;&lt;'), 3);
  assert.equal(plainText('<b>x</b> <a href="https://a.test/">a.test</a> &amp;'), 'x a.test (https://a.test/) &');
});

test('contact buttons: WhatsApp + Telegram by phone, no tel: and no status callbacks', () => {
  const kb = leadKeyboard(row());
  assert.equal(kb.length, 1);
  const [wa, tg] = kb[0];
  assert.match(wa.url, /^https:\/\/wa\.me\/7999123\d{4}$/); assert.equal(wa.text, 'WhatsApp');
  assert.match(tg.url, /^https:\/\/t\.me\/\+7999123\d{4}$/); assert.equal(tg.text, 'Telegram');
  assert.ok(kb.flat().every(b => !b.callback_data && !b.url.startsWith('tel:')));
  assert.deepEqual(contactButtons('+1 555 0100'), []);
});

async function harness(extraEnv = {}) {
  const { db, request } = await leadDatabase();
  const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', TG_BOT_TOKEN: 'synthetic',
    TG_CHAT_IDS: `${PERSONAL},${GROUP}`, CORS_ORIGIN: 'https://lady-elka.ru', LEAD_RETRY_TOKEN: 'synthetic-retry-token-0123456789abcdef', ...extraEnv };
  const tg = { calls: [], rule: () => null };
  const handler = createLeadHandler({ env: k => env[k], fetch: async (url, options) => {
    if (url.startsWith('https://db.test/')) return request(url, options);
    const method = /\/botsynthetic\/(sendPhoto|sendMessage)$/.exec(url)?.[1]; assert.ok(method, url);
    const body = JSON.parse(options.body);
    tg.calls.push({ method, ...body });
    const forced = tg.rule(method, body);
    if (forced) return new Response(JSON.stringify({ ok: false, description: 'synthetic' }), { status: forced });
    return Response.json({ ok: true, result: { chat: { id: Number(body.chat_id) }, message_id: tg.calls.length } });
  } });
  const post = data => handler(new Request('https://edge.test/lead', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://lady-elka.ru', 'x-forwarded-for': `10.1.0.${++seq}` }, body: JSON.stringify(data) }));
  const dbRow = async id => (await db.query('select * from le_leads where id=$1', [id])).rows[0];
  return { db, env, tg, handler, post, dbRow };
}

test('delivery: banner photo with caption + keyboard to each recipient; long comment adds one full-text message per chat', async t => {
  const h = await harness(); t.after(() => h.db.close());
  const p = input();
  assert.equal((await h.post(p)).status, 200);
  assert.deepEqual(h.tg.calls.map(c => [c.method, c.chat_id]), [['sendPhoto', PERSONAL], ['sendPhoto', GROUP]]);
  const photo = h.tg.calls[0];
  assert.equal(photo.photo, DEFAULT_LEAD_PHOTO_URL); assert.equal(photo.parse_mode, 'HTML');
  assert.ok(photo.caption.startsWith('<b>🎄 Консультация</b>'));
  assert.equal(photo.reply_markup.inline_keyboard[0].length, 2);
  // Long comment
  h.tg.calls.length = 0;
  const long = input({ comment: 'Длинный вопрос. '.repeat(90).slice(0, 1400) });
  assert.equal((await h.post(long)).status, 200);
  assert.deepEqual(h.tg.calls.map(c => [c.method, c.chat_id]),
    [['sendPhoto', PERSONAL], ['sendMessage', PERSONAL], ['sendPhoto', GROUP], ['sendMessage', GROUP]]);
  assert.ok(h.tg.calls[1].text.includes('Полный текст заявки'));
  assert.ok(visibleLength(h.tg.calls[0].caption) <= 1024);
  const r = await h.dbRow(long.id);
  assert.deepEqual([...r.delivered_to].sort(), [PERSONAL, `${PERSONAL}#full`, GROUP, `${GROUP}#full`].sort());
});

test('fallbacks: photo rejected -> text (full comment, keyboard); 429 -> no fallback, retried later; markup rejected -> plain; LEAD_PHOTO_URL=off', async t => {
  const h = await harness({ TG_CHAT_IDS: PERSONAL }); t.after(() => h.db.close());
  // Bad/unreachable photo: Telegram 400 on sendPhoto.
  h.tg.rule = method => method === 'sendPhoto' ? 400 : null;
  const long = input({ comment: 'Длинный вопрос. '.repeat(90).slice(0, 1400) });
  assert.equal((await h.post(long)).status, 200);
  assert.deepEqual(h.tg.calls.map(c => c.method), ['sendPhoto', 'sendMessage']);
  assert.ok(h.tg.calls[1].text.includes('Длинный вопрос. '.repeat(80).trim()), 'text fallback carries the full comment');
  assert.ok(h.tg.calls[1].reply_markup.inline_keyboard[0][0].url.startsWith('https://wa.me/'));
  assert.deepEqual([...(await h.dbRow(long.id)).delivered_to].sort(), [PERSONAL, `${PERSONAL}#full`].sort());
  // Rate limit: transient, nothing else is tried, lead stays pending.
  h.tg.calls.length = 0; h.tg.rule = () => 429;
  const p = input();
  const res = await h.post(p); assert.equal(res.status, 202);
  assert.deepEqual(h.tg.calls.map(c => c.method), ['sendPhoto']);
  assert.equal((await h.dbRow(p.id)).last_error, 'telegram_http_429');
  // Telegram rejects the HTML (e.g. an entity it can't parse): photo 400, text 400 -> plain text, no parse_mode.
  h.tg.calls.length = 0; h.tg.rule = (method, body) => body.parse_mode === 'HTML' ? 400 : null;
  const q = input();
  assert.equal((await h.post(q)).status, 200);
  assert.deepEqual(h.tg.calls.map(c => [c.method, c.parse_mode ?? null]), [['sendPhoto', 'HTML'], ['sendMessage', 'HTML'], ['sendMessage', null]]);
  assert.ok(h.tg.calls[2].text.startsWith('🎄 Консультация\n'));
  assert.ok(h.tg.calls[2].text.includes('lady-elka.ru/catalog/karolina (https://lady-elka.ru/catalog/karolina)'));
  // Photo disabled by config.
  const off = await harness({ TG_CHAT_IDS: PERSONAL, LEAD_PHOTO_URL: 'off' }); t.after(() => off.db.close());
  assert.equal((await off.post(input())).status, 200);
  assert.deepEqual(off.tg.calls.map(c => c.method), ['sendMessage']);
});

test('retries never duplicate a delivered banner: only the missing part/recipient is sent', async t => {
  const h = await harness(); t.after(() => h.db.close());
  await h.db.query('update le_lead_retry_settings set enabled=true');
  // Banner reaches both chats, but the follow-up full text fails for the group (transient).
  h.tg.rule = (method, body) => method === 'sendMessage' && body.chat_id === GROUP ? 502 : null;
  const long = input({ comment: 'Длинный вопрос. '.repeat(90).slice(0, 1400) });
  assert.equal((await h.post(long)).status, 202);
  assert.deepEqual(h.tg.calls.map(c => [c.method, c.chat_id]),
    [['sendPhoto', PERSONAL], ['sendMessage', PERSONAL], ['sendPhoto', GROUP], ['sendMessage', GROUP]]);
  h.tg.calls.length = 0; h.tg.rule = () => null;
  await h.db.query('update le_leads set next_attempt_at=now()');
  const retry = await h.handler(new Request('https://edge.test/lead?action=retry', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lead-retry-token': h.env.LEAD_RETRY_TOKEN }, body: '{}' }));
  assert.equal((await retry.json()).delivered, 1);
  assert.deepEqual(h.tg.calls.map(c => [c.method, c.chat_id]), [['sendMessage', GROUP]]);
  assert.equal((await h.dbRow(long.id)).delivery_status, 'delivered');
  // Group banner failed, personal fine -> retry sends the banner to the group only.
  h.tg.calls.length = 0; h.tg.rule = (method, body) => body.chat_id === GROUP ? 503 : null;
  const p = input();
  assert.equal((await h.post(p)).status, 202);
  h.tg.rule = () => null; h.tg.calls.length = 0;
  await h.db.query('update le_leads set next_attempt_at=now() where id=$1', [p.id]);
  await h.handler(new Request('https://edge.test/lead?action=retry', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lead-retry-token': h.env.LEAD_RETRY_TOKEN }, body: '{}' }));
  assert.deepEqual(h.tg.calls.map(c => [c.method, c.chat_id]), [['sendPhoto', GROUP]]);
});
