// Local-only Alfa/Telegram stand-in. This function is staged into the
// disposable Supabase project by scripts/supabase-local-integration.mjs.
type JsonObject = Record<string, unknown>;

const supabaseUrl = (Deno.env.get('SUPABASE_URL') || 'http://kong:8000').replace(/\/$/, '');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const botToken = Deno.env.get('TG_BOT_TOKEN') || '';
const publicApiUrl = (Deno.env.get('LOCAL_INTEGRATION_PUBLIC_API_URL') || '').replace(/\/$/, '');

function assertLocalUrl(raw: string): URL {
  const url = new URL(raw);
  if (Deno.env.get('LOCAL_INTEGRATION_NETWORK_GUARD') === '1'
      && (url.protocol !== 'http:' || url.hostname !== 'kong' || url.port !== '8000')) {
    throw new Error('Local integration network guard blocked mock-provider request');
  }
  return url;
}

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  if (!serviceKey) throw new Error('Local mock service key is missing');
  const url = assertLocalUrl(`${supabaseUrl}/rest/v1/${path}`);
  return fetch(url, {
    ...init,
    redirect: 'error',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function json(response: Response): Promise<JsonObject[]> {
  if (!response.ok) throw new Error(`Local mock storage returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  return Array.isArray(value) ? value.filter((row): row is JsonObject => typeof row === 'object' && row !== null) : [];
}

async function state(): Promise<JsonObject> {
  const rows = await json(await admin('local_provider_state?id=eq.1&select=config'));
  const value = rows[0]?.config;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

async function record(provider: 'alfa' | 'telegram', operation: string, details: JsonObject = {}): Promise<void> {
  const response = await admin('local_provider_calls', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ provider, operation, details })
  });
  if (!response.ok) throw new Error(`Local mock call log returned HTTP ${response.status}`);
}

async function payment(paymentId: string): Promise<JsonObject | null> {
  const rows = await json(await admin(`local_provider_payments?payment_id=eq.${encodeURIComponent(paymentId)}&select=*`));
  return rows[0] || null;
}

async function savePayment(value: JsonObject): Promise<void> {
  const response = await admin('local_provider_payments?on_conflict=payment_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error(`Local mock payment storage returned HTTP ${response.status}`);
}

function result(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function orderIdFromMessage(body: JsonObject): string {
  const text = String(body.text || body.caption || '');
  return text.match(/Новый заказ № ([^<\n]+)/)?.[1]?.trim() || '';
}

Deno.serve(async request => {
  try {
    const url = new URL(request.url);
    const path = url.pathname.split('/functions/v1/local-mock-provider').at(-1) || '/';

    if (request.method === 'GET' && path === '/payment-form') {
      return new Response('<!doctype html><title>Локальная тестовая оплата</title><h1>Локальная имитация оплаты</h1>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    if (request.method !== 'POST') return result({ error: 'Method not allowed' }, 405);
    if (Deno.env.get('LOCAL_INTEGRATION_NETWORK_GUARD') === '1') {
      const publicUrl = new URL(publicApiUrl);
      if (publicUrl.protocol !== 'http:' || publicUrl.hostname !== '127.0.0.1'
          || !publicUrl.port || publicUrl.username || publicUrl.password) {
        return result({ error: 'Local integration API must be loopback only' }, 500);
      }
    }

    let alfaForm: URLSearchParams | null = null;
    if (path.startsWith('/alfa/')) {
      alfaForm = new URLSearchParams(await request.text());
      const user = Deno.env.get('ALFA_API_USER');
      const pass = Deno.env.get('ALFA_API_PASS');
      if (!user || !pass || alfaForm.get('userName') !== user || alfaForm.get('password') !== pass) {
        return result({ errorCode: '5', errorMessage: 'Local mock credentials mismatch' }, 401);
      }
    }
    const config = await state();
    const delayMs = Math.min(2000, Math.max(0, Number(config.delay_ms) || 0));
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));

    if (path.startsWith('/alfa/')) {
      const operation = path.slice('/alfa/'.length);
      const form = alfaForm!;
      if (operation === 'register.do') {
        const orderNumber = form.get('orderNumber') || '';
        const amountKopecks = Number(form.get('amount'));
        await record('alfa', 'register', { orderNumber, amountKopecks });
        if (config.alfa_register === 'reject') {
          return result({ errorCode: '7', errorMessage: 'Local mock explicit rejection' });
        }
        const paymentId = crypto.randomUUID();
        const initialStatus = Number(config.alfa_status) === 2 ? 2 : 0;
        await savePayment({ payment_id: paymentId, order_number: orderNumber,
          amount_kopecks: amountKopecks, order_status: initialStatus });
        if (config.alfa_register === 'unknown') {
          return result({ errorCode: 'mock_timeout', errorMessage: 'Local mock dropped registration acknowledgement' }, 503);
        }
        return result({ orderId: paymentId,
          formUrl: `${publicApiUrl}/functions/v1/local-mock-provider/payment-form?mdOrder=${encodeURIComponent(paymentId)}` });
      }
      if (operation === 'getOrderStatusExtended.do') {
        const paymentId = form.get('orderId') || '';
        await record('alfa', 'status', { paymentId });
        const found = await payment(paymentId);
        if (!found) return result({ errorCode: '6' });
        const status = Number(config.alfa_status) === 2 ? 2 : Number(found.order_status) || 0;
        return result({ errorCode: '0', orderNumber: found.order_number, orderStatus: status,
          amount: Number(found.amount_kopecks), orderDescription: `Mock payment for ${found.order_number}`,
          paymentState: status === 2 ? 'DEPOSITED' : 'CREATED' });
      }
      return result({ error: 'Unknown local Alfa operation' }, 404);
    }

    if (path.startsWith('/telegram/')) {
      const parts = path.slice('/telegram/'.length).split('/');
      const suppliedToken = (parts.shift() || '').replace(/^bot/, '');
      const operation = parts[0] || '';
      if (!botToken || suppliedToken !== botToken) return result({ ok: false, description: 'Mock token mismatch' }, 401);
      const body = await request.json().catch(() => ({})) as JsonObject;
      const chatId = String(body.chat_id || '');
      await record('telegram', operation, { chatId, orderId: orderIdFromMessage(body) });
      if (['sendMessage', 'sendPhoto'].includes(operation)) {
        const mode = String(config.telegram || 'success');
        const reject = mode === 'reject'
          || mode === 'partial' && chatId === String(config.telegram_fail_chat || 'mock-chat-2')
          || mode === 'photo-reject' && operation === 'sendPhoto';
        if (mode === 'unknown') return result({ ok: false, description: 'Local mock acknowledgement lost' }, 503);
        if (reject) return result({ ok: false, error_code: 400, description: 'Local mock explicit rejection' }, 400);
      }
      return result({ ok: true, result: { message_id: Date.now() } });
    }

    return result({ error: 'Unknown local mock route' }, 404);
  } catch {
    // Do not log provider bodies, tokens, or checkout messages.
    return result({ error: 'Local mock provider failed' }, 500);
  }
});
