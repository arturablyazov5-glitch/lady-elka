import { CAPTION_LIMIT, contactButtons, sendNotification, visibleLength } from '../_shared/telegram-notify.mjs';
const labels = { question: 'Вопрос / обратная связь', installment: 'Рассрочка', consultation: 'Консультация', wholesale: 'Оптовый прайс', callback: 'Заказ звонка' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
export function normalizeLead(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Некорректная заявка');
  if (!uuid.test(data.id || '') || !Object.hasOwn(labels, data.type)) throw new Error('Некорректный тип или номер заявки');
  if (data.consent !== true) throw new Error('Подтвердите согласие на обработку персональных данных');
  const text = (key, max) => {
    if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error('Некорректное поле');
    const value = (data[key] || '').trim();
    if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Превышена длина или некорректное поле');
    return value;
  };
  const phoneInput = text('phone', 40);
  let digits = phoneInput.replace(/\D/g, '');
  if (!/^[+\d\s()\-]+$/.test(phoneInput)) throw new Error('Введите корректный телефон');
  if (digits.length === 10) digits = '7' + digits;
  if (digits.startsWith('8') && digits.length === 11) digits = '7' + digits.slice(1);
  if (!/^7\d{10}$/.test(digits)) throw new Error('Введите корректный российский телефон');
  const value = { type: data.type, name: text('name', 120), phone: '+' + digits, email: text('email', 200),
    comment: text('comment', 1500), city: text('city', 100), business: text('business', 200), page: text('page', 500), consent: true };
  // Optional extras (only stored when sent, so fingerprints of existing leads stay the same).
  for (const [key, max] of [['product', 200], ['contact_method', 40]]) { const extra = text(key, max); if (extra) value[key] = extra; }
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) throw new Error('Введите корректный email');
  if (data.type !== 'question' && !value.name) throw new Error('Введите имя');
  if (['question','installment','consultation'].includes(data.type) && !value.comment) throw new Error('Введите вопрос или комментарий');
  if (data.type === 'wholesale' && (!value.email || !value.city || !value.business)) throw new Error('Заполните email, город и сферу деятельности');
  let page;
  try { page = new URL(value.page); } catch { throw new Error('Некорректная страница'); }
  if (!['https:', 'http:'].includes(page.protocol) || page.username || page.password) throw new Error('Некорректная страница');
  // Query strings can contain private tokens: retain only the page path.
  value.page = page.origin + page.pathname;
  return value;
}
const icons = { question: '❓', installment: '💳', consultation: '🎄', wholesale: '📦', callback: '📞' };
export const DEFAULT_LEAD_PHOTO_URL = 'https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/telegram-assets/lead-notification.png';
export const shortId = id => String(id || '').slice(0, 8);
const formatPhone = phone => { const d = String(phone).replace(/\D/g, ''); return /^7\d{10}$/.test(d) ? `+7 ${d.slice(1,4)} ${d.slice(4,7)}-${d.slice(7,9)}-${d.slice(9)}` : String(phone); };
const pageLabel = page => { try { const u = new URL(page); let label = u.host.replace(/^www\./, '') + decodeURI(u.pathname).replace(/\/$/, ''); return label.length > 60 ? label.slice(0, 59) + '…' : label; } catch { return String(page); } };
// One builder for caption and full text; `comment` lets the caption carry a shortened comment.
function leadHtml(row, comment) {
  const p = row.payload;
  const request = [ ...(comment ? [escapeHtml(comment)] : []), ...(p.product ? [`Товар: ${escapeHtml(p.product)}`] : []),
    ...(p.city ? [`Город: ${escapeHtml(p.city)}`] : []), ...(p.business ? [`Сфера деятельности: ${escapeHtml(p.business)}`] : []) ];
  const client = [ ...(p.name ? [escapeHtml(p.name)] : []), formatPhone(p.phone), ...(p.email ? [escapeHtml(p.email)] : []),
    ...(p.contact_method ? [`Связаться: ${escapeHtml(p.contact_method)}`] : []) ];
  return [ `<b>${icons[p.type] || '📝'} ${escapeHtml(labels[p.type] || 'Заявка')}</b>`,
    ...(request.length ? ['', '<b>Заявка:</b>', ...request] : []),
    '', '<b>Клиент:</b>', ...client,
    '', '<b>Откуда:</b>', `<a href="${escapeHtml(p.page)}">${escapeHtml(pageLabel(p.page))}</a>` ].join('\n');
}
// Full notification (text-mode fallback, owner alerts).
export function telegramText(row) { return leadHtml(row, row.payload?.comment || ''); }
// Photo caption within Telegram's 1024 limit: the comment is shortened with «…» and the full text goes as a follow-up.
export function leadCaption(row) {
  const comment = row.payload?.comment || '';
  const full = leadHtml(row, comment);
  if (visibleLength(full) <= CAPTION_LIMIT) return { caption: full, truncated: false };
  const chars = [...comment];
  let low = 0, high = chars.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (visibleLength(leadHtml(row, chars.slice(0, mid).join('').trimEnd() + '…')) <= CAPTION_LIMIT) low = mid; else high = mid - 1; }
  return { caption: leadHtml(row, chars.slice(0, low).join('').trimEnd() + '…'), truncated: true };
}
export function leadFullComment(row) {
  return `<b>Полный текст заявки №</b><code>${escapeHtml(shortId(row.id))}</code>\n\n${escapeHtml(row.payload?.comment || '')}`;
}
export const leadKeyboard = row => contactButtons(row.payload?.phone);
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2,'0')).join('');
export const LEAD_SITE_ORIGINS = ['https://lady-elka.ru', 'https://www.lady-elka.ru',
  'https://arturablyazov5-glitch-lady-elka-cloud-preview-3626.twc1.net'];
