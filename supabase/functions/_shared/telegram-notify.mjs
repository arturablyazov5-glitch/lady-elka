// Shared Telegram notification mechanics (same pattern as pay's order notification):
// banner photo + HTML caption + inline keyboard, falling back to a text message when the photo can't be used.
// Pure ESM, no Deno/Node specifics: used by functions/lead (and available to pay when it is next refactored).

export const CAPTION_LIMIT = 1024;   // sendPhoto caption, counted after entity parsing
export const MESSAGE_LIMIT = 4096;   // sendMessage text

const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
// Length Telegram counts: visible text after HTML entity parsing.
export const visibleLength = html => [...String(html).replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, m => entities[m])].length;
// Plain-text twin of an HTML message (last-resort delivery when Telegram rejects the markup).
export const plainText = html => String(html).replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)').replace(/<[^>]*>/g, '')
  .replace(/&(?:amp|lt|gt|quot|#39);/g, m => entities[m]);

// Russian mobile number (+7XXXXXXXXXX) -> contact buttons. Telegram rejects tel: URLs in inline buttons,
// so calling is left to the (auto-linked) phone number in the text.
export function contactButtons(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(digits)) return [];
  return [[{ text: 'WhatsApp', url: `https://wa.me/${digits}` }, { text: 'Telegram', url: `https://t.me/+${digits}` }]];
}

/**
 * Sends one notification to one chat. Returns
 * { ok, mode: 'photo'|'text'|'plain', messageId, error, transient }.
 * - photo: sendPhoto(photoUrl, caption) when photoUrl is set and caption fits.
 * - Photo rejected definitively (4xx except 429) -> text with the same keyboard (like pay's fallback).
 * - Text rejected with 400 (markup) -> plain text without parse_mode, so the notification is never lost to formatting.
 * - 429/5xx/network/timeout -> transient failure, no fallback (the outbox retries later).
 */
export async function sendNotification({ fetch: request, token, apiBase = 'https://api.telegram.org', chat, photoUrl, caption, text, keyboard, timeoutMs = 10000 }) {
  const call = async (method, body) => {
    try {
      const response = await request(`${apiBase}/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, ...body }),
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) {
        const status = response.ok ? 400 : response.status;
        return { ok: false, status, error: `telegram_http_${response.ok ? 'not_ok' : response.status}`, transient: status === 429 || status >= 500 };
      }
      if (!result.result?.message_id) return { ok: false, status: 200, error: 'telegram_not_ok', transient: true };
      if (String(result.result?.chat?.id) !== String(chat)) return { ok: false, status: 200, error: 'telegram_chat_mismatch', transient: false };
      return { ok: true, messageId: result.result.message_id };
    } catch (error) {
      return { ok: false, error: error?.name === 'TimeoutError' ? 'telegram_timeout' : 'telegram_network', transient: true };
    }
  };
  const markup = keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
  if (photoUrl && caption && visibleLength(caption) <= CAPTION_LIMIT) {
    const sent = await call('sendPhoto', { photo: photoUrl, caption, parse_mode: 'HTML', ...markup });
    if (sent.ok) return { ...sent, mode: 'photo' };
    if (sent.transient) return sent;
  }
  const sent = await call('sendMessage', { text, parse_mode: 'HTML', disable_web_page_preview: true, ...markup });
  if (sent.ok) return { ...sent, mode: 'text' };
  if (sent.transient || sent.status !== 400) return sent;
  const plain = await call('sendMessage', { text: plainText(text).slice(0, MESSAGE_LIMIT), disable_web_page_preview: true, ...markup });
  return plain.ok ? { ...plain, mode: 'plain' } : plain;
}