export function createLeadHandler({ env, fetch: request = fetch, evidence = event => console.log(JSON.stringify(event)) }) {
  const get = key => env(key) || '';
  const database = async (path, body) => {
    if (!get('SUPABASE_URL') || !get('SUPABASE_SERVICE_ROLE_KEY')) throw new Error('storage');
    const response = await request(`${get('SUPABASE_URL')}/rest/v1/${path}`, { method: body ? 'POST' : 'GET',
      headers: { apikey: get('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error('storage');
    return response.status === 204 ? null : response.json();
  };
  const recipients = () => [...new Set(get('TG_CHAT_IDS').split(/[\s,;]+/).filter(id => /^-?\d+$/.test(id)))];
  const photoUrl = () => { const v = get('LEAD_PHOTO_URL').trim(); return v === 'off' ? '' : v || DEFAULT_LEAD_PHOTO_URL; };
  // Error codes are short and non-sensitive (never the token URL or personal data).
  const notify = (chat, message) => sendNotification({ fetch: request, token: get('TG_BOT_TOKEN'), chat, ...message });
  // Sends to every not-yet-acknowledged recipient of an already leased (claimed) lead.
  // Acks per chat: `<chat>` = banner/main message, `<chat>#full` = full comment when the caption was shortened.
  // A retry never repeats a part that is already acknowledged.
  const sendClaimed = async (claimed, token) => {
    const chats = claimed.recipients?.length ? claimed.recipients : recipients();
    const delivered = new Set(claimed.delivered_to || []);
    const before = delivered.size;
    const { caption, truncated } = leadCaption(claimed);
    const ack = async (key, sent) => {
      delivered.add(key);
      await database('rpc/le_ack_lead', { p_id: claimed.id, p_token: token, p_chat: key });
      // sendNotification validated Telegram ok, message_id and exact chat match.
      // Keep acknowledgement evidence without tokens, contacts or recipient IDs.
      try { evidence({ event: 'lead_telegram_ack', lead_id: claimed.id,
        recipient_sha256: await hash(key.replace(/#full$/, '')), part: key.endsWith('#full') ? 'full' : 'main',
        message_id: sent.messageId, recipient_match: true, telegram_ok: true }); } catch { /* logging cannot change delivery */ }
    };
    let error = !get('TG_BOT_TOKEN') || !chats.length ? 'telegram_not_configured' : null;
    if (!error) for (const chat of chats) {
      if (!delivered.has(chat)) {
        const sent = await notify(chat, { photoUrl: photoUrl(), caption, text: telegramText(claimed), keyboard: leadKeyboard(claimed) });
        if (!sent.ok) { error = sent.error; continue; }
        await ack(chat, sent);
        // Text fallback already carried the whole comment.
        if (truncated && sent.mode !== 'photo') await ack(`${chat}#full`, sent);
      }
      if (truncated && !delivered.has(`${chat}#full`)) {
        const sent = await notify(chat, { text: leadFullComment(claimed) });
        if (!sent.ok) { error = sent.error; continue; }
        await ack(`${chat}#full`, sent);
      }
    }
    const complete = chats.length > 0 && chats.every(chat => delivered.has(chat) && (!truncated || delivered.has(`${chat}#full`)));
    const finished = await database('rpc/le_finish_lead_attempt', { p_id: claimed.id, p_token: token, p_delivered: [...delivered],
      p_complete: complete, p_error: complete ? null : error });
    return { complete, progress: delivered.size > before, status: finished?.delivery_status || (complete ? 'delivered' : 'pending') };
  };
  const deliver = async row => {
    if (!get('TG_BOT_TOKEN') || !(row.recipients?.length || recipients().length)) return false;
    // A client replay before the backoff expires is answered from the inbox (202 pending) without Telegram.
    // The DB claim enforces the same rule atomically; this only saves a round trip.
    if (row.delivery_status !== 'pending' || (row.attempt_count > 0 && new Date(row.next_attempt_at) > new Date())) return false;
    const token = crypto.randomUUID();
    const claimed = await database('rpc/le_claim_lead', { p_id: row.id, p_token: token });
    if (!claimed) return row.delivery_status === 'delivered';
    return (await sendClaimed(claimed, token)).complete;
  };
  // Owner alerts go ONLY to a private chat (positive id), never to a group.
  const ownerChat = () => {
    const explicit = get('LEAD_ALERT_CHAT_ID').trim();
    if (explicit) return /^\d+$/.test(explicit) ? explicit : '';
    const personal = recipients().filter(id => /^\d+$/.test(id));
    return personal.length === 1 ? personal[0] : '';
  };
  const alertText = row => {
    const chats = row.recipients || [];
    const missing = chats.filter(chat => !(row.delivered_to || []).includes(chat)).length; // main message per chat
    return [ '⚠️ <b>Заявка не доставлена в Telegram</b>',
      `Попыток: ${escapeHtml(row.attempt_count)}; статус: ${row.delivery_status === 'failed' ? 'автоповтор остановлен (failed)' : 'повтор продолжается (pending)'}`,
      `Не доставлено получателям: ${missing} из ${chats.length}`, `Последняя ошибка: ${escapeHtml(row.last_error || '—')}`,
      '', telegramText(row) ].join('\n');
  };
  const runRetry = async ({ manual }) => {
    const deadline = Date.now() + Number(get('LEAD_RETRY_BUDGET_MS') || 60000);
    const summary = { ok: true, attempted: 0, delivered: 0, failed: 0, alerts: { sent: 0, failed: 0 } };
    for (let n = 0; n < 10 && Date.now() < deadline; n++) {
      const token = crypto.randomUUID();
      const claimed = await database('rpc/le_claim_next_lead', { p_token: token, p_manual: manual });
      if (claimed?.disabled) return { ...summary, disabled: true };
      if (!claimed) break;
      summary.attempted++;
      const result = await sendClaimed(claimed, token);
      if (result.complete) summary.delivered++;
      if (result.status === 'failed') summary.failed++;
      // Circuit breaker: Telegram made no progress -> do not burn attempts of the remaining queue.
      if (!result.complete && !result.progress) break;
    }
    const owner = ownerChat();
    if (!owner) { summary.alerts.skipped = 'no_private_owner_chat'; return summary; }
    for (let n = 0; n < 10 && Date.now() < deadline; n++) {
      const token = crypto.randomUUID();
      const claimed = await database('rpc/le_claim_lead_alert', { p_token: token, p_manual: manual });
      if (!claimed || claimed.disabled) break;
      const sent = get('TG_BOT_TOKEN') ? await notify(owner, { text: alertText(claimed), keyboard: leadKeyboard(claimed) }) : { ok: false };
      await database('rpc/le_finish_lead_alert', { p_id: claimed.id, p_token: token, p_ok: sent.ok });
      if (!sent.ok) { summary.alerts.failed++; break; }
      summary.alerts.sent++;
    }
    return summary;
  };
  return async req => {
    const origin = req.headers.get('origin') || '';
    // Lead-only addition: retain every configured origin without changing shared pay secrets.
    const allowed = [...new Set([...get('CORS_ORIGIN').split(',').map(s => s.trim()).filter(Boolean), ...LEAD_SITE_ORIGINS])];
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type,authorization,x-lead-retry-token',
      'Access-Control-Expose-Headers': 'Retry-After', 'Access-Control-Expose-Headers': 'Retry-After', Vary: 'Origin', 'Cache-Control': 'no-store' };
    const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
    if (origin && !allowed.includes('*') && !allowed.includes(origin)) return reply(403, { ok: false, message: 'Недопустимый источник' });
    if (req.method === 'OPTIONS') return reply(204, null);
    if (req.method !== 'POST') return reply(405, { ok: false, message: 'Используйте POST' });
    if (new URL(req.url).searchParams.get('action') === 'retry') {
      const secret = get('LEAD_RETRY_TOKEN');
      if (secret.length < 32 || await hash(req.headers.get('x-lead-retry-token') || '') !== await hash(secret)) return reply(401, { ok: false });
      let manual = false;
      try { manual = (await req.json())?.manual === true; } catch { /* cron sends {} */ }
      try { return reply(200, await runRetry({ manual })); }
      catch { return reply(503, { ok: false, message: 'Повторите позже' }); }
    }
    if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return reply(415, { ok: false, message: 'Требуется JSON' });
    let data;
    try {
      const reader = req.body?.getReader();
      if (!reader) throw new Error('empty');
      const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 12000) { await reader.cancel(); return reply(413, { ok: false, message: 'Слишком большая заявка' }); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return reply(400, { ok: false, message: 'Некорректный JSON' }); }
    if (data?.website) return reply(200, { ok: true, message: 'Заявка принята' }); // Honeypot: no DB/TG side effects.
    let payload;
    try { payload = normalizeLead(data); } catch (error) { return reply(400, { ok: false, message: error.message }); }
    try {
      // Supabase gateway supplies the client's address; do not store raw IP.
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
      const salt = get('SUPABASE_SERVICE_ROLE_KEY');
      const row = await database('rpc/le_accept_lead', { p_id: data.id, p_fingerprint: await hash(JSON.stringify(payload)), p_payload: payload,
        p_ip_hash: await hash(salt + ':ip:' + ip), p_phone_hash: await hash(salt + ':phone:' + payload.phone), p_recipients: recipients() });
      if (row.error === 'conflict') return reply(409, { ok: false, message: 'Номер заявки уже используется с другими данными' });
      if (row.error === 'rate_limit') { headers['Retry-After'] = '600'; return reply(429, { ok: false, message: 'Слишком много заявок. Повторите позже или позвоните нам.' }); }
      let delivered = row.delivery_status === 'delivered';
      if (!delivered) { try { delivered = await deliver(row); } catch { /* already saved; report accepted */ } }
      return reply(delivered ? 200 : 202, { ok: true, accepted: true, id: row.id, notification: delivered ? 'delivered' : 'pending', message: 'Заявка принята. Мы свяжемся с вами.' });
    } catch { return reply(503, { ok: false, message: 'Не удалось сохранить заявку. Повторите отправку позже.' }); }
  };
}
