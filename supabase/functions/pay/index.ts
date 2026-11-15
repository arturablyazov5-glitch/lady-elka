// Supabase Edge Function (Deno).
// Исторические маршруты PayKeeper сохранены; новый checkout использует постоянный журнал заказов/операций.
// Отличается только рантайм-обёртка внизу файла (Deno.serve) и два шима:
//   - process.env.*  → Deno.env.get (через Proxy)
//   - Buffer         → node:buffer (base64 для Basic-auth PayKeeper)
//
// Деплой:
//   supabase functions deploy pay --no-verify-jwt
// Секреты (задать один раз):
//   supabase secrets set PK_HOST=... PK_USER=... PK_PASS=... HOOK_SECRET=... \
//                        TG_BOT_TOKEN=... TG_CHAT_IDS=... CORS_ORIGIN=https://lady-elka.ru
//
// URL функции после деплоя:
//   https://<PROJECT_REF>.supabase.co/functions/v1/pay
// его нужно прописать во фронте: window.PAYMENT_ENDPOINT (src/catalog/index.js).

import { Buffer } from 'node:buffer';
import { checkoutNotification, normalizeOrderPhone } from '../_shared/order-notification.mjs';
import { contactButtons } from '../_shared/telegram-notify.mjs';
import { createOrderStore } from '../_shared/order-store.mjs';
import {
  cartSubtotal,
  checkoutTotal,
  csvRecords,
  decorProducts,
  findPromo,
  hasPromoBenefit,
  lineTotal,
  promoDetails,
  treeProducts,
} from '../_shared/product-rules.mjs';

type JsonRecord = Record<string, unknown>;
type HeaderMap = Record<string, string | undefined>;
type HeaderValues = Record<string, string>;
type PaymentKind = 'tree' | 'decor';

interface PaymentEvent {
  httpMethod?: string;
  method?: string;
  path?: string;
  rawPath?: string;
  requestContext?: { http?: { method?: string; path?: string } };
  headers?: HeaderMap;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  __data?: JsonRecord;
}

interface HttpResponse {
  statusCode: number;
  headers: HeaderValues;
  body: string;
}

interface PaymentError extends Error {
  conflict?: boolean;
  pending?: boolean;
  definite?: boolean;
  uncertain?: boolean;
  inputStatus?: number;
}

interface CheckoutItem {
  productId: string;
  variantId: string;
  kind: PaymentKind;
  quantity: number;
  price: number;
}

interface ActualCatalogItem {
  name: string;
  variantId: string;
  options: string;
  price: number;
  quantity: number;
}

interface NormalizedPayment {
  paid: boolean;
  status: string;
  invoice_id: string;
  orderId: string;
  clientId: string;
  email: string;
  phone: string;
  title: string;
  category: string;
  height_cm: string;
  amount: number;
  address: string;
  contact_pref: string;
  promo_code: string;
  promo_discount_text: string;
  promo_gift_text: string;
  cartItems: MessageItem[] | null;
  service_name: string;
  description: string;
  raw_description: string;
}

interface MessageItem {
  name: string;
  height: string;
  category: string;
  price: number;
}

interface PaymentCreationResult {
  url: string;
  paymentId: string;
  orderId: string;
  amount: number;
  description: string;
  paid?: boolean;
}

interface StoredOrder {
  order_id: string;
  fingerprint: string;
  payment_method: string;
  status: string;
  payload: JsonRecord;
  total: number | string;
  payment_id?: string | null;
  result?: PaymentCreationResult | JsonRecord | null;
  notification?: string | null;
  notification_chat_ids?: string[] | null;
  telegram_sent: boolean;
}

interface OrderStore {
  existing(orderId: string, payload: JsonRecord): Promise<StoredOrder | undefined>;
  reserve(orderId: string, payload: JsonRecord): Promise<StoredOrder>;
  update(orderId: string, patch: JsonRecord, expectedStatus?: string): Promise<void>;
  payment(paymentId: string): Promise<StoredOrder | undefined>;
  effect<T>(key: string, operation: () => Promise<T>, policy?: { automatic?: boolean; maxAttempts?: number; backoffSeconds?: number }): Promise<T>;
}

type CodValidation = HttpResponse | { notification: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringOf(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringOf(value);
    if (text.trim()) return text;
  }
  return '';
}

function paymentError(value: unknown): PaymentError {
  return value instanceof Error ? value as PaymentError : new Error(String(value));
}

function isHttpResponse(value: CodValidation): value is HttpResponse {
  return 'statusCode' in value;
}

function catalogItem(value: unknown): CheckoutItem | null {
  const item = recordOf(value);
  const kind = item.kind;
  if (kind !== 'tree' && kind !== 'decor') return null;
  return {
    productId: stringOf(item.productId),
    variantId: stringOf(item.variantId),
    kind,
    quantity: Number(item.quantity),
    price: Number(item.price)
  };
}

function jsonRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const RUSSIAN_TRUSTED_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----`;

let alfaHttpClient: Deno.HttpClient | undefined;
function getAlfaHttpClient() {
  if (!alfaHttpClient) alfaHttpClient = Deno.createHttpClient({ caCerts: [RUSSIAN_TRUSTED_ROOT_CA] });
  return alfaHttpClient;
}

const LOCAL_INTEGRATION_BLOCKED = 'LOCAL_INTEGRATION_NETWORK_BLOCKED';
function localIntegrationGuardEnabled(): boolean {
  return Deno.env.get('LOCAL_INTEGRATION_NETWORK_GUARD') === '1';
}
function checkedFetchUrl(url: string | URL | Request): string {
  const raw = url instanceof Request ? url.url : String(url);
  if (localIntegrationGuardEnabled()) {
    let parsed: URL;
    try { parsed = new URL(raw); }
    catch { throw new Error(`${LOCAL_INTEGRATION_BLOCKED}: invalid URL`); }
    // The local Supabase project puts Kong and the mock Edge Function on the
    // same internal Docker network. No provider or browser-origin host is
    // reachable from the payment function in this mode.
    if (parsed.protocol !== 'http:' || parsed.hostname !== 'kong' || parsed.port !== '8000') {
      throw new Error(`${LOCAL_INTEGRATION_BLOCKED}: request rejected before fetch`);
    }
  }
  return raw;
}
type CheckedFetchInit = RequestInit & { client?: Deno.HttpClient };
function checkedFetch(url: string | URL | Request, options: CheckedFetchInit): Promise<Response> {
  checkedFetchUrl(url);
  return globalThis.fetch(url, localIntegrationGuardEnabled() ? { ...options, redirect: 'error' } : options);
}

async function fetchAlfa(url: string, opts: RequestInit = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (localIntegrationGuardEnabled()) {
      return await checkedFetch(url, { ...opts, signal: ctrl.signal });
    }
    return await checkedFetch(url, { ...opts, signal: ctrl.signal, client: getAlfaHttpClient() });
  } finally {
    clearTimeout(timer);
  }
}

// fetch с таймаутом: без этого зависший внешний хост (напр. IP-фильтр на стороне
// PayKeeper) вешает функцию на весь платформенный лимит вместо понятной ошибки.
async function fetchT(url: string | URL | Request, opts: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await checkedFetch(url, { ...opts, signal: ctrl.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`External request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Шим: даём коду обращаться к process.env.* как раньше
const process = {
  env: new Proxy<Record<string, string | undefined>>({}, {
    get: (_target, key: string | symbol) => typeof key === 'string' ? Deno.env.get(key) : undefined
  })
};

async function handler(event: PaymentEvent): Promise<HttpResponse> {
  // --------- базовые штуки
  const method = (
    event.httpMethod || event.requestContext?.http?.method || event.method || 'POST'  // <= дефолт POST
  ).toUpperCase();

  const path = (
    event.path || event.requestContext?.http?.path || event.rawPath || '/'            // <= дефолт "/"
  ).toLowerCase();

  const origin = (event.headers?.origin || event.headers?.Origin || '').trim();
  const isOptions = method === 'OPTIONS';

  const headers = corsHeaders(process.env.CORS_ORIGIN || '*', origin);
  if (isOptions) return resp(204, '', headers);

  // Логируем только ошибки и успешные отправки

  // ---- Роутер
  try {
    const requestedAction = event.queryStringParameters?.action;
    if (method !== 'POST' && (requestedAction === 'create-cod-order' || requestedAction === 'pay'))
      return resp(405, { error: 'Method Not Allowed' }, { ...headers, Allow: 'POST, OPTIONS' });
    if (method === 'POST') {
      const { data, ctype } = await readBodyAny(event);
      if ((data.paymentMethod === 'card' || data.paymentMethod === 'cash_on_delivery' || event.queryStringParameters?.action === 'create-cod-order')
          && ctype.split(';')[0].trim() !== 'application/json')
        return resp(415, { error: 'JSON content type required' }, headers);
      
      // Определяем тип запроса:
      // - Если есть paid: true и нет description - это хук (уведомление о платеже)
      // - Если есть amount и description - это запрос на создание платежа
      const isPayIntent =
        data && typeof data === 'object' &&
        ('amount' in data) && ('description' in data);
      
      // Webhook от PayKeeper: может быть id/invoice_id, sum, status, но НЕТ description
      const isHook = data && typeof data === 'object' && 
                     !isPayIntent && // точно не запрос на создание платежа
                     (('id' in data) || ('invoice_id' in data) || ('sum' in data) || 
                      (data.paid === true || data.status === 'paid' || 
                       String(data.status || '').toLowerCase().includes('paid')));
      
      // Логируем определение типа запроса только для отладки
      // (убрано для уменьшения логов)

      // Определяем тип запроса по query параметрам или body
      const qs = event.queryStringParameters || {};
      const action = stringOf(qs.action || data.action);

      if (action === 'local-integration-network-probe') {
        if (!localIntegrationGuardEnabled()) return resp(404, { error: 'Not Found' }, headers);
        try {
          await fetchT('https://unexpected-egress.invalid/probe', {}, 1000);
          return resp(500, { blockedBeforeNetwork: false }, headers);
        } catch (error) {
          return resp(200, {
            blockedBeforeNetwork: String(error).includes(LOCAL_INTEGRATION_BLOCKED)
          }, headers);
        }
      }

      const client = requestClient(event.headers || {});
      if (action === 'create-cod-order') {
        return await routeCodOrder(data, headers, false, client);
      }
      if (action === 'retry-cod-delivery') {
        return await routeRetryCodDelivery(event, headers);
      }
      
      if (isPayIntent && (path.endsWith('/api/pay') || path.includes('/pay') || action === 'pay')) {
        // Это запрос на создание платежа
        return await routePay(data, headers, client);
      }
      
      // Новый endpoint: проверка статуса платежа через API PayKeeper
      if (action === 'check-payment' || action === 'check') {
        return await routeCheckPayment(data, headers, client);
      }
      
      // Новый endpoint: ручная отправка уведомления в Telegram (для тестирования)
      if (action === 'send-notification' || action === 'send') {
        return await routeSendNotification({ ...event, __data: data }, headers);
      }

      if (action === 'poll-payments') {
        return await routePollPayments(event, headers);
      }
      
      if (isHook || !isPayIntent) {
        // Это хук - уведомление о платеже, отправляем в Telegram
        return await routeHook({ ...event, __data: data }, headers);
      }
      
      // По умолчанию - хук
      return await routeHook({ ...event, __data: data }, headers);
    }

    // сюда попадут GET/HEAD и т.п.
    return resp(404, { error: 'Not Found' }, headers);

  } catch (error) {
    const failure = paymentError(error);
    if (failure.inputStatus) return resp(failure.inputStatus, { error: failure.message }, headers);
    console.error('Unhandled error', failure);
    return resp(500, { error: 'Internal Error', detail: failure.message }, headers);
  }
};

// Кеш для дедупликации уведомлений (в памяти, только для текущего инстанса)
// ======================== /api/hook ========================
async function routeHook(event: PaymentEvent, headers: HeaderValues): Promise<HttpResponse>{
  const qs = event.queryStringParameters || {};
  const H  = event.headers || {};
  const { data = {} } = (event.__data ? { data: event.__data } : await readBodyAny(event));

  // Authenticity first, fail closed: nothing in the payload is used before the shared secret matches.
  const authorization = String(H['authorization'] || H['Authorization'] || '');
  const auth = hookSecretCheck([
    H['x-hook-secret'], H['X-Hook-Secret'],
    qs.secret, // PayKeeper/Alfa callback URLs carry the secret in the query string
    data.secret_word, data.secret, data.key, data.token,
    authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  ]);
  if (auth === 'unconfigured') {
    console.error('Hook rejected: HOOK_SECRET is not configured');
    return resp(503, { ok: false, error: 'Hook is not configured' }, headers);
  }
  if (auth !== 'ok') {
    console.error('Hook rejected: bad or missing secret');
    return resp(401, { ok: false, error: 'Bad hook secret' }, headers);
  }

  const callbackData = { ...qs, ...data };
  const isAlfaCallback = Boolean(
    callbackData.mdOrder || callbackData.orderNumber || callbackData.operation
  );

  if (isAlfaCallback) {
    const operation = stringOf(callbackData.operation).toLowerCase();
    const callbackStatus = stringOf(callbackData.status);
    const mdOrder = stringOf(callbackData.mdOrder).trim();

    const successfulOperation = ['approved', 'deposited'].includes(operation);
    if (!successfulOperation || callbackStatus !== '1' || !mdOrder) {
      return resp(200, {
        ok: true,
        received: true,
        paid: false,
        reason: 'Alfa callback is not a successful deposit'
      }, headers);
    }

    const alfaOrder = await getAlfaOrderStatus(mdOrder);
    const evidence = alfaPaymentEvidence(alfaOrder, mdOrder);
    if (!evidence) return resp(409, { ok: false, paid: false, reason: 'Incomplete or contradictory Alfa payment evidence' }, headers);
    const amountKopecks = evidence.amount;
    const description = firstString(alfaOrder.orderDescription, callbackData.description);

    const p = normPaymentPayload({
      ...callbackData,
      ...getAlfaCustomerDetails(alfaOrder),
      paid: true,
      status: 'paid',
      invoice_id: mdOrder,
      orderId: evidence.orderNumber,
      amount: amountKopecks / 100,
      description,
      service_name: description
    });
    return await notifyAlfaPayment(p, headers);
  }

  // Legacy PayKeeper webhook. Its body (status, sum, paid, cart, description) is never evidence:
  // the invoice is confirmed through the PayKeeper API and matched against the stored order.
  // Deduplication is by the stored payment and per-recipient effects, never by order age.
  const invoiceId = firstString(data.invoice_id, data.id, data.bill_id).trim();
  if (!invoiceId) return resp(200, { ok: true, received: true, paid: false, reason: 'No invoice id' }, headers);
  try {
    return await notifyPayKeeperInvoice(await payKeeperInvoice({ invoiceId }), { invoiceId }, headers);
  } catch (error) {
    return payKeeperFailure(error, headers);
  }
}

// Constant-time comparison of every supplied candidate against HOOK_SECRET.
function hookSecretCheck(candidates: unknown[]): 'ok' | 'bad' | 'unconfigured' {
  const norm = (s: unknown) => String(s || '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\r|\n/g, '')
    .trim();
  const expected = new TextEncoder().encode(norm(process.env.HOOK_SECRET));
  if (!expected.length) return 'unconfigured';
  let matched = false;
  for (const candidate of candidates.map(norm).filter(Boolean)) {
    const supplied = new TextEncoder().encode(candidate);
    let diff = supplied.length ^ expected.length;
    for (let index = 0; index < expected.length; index++) diff |= expected[index] ^ (supplied[index] ?? 0);
    matched = matched || diff === 0;
  }
  return matched ? 'ok' : 'bad';
}

interface PayKeeperFailure extends Error { httpStatus?: number }

function payKeeperFailure(error: unknown, headers: HeaderValues): HttpResponse {
  const failure = paymentError(error) as PayKeeperFailure;
  console.error('PayKeeper confirmation failed', { status: failure.httpStatus || 502, error: failure.message });
  return resp(failure.httpStatus || 502, { ok: false, notified: false, error: 'PayKeeper confirmation failed' }, headers);
}

// One invoice from the PayKeeper API (exactly one record, otherwise an error).
async function payKeeperInvoice(query: { invoiceId?: string; orderId?: string }): Promise<JsonRecord> {
  const pkHost = process.env.PK_HOST || '';
  const pkUser = process.env.PK_USER || '';
  const pkPass = process.env.PK_PASS || '';
  if (!pkHost || !pkUser || !pkPass)
    throw Object.assign(new Error('PayKeeper not configured'), { httpStatus: 503 });
  const auth = 'Basic ' + Buffer.from(`${pkUser}:${pkPass}`).toString('base64');
  const apiUrl = query.invoiceId
    ? `https://${pkHost}/info/invoice/byid/?id=${encodeURIComponent(query.invoiceId)}`
    : `https://${pkHost}/info/invoice/byorder/?orderid=${encodeURIComponent(stringOf(query.orderId))}`;
  const res = await fetchT(apiUrl, { headers: { 'Authorization': auth, 'Content-Type': 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`PayKeeper API returned HTTP ${res.status}`), { httpStatus: 502 });
  const body = await res.json().catch(() => null);
  const record = Array.isArray(body) ? (body.length === 1 ? recordOf(body[0]) : {}) : recordOf(body);
  if (!Object.keys(record).length) throw Object.assign(new Error('Invalid PayKeeper invoice response'), { httpStatus: 502 });
  return record;
}

// Exact PayKeeper invoice status; anything else (created, sent, expired, "unpaid", ...) is not a payment.
const PAYKEEPER_PAID_STATUS = 'paid';

async function notifyPayKeeperInvoice(invoice: JsonRecord, expected: { invoiceId?: string; orderId?: string },
  headers: HeaderValues): Promise<HttpResponse> {
  const invoiceId = stringOf(invoice.id).trim();
  const orderNumber = stringOf(invoice.orderid).trim();
  if (!invoiceId || (expected.invoiceId && invoiceId !== expected.invoiceId) || (expected.orderId && orderNumber !== expected.orderId))
    return resp(409, { ok: false, paid: false, notified: false, reason: 'Invoice does not match the request' }, headers);
  if (stringOf(invoice.status).trim().toLowerCase() !== PAYKEEPER_PAID_STATUS)
    return resp(200, { ok: true, received: true, paid: false, notified: false, reason: 'Invoice is not paid (checked via API)' }, headers);
  const amounts = [invoice.pay_amount, invoice.sum]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '').map(Number);
  if (!amounts.length || amounts.some(value => !Number.isFinite(value) || value <= 0 || value !== amounts[0]))
    return resp(409, { ok: false, paid: true, notified: false, reason: 'Invoice amount is missing or contradictory' }, headers);
  const storedRes = await supabaseAdminRequest(`payment_orders?md_order=eq.${encodeURIComponent(invoiceId)}&select=*`);
  if (!storedRes.ok) throw Object.assign(new Error('Payment storage unavailable'), { httpStatus: 503 });
  const stored = jsonRecords(await storedRes.json())[0];
  if (!stored || !orderNumber || stringOf(stored.order_number) !== orderNumber || Number(stored.amount) !== amounts[0])
    return resp(409, { ok: false, paid: true, notified: false, reason: 'Payment does not match stored order' }, headers);
  if (stored.notified_at)
    return resp(200, { ok: true, paid: true, duplicate: true, notified: false }, headers);
  const p = normPaymentPayload({
    paid: true, status: 'paid', invoice_id: invoiceId, orderid: orderNumber, sum: Number(stored.amount),
    clientid: invoice.clientid, client_email: invoice.client_email, client_phone: invoice.client_phone,
    service_name: firstString(invoice.service_name, stored.description)
  });
  try {
    await tgBroadcast(buildMsg(p), invoiceId, 'card', false, undefined, p.phone);
  } catch (tgError) {
    const failure = paymentError(tgError);
    console.error('Telegram notification failed', { invoice_id: invoiceId, error: failure.message });
    // Non-200 lets the provider redeliver; per-recipient effects prevent duplicates.
    return resp(failure.pending ? 409 : 502, { ok: false, paid: true, notified: false, error: 'Telegram notification failed' }, headers);
  }
  await markPaymentNotified(invoiceId);
  console.log('Telegram sent', { invoice_id: invoiceId });
  return resp(200, { ok: true, paid: true, notified: true, orderId: orderNumber, invoice_id: invoiceId }, headers);
}

// ======================== /api/check-payment ========================
// Public status check (legacy PayKeeper). Same evidence and dedup rules as the webhook; rate limited.
async function routeCheckPayment(data: JsonRecord, headers: HeaderValues, client: RequestClient = UNKNOWN_CLIENT): Promise<HttpResponse>{
  const invoiceId = String(data.invoice_id || data.id || '').trim();
  const orderId = String(data.orderId || data.orderid || '').trim();
  if (!invoiceId && !orderId) {
    return resp(400, { error: 'Missing invoice_id or orderId' }, headers);
  }
  if (invoiceId.length > 64 || orderId.length > 64) return resp(400, { error: 'Invalid invoice_id or orderId' }, headers);
  const limited = await admitRequest('check', client, {}, headers);
  if (limited) return limited;
  try {
    const invoice = await payKeeperInvoice(invoiceId ? { invoiceId } : { orderId });
    return await notifyPayKeeperInvoice(invoice, invoiceId ? { invoiceId, orderId: orderId || undefined } : { orderId }, headers);
  } catch (error) {
    return payKeeperFailure(error, headers);
  }
}

// ======================== /api/send-notification ========================
// Ручная отправка уведомления в Telegram (для тестирования)
async function routeSendNotification(event: PaymentEvent, headers: HeaderValues): Promise<HttpResponse>{
  const data = event.__data || (await readBodyAny(event)).data;
  
  // Проверяем секрет для безопасности
  const qs = event.queryStringParameters || {};
  // Fail closed: an unset HOOK_SECRET must not turn this into a public Telegram relay.
  if (hookSecretCheck([qs.secret, data.secret]) !== 'ok') {
    return resp(401, { error: 'Unauthorized' }, headers);
  }
  
  try {
    const p = normPaymentPayload(data);
    
    if (!p.paid) {
      return resp(400, { error: 'Payment not paid', paid: p.paid, status: p.status }, headers);
    }
    
    const msg = buildMsg(p);
      await tgBroadcast(msg, p.invoice_id, 'card', false, undefined, p.phone);
    
    // Уведомление отправлено вручную
    
    return resp(200, { 
      ok: true, 
      notified: true,
      invoice_id: p.invoice_id,
      orderId: p.orderId
    }, headers);
    
  } catch (error) {
    console.error('Send notification error', error);
    return resp(500, { error: 'Internal error', detail: String(error) }, headers);
  }
}

async function getAlfaOrderStatus(mdOrder: string): Promise<JsonRecord>{
  const alfaBase = String(process.env.ALFA_API_BASE || 'https://payment.alfabank.ru/payment/rest').replace(/\/$/, '');
  const alfaUser = process.env.ALFA_API_USER || '';
  const alfaPass = process.env.ALFA_API_PASS || '';

  if (!alfaUser || !alfaPass) {
    throw new Error('Alfa-Bank credentials not configured');
  }

  const form = new URLSearchParams({
    userName: alfaUser,
    password: alfaPass,
    orderId: mdOrder
  });
  const res = await fetchAlfa(`${alfaBase}/getOrderStatusExtended.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const body = recordOf(await res.json().catch(() => null));

  const errorCode = String(body.errorCode ?? '0');
  if (!res.ok || !Object.keys(body).length || (errorCode !== '0' && errorCode !== '')) {
    throw new Error(stringOf(body.errorMessage) || `Alfa status API returned HTTP ${res.status}`);
  }
  return body;
}

function getAlfaCustomerDetails(order: JsonRecord): { clientid: string; client_email: string; client_phone: string } {
  const arrays: unknown[][] = [order.merchantOrderParams, order.attributes, order.transactionAttributes]
    .filter((value): value is unknown[] => Array.isArray(value));
  const clientInfo = recordOf(order.clientInfo);
  const orderBundle = recordOf(order.orderBundle);
  const customerDetails = recordOf(orderBundle.customerDetails);
  const param = (...names: string[]) => {
    const wanted = names.map(name => String(name).toLowerCase());
    for (const list of arrays) {
      const found = list.map(recordOf).find(item => wanted.includes(String(item.name || item.key || '').toLowerCase()));
      const value = found?.value ?? found?.val;
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
  };
  const first = (...values: unknown[]) => firstString(...values).trim();
  return {
    clientid: first(order.clientId, clientInfo.clientId, param('clientId', 'client_id', 'fio', 'name')),
    client_email: first(order.email, order.clientEmail, clientInfo.email, customerDetails.email, param('email', 'client_email')),
    client_phone: first(order.phone, order.clientPhone, clientInfo.phone, customerDetails.phone, param('phone', 'client_phone'))
  };
}

async function supabaseAdminRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !serviceKey) throw new Error('Supabase service role is not configured');

  const requestHeaders = new Headers(options.headers);
  requestHeaders.set('apikey', serviceKey);
  requestHeaders.set('Authorization', `Bearer ${serviceKey}`);
  requestHeaders.set('Content-Type', requestHeaders.get('Content-Type') || 'application/json');
  return await fetchT(`${base}/rest/v1/${path}`, {
    ...options,
    headers: requestHeaders
  });
}

async function savePaymentOrder(order: JsonRecord): Promise<void> {
  const res = await supabaseAdminRequest('payment_orders?on_conflict=md_order', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(order)
  });
  if (!res.ok) throw new Error(`Cannot save payment order: ${await res.text()}`);
}

async function notifyAlfaPayment(p: NormalizedPayment, headers: HeaderValues): Promise<HttpResponse> {
  const stored = await orderStore.payment(p.invoice_id);
  const legacyRes = await supabaseAdminRequest(`payment_orders?md_order=eq.${encodeURIComponent(p.invoice_id)}&select=*`);
  if (!legacyRes.ok) throw new Error('Payment storage unavailable');
  const legacy = jsonRecords(await legacyRes.json())[0] || null;
  const expectedAmount = stored ? stored.total : legacy?.amount;
  const expectedOrderNumber = stored ? stored.order_id : legacy?.order_number;
  if ((stored && legacy && (Number(stored.total) !== Number(legacy.amount) || stored.order_id !== legacy.order_number))
      || (!stored && !legacy) || Number(expectedAmount) !== Number(p.amount)
      || String(expectedOrderNumber) !== String(p.orderId))
    return resp(409, { message: 'Payment does not match stored order' }, headers);
  if (legacy?.notified_at) {
    if (stored) await orderStore.update(stored.order_id, { status: 'paid', telegram_sent: true, last_checked_at: new Date().toISOString() });
    return resp(200, { ok: true, paid: true, duplicate: true, notified: false }, headers);
  }
  if (stored?.telegram_sent)
    return resp(200, { ok: true, paid: true, duplicate: true, notified: false }, headers);
  if (!stored?.notification_chat_ids?.length) throw new Error('Card recipient snapshot requires review');
  if (stored) await orderStore.update(stored.order_id, { status: 'paid', last_checked_at: new Date().toISOString() });
  await tgBroadcast(stored.notification || buildMsg(p), p.invoice_id, 'card', false, stored.notification_chat_ids, p.phone || orderPhone(stored?.payload));
  if (stored) await orderStore.update(stored.order_id, { telegram_sent: true, last_checked_at: new Date().toISOString(), last_error: null });
  await markPaymentNotified(p.invoice_id);
  return resp(200, { ok: true, paid: true, notified: true, orderId: p.orderId }, headers);
}

async function markPaymentNotified(mdOrder: string): Promise<void> {
  if (!mdOrder) return;
  const res = await supabaseAdminRequest(`payment_orders?md_order=eq.${encodeURIComponent(mdOrder)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'paid', notified_at: new Date().toISOString(), last_error: null })
  });
  if (!res.ok) console.error('Cannot mark payment notified', await res.text());
}

async function markPaymentChecked(mdOrder: string, error: unknown = null): Promise<void> {
  const res = await supabaseAdminRequest(`payment_orders?md_order=eq.${encodeURIComponent(mdOrder)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_checked_at: new Date().toISOString(), last_error: error == null ? null : String(error).slice(0, 500) })
  });
  if (!res.ok) throw new Error('Cannot update payment polling state');
}

// Both notification entry points require independent, consistent bank evidence.
function alfaPaymentEvidence(order: JsonRecord, expectedPaymentId?: string): { amount: number; orderNumber: string } | null {
  if (expectedPaymentId && [order.orderId, order.mdOrder].some(value => value !== undefined && stringOf(value) !== expectedPaymentId)) return null;
  const info = recordOf(order.paymentAmountInfo);
  const states = [info.paymentState, order.paymentState].filter(value => value !== undefined && value !== null);
  if (states.some(value => stringOf(value).toUpperCase() !== 'DEPOSITED')) return null;
  if (order.orderStatus !== undefined && Number(order.orderStatus) !== 2) return null;
  if (order.orderStatus === undefined && !states.length) return null;
  const values = [info.depositedAmount, info.paymentAmount, order.amount].filter(value => value !== undefined && value !== null);
  if (!values.length || values.some(value => !/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) return null;
  const amount = Number(values[0]);
  if (values.some(value => Number(value) !== amount)) return null;
  const orderNumber = stringOf(order.orderNumber).trim();
  if (!orderNumber) return null;
  return { amount, orderNumber };
}

function paymentReturnUrl(value: unknown, failure: boolean, orderId: string): string {
  const url = new URL(stringOf(value) || (failure ? 'https://lady-elka.ru/pay-return/?fail=1' : 'https://lady-elka.ru/spasibo/'));
  // Accept old production return URLs and the new direct-200 directory form.
  // Explicit fixture origins; no wildcard loopback ports or request-derived origins.
  const origins = ['https://lady-elka.ru', 'https://www.lady-elka.ru', 'http://localhost:4176', 'http://127.0.0.1:4176'];
  if (!origins.includes(url.origin) || url.username || url.password || url.hash
      || ![failure ? '/pay-return' : '/spasibo', failure ? '/pay-return/' : '/spasibo/'].includes(url.pathname)) throw new Error('Invalid payment return URL');
  for (const [key, val] of url.searchParams) {
    if ((key !== 'oid' && key !== 'fail') || (key === 'oid' && val !== orderId)
        || (key === 'fail' && (!failure || val !== '1')) || url.searchParams.getAll(key).length !== 1)
      throw new Error('Invalid payment return URL');
  }
  return url.href;
}

function configuredRecipients(): string[] {
  const ids = codRecipients();
  if (!String(process.env.TG_BOT_TOKEN || '').trim() || !ids.length) throw new Error('Telegram is not configured');
  return ids;
}

async function pollAlfaOrder(input: { md_order: string; order_number: string; amount: number; description: string }, headers: HeaderValues): Promise<boolean> {
  const alfaOrder = await getAlfaOrderStatus(input.md_order);
  const evidence = alfaPaymentEvidence(alfaOrder, input.md_order);
  if (!evidence) throw new Error('Incomplete or contradictory Alfa payment evidence');
  const amountKopecks = evidence.amount;
  const description = firstString(alfaOrder.orderDescription, input.description, 'Оплата заказа');
  const p = normPaymentPayload({
    ...getAlfaCustomerDetails(alfaOrder),
    paid: true,
    status: 'paid',
    invoice_id: input.md_order,
    orderId: evidence.orderNumber,
    amount: amountKopecks / 100,
    description,
    service_name: description
  });
  const result = await notifyAlfaPayment(p, headers);
  return recordOf(JSON.parse(result.body)).notified === true;
}

async function routePollPayments(event: PaymentEvent, headers: HeaderValues): Promise<HttpResponse> {
  const pollToken = String(event.headers?.['x-poll-token'] || event.headers?.['X-Poll-Token'] || '');
  const expectedToken = process.env.ALFA_CALLBACK_TOKEN || '';
  if (!expectedToken || pollToken !== expectedToken) {
    return resp(401, { ok: false, error: 'Unauthorized' }, headers);
  }

  const persistentQuery = 'le_orders?select=order_id,payment_id,total,payload&payment_id=not.is.null&status=in.(awaiting_payment,paid)&telegram_sent=eq.false&order=last_checked_at.asc.nullsfirst,created_at.asc&limit=50';
  const persistentRes = await supabaseAdminRequest(persistentQuery);
  if (!persistentRes.ok) throw new Error(`Cannot load persistent pending payments: ${await persistentRes.text()}`);
  const persistent = jsonRecords(await persistentRes.json()).map(order => ({
    order_id: stringOf(order.order_id),
    order_number: stringOf(order.order_id),
    md_order: stringOf(order.payment_id),
    amount: Number(order.total),
    description: stringOf(recordOf(order.payload).description)
  }));

  const select = 'md_order,order_number,amount,description,created_at';
  const query = `payment_orders?select=${select}&notified_at=is.null&created_at=gte.${encodeURIComponent(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())}&order=last_checked_at.asc.nullsfirst,created_at.asc&limit=50`;
  const pendingRes = await supabaseAdminRequest(query);
  if (!pendingRes.ok) throw new Error(`Cannot load pending payments: ${await pendingRes.text()}`);
  const pending = jsonRecords(await pendingRes.json()).map(order => ({
    md_order: stringOf(order.md_order),
    order_number: stringOf(order.order_number),
    amount: Number(order.amount),
    description: stringOf(order.description)
  }));
  let notified = 0;
  const persistentIds = new Set(persistent.map(order => order.md_order));

  const processOrder = async (order: { order_id?: string; md_order: string; order_number: string; amount: number; description: string }) => {
    try {
      if (await pollAlfaOrder(order, headers)) notified += 1;
      await markPaymentChecked(order.md_order);
      if (order.order_id) await orderStore.update(order.order_id, { last_checked_at: new Date().toISOString(), last_error: null });
    } catch (error) {
      console.error('Payment polling failed', { mdOrder: order.md_order, error: String(error) });
      await markPaymentChecked(order.md_order, error).catch(() => {});
      if (order.order_id) await orderStore.update(order.order_id, { last_checked_at: new Date().toISOString(), last_error: String(error).slice(0, 500) }).catch(() => {});
    }
  };

  for (const order of persistent) await processOrder(order);
  for (const order of pending) {
    if (!persistentIds.has(order.md_order)) await processOrder(order);
  }

  return resp(200, { ok: true, checked: persistent.length + pending.length, notified,
    persistentChecked: persistent.length, legacyChecked: pending.length }, headers);
}

const orderStore = createOrderStore(supabaseAdminRequest) as OrderStore;

interface CatalogVariant {
  id: string;
  price: number;
  category: string;
  height?: number;
  size?: string;
}

interface CatalogProduct {
  id: string;
  title: string;
  variants: CatalogVariant[];
}

interface PromoBenefits {
  rub: number;
  pct: number;
  gift: boolean;
  giftText: string;
}

async function currentCodItems(items: CheckoutItem[]): Promise<ActualCatalogItem[]> {
  const base = `${String(process.env.LE_CATALOG_FEEDS_BASE || 'https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-feeds').replace(/\/$/, '')}/`;
  const kinds = [...new Set(items.map(item => item.kind))];
  const feeds = new Map(await Promise.all(kinds.map(async kind => {
    const response = await fetchT(base + (kind === 'decor' ? 'decor.csv' : 'trees.csv'), {}, 10000);
    if (!response.ok) throw new Error('Catalog unavailable');
    const rows = csvRecords(await response.text());
    const products = kind === 'decor' ? decorProducts(rows) : treeProducts(rows);
    return [kind, products as Map<string, CatalogProduct>] as const;
  })));
  return items.map(item => {
    const product = feeds.get(item.kind)?.get(item.productId);
    const variant = product?.variants.find(candidate => candidate.id === item.variantId);
    if (!product || !variant) throw new Error('Product unavailable');
    const price = variant.price;
    if (price <= 0 || price !== item.price) throw new Error('Price changed');
    return { name: String(product.title || '').trim(), variantId: item.variantId,
      options: item.kind === 'decor' ? [variant.category, variant.size].filter(Boolean).join(' · ')
        : [variant.category, `${variant.height} см`].filter(Boolean).join(' · '),
      price, quantity: item.quantity };
  });
}
function routeCodOrder(data: JsonRecord, headers: HeaderValues, validateOnly: true): Promise<CodValidation>;
function routeCodOrder(data: JsonRecord, headers: HeaderValues, validateOnly?: false, client?: RequestClient): Promise<HttpResponse>;
async function routeCodOrder(data: JsonRecord, headers: HeaderValues, validateOnly = false, client: RequestClient = UNKNOWN_CLIENT): Promise<CodValidation> {
  const bad = (message: string) => resp(400, { error: 'Invalid order', message }, headers);
  if (!validateOnly && data.paymentMethod !== 'cash_on_delivery') return bad('Выберите оплату при получении');
  const submittedOrderId = stringOf(data.orderId).trim();
  let replay = false;
  if (!validateOnly && /^LE-\d{10,}-[\w-]{0,32}$/.test(submittedOrderId)) {
    try {
      const stored = await orderStore.existing(submittedOrderId, data);
      if (stored) {
        // Replays of an admitted order have their own budget; they create no new order.
        replay = true;
        const limited = await admitRequest('replay', client, {}, headers);
        if (limited) return limited;
      }
      if (stored?.result) return resp(200, { ...stored.result, duplicate: true }, headers);
      if (stored?.notification) return await finishCodOrder(stored.order_id, Number(stored.total), stored.notification, headers, false, stored.notification_chat_ids || undefined, orderPhone(stored.payload));
      if (!stored && newOrderAdmissionClosed()) return admissionClosed(headers);
    } catch (error) {
      const failure = paymentError(error);
      return resp(failure.conflict ? 409 : 503, { message: failure.message }, headers);
    }
  }
  if (!validateOnly && newOrderAdmissionClosed() && !/^LE-\d{10,}-[\w-]{0,32}$/.test(submittedOrderId)) return bad('Некорректный номер заказа');
  const customer = recordOf(data.customer);
  const delivery = recordOf(data.delivery);
  const name = stringOf(customer.name).trim().slice(0, 120);
  const email = stringOf(customer.email).trim().slice(0, 200);
  const phone = normalizeOrderPhone(customer.phone);
  const address = stringOf(delivery.address).trim().slice(0, 500);
  const contactPref = stringOf(customer.contactPref).trim().slice(0, 80);
  const comment = stringOf(customer.comment).trim().slice(0, 1000);
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email) || !phone || !address || !contactPref)
    return bad('Заполните имя, почту, телефон, адрес и способ связи');
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 50) return bad('Корзина пуста или слишком велика');
  const parsedItems = data.items.map(catalogItem);
  if (parsedItems.some(item => item === null)) return bad('Проверьте товары в корзине');
  const items = parsedItems.filter((item): item is CheckoutItem => item !== null);
  if (items.some(item => !item.productId || !item.variantId
    || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 || !Number.isFinite(item.price) || item.price <= 0))
    return bad('Проверьте товары в корзине');
  let orderId = submittedOrderId;
  if (!/^LE-\d{10,}-[\w-]{0,32}$/.test(orderId)) return bad('Некорректный номер заказа');
  if (!validateOnly && !replay) {
    // Before any catalog fetch, reservation or Telegram effect.
    const limited = await admitRequest('order', client, { email, phone }, headers);
    if (limited) return limited;
  }
  let actual: ActualCatalogItem[];
  try { actual = await currentCodItems(items); }
  catch (error) {
    console.error('COD catalog validation failed', String(error));
    return resp(409, { error: 'Catalog changed', message: 'Товар или цена изменились. Обновите страницу и проверьте корзину.' }, headers);
  }
  const base = cartSubtotal(actual);
  let promo: PromoBenefits | null = null;
  let gift = '';
  const promoData = recordOf(data.promo);
  const promoCode = stringOf(promoData.code).trim();
  if (promoCode && items.some(item => item.kind !== 'decor')) {
    try {
      const promoBase = String(process.env.LE_CATALOG_FEEDS_BASE || 'https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-feeds').replace(/\/$/, '');
      const response = await fetchT(`${promoBase}/promos.csv`, { cache: 'no-store' }, 10000);
      if (!response.ok) throw new Error('Promos unavailable');
      const row = findPromo(csvRecords(await response.text()), promoCode);
      if (!row) return resp(409, { error: 'Promo changed', message: 'Промокод больше не действует. Проверьте корзину.' }, headers);
      promo = promoDetails(row);
      if (!hasPromoBenefit(promo)) return resp(409, { error: 'Promo changed', message: 'Промокод больше не действует. Проверьте корзину.' }, headers);
      gift = promo.giftText;
    } catch (error) {
      console.error('COD promo validation failed', String(error));
      return resp(503, { error: 'Promo unavailable', message: 'Не удалось проверить промокод. Повторите попытку.' }, headers);
    }
  }
  const trustedItems = items.map((item, index) => ({ ...item, price: actual[index].price }));
  const total = checkoutTotal(trustedItems, promo);
  const discount = base - total;
  if (total <= 0 || Number(data.amount) !== total)
    return resp(409, { error: 'Total changed', message: 'Сумма заказа изменилась. Проверьте корзину.' }, headers);
  const text = checkoutNotification({ items: actual, total, discount, promoCode, gift,
    name, phone, email, address, contactPref, comment, payment: 'Оплата при получении' });
  if (validateOnly) return { notification: text.replace('Способ оплаты: Оплата при получении', 'Оплачено картой') };
  let stored: StoredOrder;
  let recipients: string[];
  try {
    recipients = configuredRecipients();
    stored = await orderStore.reserve(orderId, data);
    orderId = stored.order_id;
    if (stored.result) return resp(200, { ...stored.result, duplicate: true }, headers);
    if (stored.notification) return await finishCodOrder(orderId, Number(stored.total), stored.notification, headers, false, stored.notification_chat_ids || undefined, orderPhone(stored.payload));
  } catch (error) {
    const failure = paymentError(error);
    return resp(failure.conflict ? 409 : 503, { message: failure.message }, headers);
  }
  recipients = await orderStore.effect<string[]>(`recipients:cash_on_delivery:${orderId}`, async () => recipients);
  await orderStore.update(orderId, { status: 'accepted', notification: text, notification_chat_ids: recipients }, 'received');
  const accepted = await orderStore.existing(orderId, stored.payload);
  if (!accepted?.notification || !accepted.notification_chat_ids?.length) throw new Error('Accepted COD snapshot is missing');
  return await finishCodOrder(orderId, Number(accepted.total), accepted.notification, headers, false, accepted.notification_chat_ids || undefined, phone);
}

function codRecipients(): string[] {
  return [...new Set(String(process.env.TG_CHAT_IDS || '').split(',').map(id => id.trim()).filter(Boolean))];
}

// Server-only cron route. Per-recipient effects are the claims; queue reads need no global lock.
async function routeRetryCodDelivery(event: PaymentEvent, headers: HeaderValues): Promise<HttpResponse> {
  const supplied = String(event.headers?.['x-cod-retry-token'] || '');
  const expected = process.env.COD_DELIVERY_RETRY_TOKEN || '';
  if (expected.length < 32 || supplied !== expected) return resp(401, { ok: false, error: 'Unauthorized' }, headers);
  const response = await supabaseAdminRequest('le_orders?select=order_id,total,notification,notification_chat_ids,payload&payment_method=eq.cash_on_delivery&status=eq.accepted&telegram_sent=eq.false&order=notification_checked_at.asc.nullsfirst,created_at.asc&limit=20');
  if (!response.ok) throw new Error('Cannot load COD delivery queue');
  const orders = jsonRecords(await response.json());
  const deadline = Date.now() + 45000;
  let checked = 0, delivered = 0;
  for (const order of orders) {
    if (Date.now() >= deadline) break;
    const orderId = stringOf(order.order_id);
    // Rotate even manually blocked orders, so they cannot starve newer accepted orders.
    await orderStore.update(orderId, { notification_checked_at: new Date().toISOString() }, 'accepted');
    checked += 1;
    if (!order.notification || !Array.isArray(order.notification_chat_ids) || !order.notification_chat_ids.length
        || order.notification_chat_ids.some(id => typeof id !== 'string' || !id.trim())) continue;
    const result = await finishCodOrder(orderId, Number(order.total), stringOf(order.notification), headers, true, order.notification_chat_ids as string[], orderPhone(order.payload));
    if (result.statusCode === 200) delivered += 1;
  }
  return resp(200, { ok: true, checked, delivered, incomplete: checked - delivered }, headers);
}

async function finishCodOrder(orderId: string, total: number, text: string, headers: HeaderValues, automatic = false, recipients?: string[], phone = ''): Promise<HttpResponse> {
  try {
    if (!recipients?.length) throw new Error('COD recipient snapshot requires review');
    await tgBroadcast(text, orderId, 'cash_on_delivery', automatic, recipients, phone);
    await orderStore.update(orderId, { telegram_sent: true, result: { ok: true, orderId, amount: total } });
    console.log('COD Telegram sent', { orderId, amount: total });
    return resp(200, { ok: true, orderId, amount: total }, headers);
  } catch (error) {
    const failure = paymentError(error);
    console.error('COD Telegram failed', { orderId, error: String(failure) });
    return resp(failure.pending ? 409 : 502, { error: 'Telegram failed', orderId, accepted: true,
      status: failure.pending || failure.uncertain ? 'pending_review' : 'notification_failed',
      message: failure.pending || failure.uncertain ? 'Результат отправки уведомления уточняется. Повторная отправка заблокирована.' : 'Уведомление менеджеру пока не доставлено.' }, headers);
  }
}

async function routePay(data: JsonRecord, headers: HeaderValues, client: RequestClient = UNKNOWN_CLIENT): Promise<HttpResponse>{
  if (data.paymentMethod !== 'card') return resp(400, { message: 'Выберите оплату картой' }, headers);
  // ВАЖНО: функция должна возвращать JSON с URL на оплату, а не редирект!
  
  const amount = Number(data.amount || 0);
  const description = String(data.description || 'Оплата заказа');
  const email = String(data.email || '').trim();
  const phone = String(data.phone || '').trim();
  const orderId = String(data.orderId || `order-${Date.now()}`).trim();
  const clientId = String(data.clientId || '').trim();
  let successUrl: string, failUrl: string;
  try {
    successUrl = paymentReturnUrl(data.successUrl, false, orderId);
    failUrl = paymentReturnUrl(data.failUrl, true, orderId);
  } catch { return resp(400, { message: 'Некорректный адрес возврата оплаты' }, headers); }
  const promoCode = String(data.promoCode || '').trim();

  // Проверяем обязательные поля
  if (!Number.isFinite(amount) || amount <= 0) {
    return resp(400, { error: 'Invalid amount', message: 'Сумма должна быть больше нуля' }, headers);
  }

  const alfaBase = String(process.env.ALFA_API_BASE || 'https://payment.alfabank.ru/payment/rest').replace(/\/$/, '');
  const alfaUser = process.env.ALFA_API_USER || '';
  const alfaPass = process.env.ALFA_API_PASS || '';

  if (!alfaUser || !alfaPass) {
    console.error('Alfa-Bank credentials not configured');
    return resp(500, { 
      error: 'Payment gateway not configured', 
      message: 'Платежный шлюз не настроен' 
    }, headers);
  }

  if (!orderId || orderId.length > 32) return resp(400, { message: 'Некорректный номер заказа' }, headers);
  try {
    const previous = await orderStore.existing(orderId, data);
    const limited = previous
      ? await admitRequest('replay', client, {}, headers)
      : newOrderAdmissionClosed() ? null
        // Before catalog validation, reservation and bank registration.
        : await admitRequest('order', client, { email: recordOf(data.customer).email ?? data.email, phone: recordOf(data.customer).phone ?? data.phone }, headers);
    if (limited) return limited;
    if (previous?.status === 'paid') return resp(200, { ok: true, paid: true, orderId, amount: Number(previous.total), duplicate: true }, headers);
    if (previous?.result) {
      const previousResult = recordOf(previous.result);
      if (previousResult.paid !== true && !stringOf(previousResult.url)) {
        return resp(409, { status: 'pending_review', orderId,
          message: 'Существующая регистрация найдена; ссылку оплаты нужно сверить вручную. Новый платёж не создавался.' }, headers);
      }
      if (previousResult.paid !== true) {
        await savePaymentOrder({ md_order: stringOf(previousResult.paymentId), order_number: orderId, amount,
          description: description.slice(0, 512), status: 'pending' });
      }
      return resp(200, { ...previousResult, duplicate: true }, headers);
    }
    if (!previous && newOrderAdmissionClosed()) return admissionClosed(headers);
    if (!Array.isArray(data.items)) return resp(400, { message: 'Корзина пуста' }, headers);
    let validated;
    if (!previous?.notification) {
      validated = await routeCodOrder({ ...data, paymentMethod: 'card' }, headers, true);
      if (isHttpResponse(validated)) return validated;
    }
    if (previous && !previous.notification_chat_ids?.length) throw new Error('Existing card order requires recipient snapshot review');
    let recipients = previous?.notification_chat_ids || configuredRecipients();
    await orderStore.reserve(orderId, data);
    recipients = await orderStore.effect<string[]>(`recipients:card:${orderId}`, async () => recipients);
    if (validated) await orderStore.update(orderId, { notification: validated.notification, notification_chat_ids: recipients }, 'received');
    const snapshot = await orderStore.existing(orderId, data);
    if (!snapshot?.notification_chat_ids?.length) throw new Error('Card recipient snapshot is missing');
    const result = await orderStore.effect<PaymentCreationResult>(`bank:${orderId}`, async () => {
      const amountKopecks = Math.round(amount * 100);
      const form = new URLSearchParams({
        userName: alfaUser,
        password: alfaPass,
        orderNumber: orderId.slice(0, 32),
        amount: String(amountKopecks),
        returnUrl: successUrl,
        failUrl: failUrl,
        description: description.slice(0, 512),
        language: 'ru',
        clientId: clientId || email || phone || 'lady-elka'
      });

      const alfaRes = await fetchAlfa(`${alfaBase}/register.do`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });
      const alfaText = await alfaRes.text();
      let alfaJson: JsonRecord;
      try { alfaJson = recordOf(JSON.parse(alfaText)); }
      catch { alfaJson = {}; }

      const formUrl = stringOf(alfaJson.formUrl);
      const paymentId = stringOf(alfaJson.orderId);
      if (!alfaRes.ok || !formUrl || !paymentId) {
        console.error('Alfa-Bank order registration failed', {
          status: alfaRes.status,
          errorCode: alfaJson.errorCode,
          errorMessage: alfaJson.errorMessage
        });
        const error = Object.assign(new Error(stringOf(alfaJson.errorMessage) || 'Альфа-Банк не создал платёж'), {
          definite: alfaRes.ok && /^\d+$/.test(String(alfaJson.errorCode ?? '')) && Number(alfaJson.errorCode) !== 0
        });
        // 5xx/invalid response may hide an accepted registration.
        throw error;
      }

      return { url: formUrl, paymentId, orderId, amount, description };
    });
    await orderStore.update(orderId, { payment_id: result.paymentId, result });
    await orderStore.update(orderId, { status: 'awaiting_payment' }, 'received');
    await savePaymentOrder({ md_order: result.paymentId, order_number: orderId, amount,
      description: description.slice(0, 512), status: 'pending' });
    const latest = await orderStore.payment(result.paymentId);
    if (latest?.status === 'paid') return resp(200, { ok: true, paid: true, orderId, amount }, headers);
    return resp(200, result, headers);

  } catch (error) {
    const failure = paymentError(error);
    console.error('Alfa-Bank integration error', failure);
    const errorMessage = failure.message;
    return resp(failure.conflict || failure.pending ? 409 : 503, {
      error: 'Payment creation failed', 
      orderId, status: failure.pending || failure.uncertain ? 'pending_review' : 'payment_failed',
      message: failure.pending || failure.uncertain ? 'Заказ сохранён; результат регистрации платежа уточняется. Повторная регистрация заблокирована.' : 'Не удалось создать платеж: ' + errorMessage,
      detail: String(failure)
    }, headers);
  }
}

function corsHeaders(allowed: string, origin: string): HeaderValues {
  const list = String(allowed).split(',').map(s=>s.trim()).filter(Boolean);
  let allow = '*';
  if (!list.includes('*') && origin) allow = list.includes(origin) ? origin : list[0] || origin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-hook-secret,authorization',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

// ======================== Helpers =========================
function resp(code: number, data: unknown, headers: HeaderValues = {}): HttpResponse {
  return { statusCode: code, headers, body: typeof data==='string' ? data : JSON.stringify(data) ?? '' };
}

async function readBody(event: PaymentEvent): Promise<JsonRecord> {
  try { return recordOf(JSON.parse(event.body || '{}')); } catch { return {}; }
}
// читает JSON или form-urlencoded
// Resource ceiling, not a rate limit or a production admission budget.
function inputBodyLimit(): number {
  const configured = Number(process.env.ORDER_INPUT_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 1024 * 1024;
}
function inputFailure(status: number, message: string): never {
  const error: PaymentError = new Error(message); error.inputStatus = status; throw error;
}
function newOrderAdmissionClosed(): boolean {
  const setting = process.env.NEW_ORDER_ADMISSION;
  // Unset preserves the existing local contract; any explicit value other than open closes.
  return setting !== undefined && setting !== 'open';
}
// ---- Admission rate limits (atomic, in Postgres: public.le_rate_limit_take) ----
interface RequestClient { address: string }
const UNKNOWN_CLIENT: RequestClient = { address: 'unknown' };

function ipv6Prefix(address: string): string {
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Trusted client address: the edge-set header (CLIENT_IP_HEADER, default cf-connecting-ip), otherwise the
// right-most X-Forwarded-For hop (appended by our proxy). Left-most XFF values are client-controlled.
function requestClient(headers: HeaderMap): RequestClient {
  const valid = (value: string) => /^[0-9a-f:.]{2,45}$/i.test(value) && /[.:]/.test(value);
  const configured = String(headers[String(process.env.CLIENT_IP_HEADER || 'cf-connecting-ip').toLowerCase()] || '').trim();
  const forwarded = String(headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(Boolean);
  const address = valid(configured) ? configured : forwarded.reverse().find(valid) || 'unknown';
  return { address: address.includes(':') ? ipv6Prefix(address) : address };
}

function rateRule(name: string, fallback: [number, number]): [number, number] {
  const match = String(process.env[name] || '').trim().match(/^(\d{1,6})\/(\d{1,5})$/);
  if (!match) return fallback;
  const limit = Number(match[1]), windowSeconds = Number(match[2]);
  return limit >= 1 && windowSeconds >= 1 && windowSeconds <= 86400 ? [limit, windowSeconds] : fallback;
}

async function contactKey(kind: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${value}`));
  return Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function admitRequest(kind: 'order' | 'check' | 'replay', client: RequestClient,
  contacts: { email?: unknown; phone?: unknown }, headers: HeaderValues): Promise<HttpResponse | null> {
  const buckets: [string, [number, number]][] = [];
  if (kind === 'replay') buckets.push([`replay:ip:${client.address}`, rateRule('REPLAY_RATE_LIMIT_IP', [30, 600])]);
  else {
    buckets.push([`${kind}:ip:${client.address}`, rateRule(kind === 'order' ? 'ORDER_RATE_LIMIT_IP' : 'CHECK_RATE_LIMIT_IP', [10, 600])]);
    if (kind === 'order') {
      const email = stringOf(contacts.email).trim().toLowerCase();
      const phone = stringOf(contacts.phone).replace(/\D/g, '').slice(-10);
      const contactRule = rateRule('ORDER_RATE_LIMIT_CONTACT', [5, 600]);
      if (email) buckets.push([`order:email:${await contactKey('email', email)}`, contactRule]);
      if (phone.length === 10) buckets.push([`order:phone:${await contactKey('phone', phone)}`, contactRule]);
    }
    // One budget for every route that triggers bank/PayKeeper/Telegram/catalog calls on behalf of the public.
    buckets.push(['external:global', rateRule('EXTERNAL_RATE_LIMIT_GLOBAL', [200, 3600])]);
  }
  let retryAfter: number;
  try {
    const response = await supabaseAdminRequest('rpc/le_rate_limit_take', { method: 'POST', body: JSON.stringify({
      p_buckets: buckets.map(([bucket]) => bucket), p_limits: buckets.map(([, rule]) => rule[0]), p_windows: buckets.map(([, rule]) => rule[1]) }) });
    if (!response.ok) throw new Error(`Rate limiter returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid rate limiter response');
    retryAfter = value;
  } catch (error) {
    // Fail closed: no limiter, no new external effects.
    console.error('Rate limiter unavailable', { kind, error: paymentError(error).message });
    return resp(503, { error: 'Rate limiter unavailable', message: 'Сервис временно недоступен. Повторите попытку позже.' }, headers);
  }
  if (!retryAfter) return null;
  return resp(429, { error: 'Too Many Requests', retryAfter, message: `Слишком много запросов. Повторите через ${retryAfter} с.` },
    { ...headers, 'Retry-After': String(retryAfter) });
}

function admissionClosed(headers: HeaderValues): HttpResponse {
  return resp(503, { error: 'Order admission closed', message: 'Новые заказы временно недоступны. Сохраните корзину и повторите позже.' }, headers);
}
async function readBodyAny(event: PaymentEvent): Promise<{ data: JsonRecord; raw: string; ctype: string }> {
  const ctype = String(event.headers?.['content-type'] || event.headers?.['Content-Type'] || '').toLowerCase();
  let raw = event.body || '';
  const limit = inputBodyLimit();
  if (event.isBase64Encoded) {
    // Standard padded/unpadded and URL-safe encodings; reject malformed input instead of permissive Buffer decoding.
    if (raw.length > 4 * Math.ceil(limit / 3)) inputFailure(413, 'Payload Too Large');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw) || raw.replace(/=+$/, '').length % 4 === 1
        || (raw.includes('=') && raw.length % 4 !== 0)) inputFailure(400, 'Invalid base64 body');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length > limit) inputFailure(413, 'Payload Too Large');
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { inputFailure(400, 'Invalid UTF-8 body'); }
  } else if (Buffer.byteLength(raw, 'utf8') > limit) inputFailure(413, 'Payload Too Large');
  if (ctype.includes('application/x-www-form-urlencoded'))
    return { data: Object.fromEntries(new URLSearchParams(raw)), raw, ctype };
  try {
    const parsed = JSON.parse(raw || '{}');
    if (ctype.includes('application/json') && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))
      inputFailure(400, 'JSON object required');
    return { data: recordOf(parsed), raw, ctype };
  } catch (error) {
    if (paymentError(error).inputStatus) throw error;
    if (ctype.includes('application/json')) inputFailure(400, 'Invalid JSON body');
    return { data: {}, raw, ctype };
  }
}
async function boundedRequestBody(req: Request): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > inputBodyLimit()) {
        await reader.cancel().catch(() => {});
        inputFailure(413, 'Payload Too Large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (paymentError(error).inputStatus) throw error;
    inputFailure(400, 'Cannot read request body');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { inputFailure(400, 'Invalid UTF-8 body'); }
}

async function safeJson(res: Response): Promise<unknown> { try { return await res.json(); } catch { return null; } }
async function safeText(res: Response): Promise<string | null> { try { return await res.text(); } catch { return null; } }

function fmtRub(n: unknown): string { return (Number(n)||0).toLocaleString('ru-RU')+' ₽'; }

// Телега
function alfaTransactionUrl(transactionId: unknown): string {
  const base = String(Deno.env.get('ALFA_DASHBOARD_URL') || 'https://payment.alfabank.ru/generalmp3/admin/transactions').trim().replace(/\/+$/, '');
  const id = String(transactionId || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? `${base}/${encodeURIComponent(id)}`
    : base;
}

function orderPhone(payload: unknown): string {
  return normalizeOrderPhone(recordOf(recordOf(payload).customer).phone);
}

function orderControls(alfaUrl: string, hasPayment = true, phone = '') {
  return { inline_keyboard: [
    ...(hasPayment ? [[{ text: 'Детали заказа в Alfa', url: alfaUrl }]] : []),
    ...contactButtons(phone)
  ] };
}

async function tgBroadcast(text: string, transactionId = '', paymentMethod: 'card' | 'cash_on_delivery' = 'card', automatic = false, recipients?: string[], phone = ''): Promise<void> {
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const photoUrl = String(process.env.TG_ORDER_PHOTO_URL || '').trim();
  const replyMarkup = paymentMethod === 'cash_on_delivery'
    ? orderControls('', false, phone) : orderControls(alfaTransactionUrl(transactionId), true, phone);
  // ИСПРАВЛЕНО: улучшенный парсинг TG_CHAT_IDS - убираем все пробелы и разбиваем по запятой
  const rawIds = String(process.env.TG_CHAT_IDS||'').trim();
  const ids = [...new Set(recipients || rawIds.split(',').map((s: string)=>s.trim()).filter(s => s && s.length > 0))];
  
  if (!token || !ids.length) { 
    console.warn('TG not configured', { hasToken: !!token, idsCount: ids.length }); 
    throw new Error('Telegram is not configured');
  }

  const sendAsPhoto = Boolean(photoUrl) && String(text).length <= 1024;
  const telegramApiBase = String(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const url = `${telegramApiBase}/bot${token}/${sendAsPhoto ? 'sendPhoto' : 'sendMessage'}`;

  if (!transactionId) throw new Error('Notification requires a persistent order/payment ID');
  const outcomes = await Promise.allSettled(ids.map(async (id) => orderStore.effect(`telegram:${paymentMethod}:${transactionId}:${id}`, async () => {
    try {
      // ИСПРАВЛЕНО: убеждаемся, что chat_id передается как строка (Telegram API принимает и строки, и числа)
      const chatId = String(id).trim();
      
      const res = await fetchT(url, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(sendAsPhoto
          ? {chat_id: chatId, photo: photoUrl, caption: text, parse_mode:'HTML', reply_markup: replyMarkup}
          : {chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true, reply_markup: replyMarkup})
      });
      
      let responseStatus = res.status;
      let j = recordOf(await res.json().catch(()=>null));
      if (j?.ok === false && res.status < 500 && sendAsPhoto) {
        const fallbackRes = await fetchT(`${telegramApiBase}/bot${token}/sendMessage`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true, reply_markup: replyMarkup})
        });
        responseStatus = fallbackRes.status;
        j = recordOf(await fallbackRes.json().catch(()=>null));
      }
      
      // ИСПРАВЛЕНО: проверяем ответ Telegram и логируем ошибки с деталями
      if (!j?.ok) {
        // Status and Telegram error code only: message text contains customer data.
        console.error('TG send error', { chatId, status: responseStatus, errorCode: j?.error_code });
        const error = Object.assign(new Error(stringOf(j.description) || `Telegram API returned HTTP ${res.status}`), {
          definite: j.ok === false && responseStatus < 500
        });
        throw error;
      } else {
        const result = recordOf(j.result);
        return { messageId: result.message_id };
      }
    } catch (e){
      const failure = paymentError(e);
      console.error('TG send exception', { id, error: failure.message });
      throw failure;
    }
  }, paymentMethod === 'cash_on_delivery' ? { automatic, maxAttempts: 5, backoffSeconds: 60 } : {})));
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failures.length) {
    // Wait for all recipient acknowledgements before returning partial delivery.
    const unresolved = failures.find(outcome => !paymentError(outcome.reason).definite);
    throw unresolved?.reason || failures[0].reason;
  }
}

// Строим нормальный объект платежа из разных форматов
function normPaymentPayload(s: JsonRecord): NormalizedPayment {
  // статус
  const status = firstString(s.status, s.payment_status, s.order_status).toLowerCase();
  
  // PayKeeper отправляет статус оплаты:
  // ВАЖНО: отправляем в Telegram ТОЛЬКО когда платеж действительно оплачен!
  // 
  // PayKeeper отправляет webhook в двух случаях:
  // 1. При создании счета (до оплаты) - обычно без статуса или со статусом "new"
  // 2. После оплаты - со статусом "paid" или "1", или без статуса, но с полем paid=true
  //
  // Логика определения оплаты:
  // - Если статус явно "paid" или "1" - оплачено
  // - Если статус явно неоплаченный ("new", "pending" и т.д.) - не оплачено
  // - Если статус пустой, но есть invoice_id и заказ не старый (менее 1 часа) - возможно оплата
  //   (PayKeeper обычно отправляет webhook только при оплате, но может не отправлять статус)
  
  // Exact status values only: substring matching accepted "unpaid" as paid.
  const PAID_STATUSES = new Set(['paid', 'success', 'succeeded', 'successful', 'approved', 'confirmed', 'deposited', '1']);
  const explicitTrue = (value: unknown) => stringOf(value).trim().toLowerCase() === 'true' || value === true;
  const paid = status.trim()
    ? PAID_STATUSES.has(status.trim())
    : explicitTrue(s.paid) || explicitTrue(s.success) || stringOf(s.result).trim().toLowerCase() === 'success';

  // сумма (PayKeeper отправляет sum)
  const amount = Number(s.amount || s.sum || s.total || 0);
  const description = firstString(s.service_name, s.description);
  const cart = s.cartItems || s.cart_items;
  const cartItems: MessageItem[] | null = Array.isArray(cart)
    ? cart.map(item => {
      const row = recordOf(item);
      return { name: firstString(row.name, row.title), height: stringOf(row.height),
        category: stringOf(row.category), price: Number(row.price) || 0 };
    })
    : null;

  // реквизиты
  const p: NormalizedPayment = {
    paid,
    status: status || (paid?'paid':''),
    invoice_id: firstString(s.invoice_id, s.id, s.bill_id),
    orderId: firstString(s.orderid, s.order_id, s.orderId),
    clientId: firstString(s.clientid, s.client_id, s.client),
    email: firstString(s.email, s.client_email),
    phone: firstString(s.phone, s.client_phone),
    title: firstString(s.title, s.product, s.service_name),
    category: stringOf(s.category),
    height_cm: stringOf(s.height_cm),
    amount,

    // наша мета (если фронт пробрасывает)
    address: firstString(s.address, s.addr),
    contact_pref: firstString(s.contact_pref, s.contact),
    promo_code: firstString(s.promo_code, s.promocode, s.promo),
    promo_discount_text: '',
    promo_gift_text: '',
    cartItems,
    service_name: description,
    description: firstString(s.description, s.service_name),
    raw_description: description
  };
  
  // Логируем только при необходимости (убрано для уменьшения логов)

  // Пытаемся выдернуть из service_name то, что добавили в /api/pay
  // Пример: "Елка — Заснеженная, 180 см | Адрес: ... | Связь: ... | Промо: ..."
  const desc = description;
  if (desc) {
    // Извлекаем адрес (до следующего | или до конца строки)
    const mAddr = desc.match(/Адрес:\s*([^|]+?)(?:\s*\||$)/);
    if (mAddr) {
      const addr = mAddr[1].trim();
      if (addr && !p.address) p.address = addr;
    }
    
    // Извлекаем способ связи (до следующего | или до конца строки)
    const mHow = desc.match(/Связь:\s*([^|]+?)(?:\s*\||$)/);
    if (mHow) {
      const how = mHow[1].trim();
      if (how && !p.contact_pref) p.contact_pref = how;
    }
    const mPhone = desc.match(/Телефон:\s*([^|]+?)(?:\s*\||$)/);
    if (mPhone && !p.phone) p.phone = mPhone[1].trim();
    const mCustomer = desc.match(/Покупатель:\s*([^|]+?)(?:\s*\||$)/);
    if (mCustomer && !p.clientId) p.clientId = mCustomer[1].trim();
    const mEmail = desc.match(/(?:Почта|Email):\s*([^|]+?)(?:\s*\||$)/i);
    if (mEmail && !p.email) p.email = mEmail[1].trim();
    
    // Извлекаем промокод (до следующего | или до конца строки, может содержать пробелы)
    const mPromo = desc.match(/Промо:\s*([^|]+?)(?:\s*\||$)/);
    if (mPromo) {
      const promo = mPromo[1].trim();
      if (promo && !p.promo_code) p.promo_code = promo;
    }
    const mDiscount = desc.match(/Скидка по промокоду:\s*([^|]+?)(?:\s*\||$)/);
    if (mDiscount) p.promo_discount_text = mDiscount[1].trim();
    const mGift = desc.match(/Подарок по промокоду:\s*([^|]+?)(?:\s*\||$)/);
    if (mGift) p.promo_gift_text = mGift[1].trim();
    
    // Извлекаем название товара (до первого |)
    if (!p.title || p.title === desc) {
      const titlePart = desc.split('|')[0].trim();
      // Убираем из названия возможные части с адресом/связью/промо, если они попали в начало
      const cleanTitle = titlePart.replace(/\s*\|\s*(Адрес|Связь|Промо):.*$/, '').trim();
      if (cleanTitle) p.title = cleanTitle;
    }
    
    // Извлеченные данные (логируем только при необходимости)
  }

  // Сохраняем оригинал описания, чтобы не терять товары, разделённые |
  p.service_name = firstString(s.service_name, s.description);
  p.description  = firstString(s.description, s.service_name);
  p.raw_description = description;

  return p;
}

function buildMsg(p: NormalizedPayment): string {
  // Пытаемся извлечь товары из cartItems или из description
  let items: MessageItem[] = [];
  if (p.cartItems) {
    // Товары переданы напрямую
    items = p.cartItems;
  } else {
    // Пытаемся извлечь из description или service_name
    // Формат: "Товар1 — цена ₽ | Товар2 — цена ₽ | Адрес: ..."
    // ИСПРАВЛЕНО: используем raw_description, чтобы получить полный текст со всеми товарами
    const desc = p.raw_description || p.service_name || p.description || p.title || '';
    if (desc) {
      // Разбиваем по | и извлекаем товары (до "Адрес:", "Связь:", "Промо:")
      const parts = desc.split('|').map((s: string) => s.trim());
      
      for (const part of parts) {
        // Останавливаемся, если встретили метаданные
        if (part.includes('Покупатель:') || part.includes('Почта:') || part.includes('Email:') || part.includes('Адрес:') || part.includes('Телефон:') || part.includes('Связь:') || part.includes('Промо:') || part.includes('Скидка по промокоду:')) {
          break;
        }
        
        // Пропускаем пустые части
        if (!part.trim()) {
          continue;
        }
        
        // Пытаемся извлечь цену (формат: "— 21950 ₽" или "— 21 950 ₽")
        // Поддерживаем разные тире: — (длинное), - (обычное), – (среднее)
        const priceMatch = part.match(/[—–-]\s*([\d\s]+)\s*₽/);
        const price = priceMatch ? Number(priceMatch[1].replace(/\s/g, '')) : 0;
        
        // Удаляем цену из строки для парсинга названия/размера/категории
        let partWithoutPrice = part;
        if (priceMatch) {
          // Удаляем тире, пробелы, цифры и символ рубля
          partWithoutPrice = part.replace(/[—–-]\s*[\d\s]+\s*₽/, '').trim();
        } else {
          partWithoutPrice = part.trim();
        }
        
        if (!partWithoutPrice) {
          continue;
        }
        
        // Пытаемся распарсить товар
        // ИСПРАВЛЕНО: более надежный парсинг с использованием более простой логики
        // Поддерживаем форматы:
        // 1. "Название высота см (категория)" - полный формат для елок
        // 2. "Название высота см" - без категории
        // 3. "Название (категория)" - без высоты (для декора)
        // 4. "Название" - просто название
        
        let itemName = '';
        let itemHeight = '';
        let itemCategory = '';
        
        // Формат 1: "Название высота см (категория)" - полный формат для елок
        // Ищем "число см (категория)" в строке и извлекаем название до этого
        const fullPattern = /(\d+)\s*см\s*\(([^)]+)\)/;
        const fullMatch = partWithoutPrice.match(fullPattern);
        if (fullMatch && fullMatch.index !== undefined) {
          itemName = partWithoutPrice.substring(0, fullMatch.index).trim();
          itemHeight = fullMatch[1] || '';
          itemCategory = fullMatch[2] || '';
          // Если название пустое, значит размер в начале - используем весь текст как название
          if (!itemName && itemHeight) {
            itemName = partWithoutPrice.trim();
          }
        } else {
          // Формат 2: "Название высота см" (без категории)
          // Ищем "число см" в строке и извлекаем название до этого
          const sizePattern = /(\d+)\s*см(?!\s*\()/;
          const sizeMatch = partWithoutPrice.match(sizePattern);
          if (sizeMatch && sizeMatch.index !== undefined) {
            itemName = partWithoutPrice.substring(0, sizeMatch.index).trim();
            itemHeight = sizeMatch[1] || '';
            itemCategory = '';
            // Если название пустое, значит размер в начале - используем весь текст как название
            if (!itemName && itemHeight) {
              itemName = partWithoutPrice.trim();
            }
          } else {
            // Формат 3: "Название (категория)" - без высоты (для декора)
            // Ищем категорию в скобках в конце строки
            const categoryPattern = /\(([^)]+)\)\s*$/;
            const categoryMatch = partWithoutPrice.match(categoryPattern);
            if (categoryMatch && categoryMatch.index !== undefined) {
              itemName = partWithoutPrice.substring(0, categoryMatch.index).trim();
              itemCategory = categoryMatch[1] || '';
              itemHeight = '';
            } else {
              // Формат 4: просто "Название" (без размера и категории)
              itemName = partWithoutPrice.trim();
              itemHeight = '';
              itemCategory = '';
            }
          }
        }
        
        // Добавляем товар только если есть название
        if (itemName) {
          items.push({
            name: itemName,
            height: itemHeight,
            category: itemCategory,
            price: price
          });
        }
      }
    }
  }
  
  // Если товары не найдены, используем старый формат
  if (items.length === 0) {
    const h = p.height_cm ? ` — ${p.height_cm} см` : '';
    const cat = p.category ? ` (${p.category})` : '';
    items = [{
      name: p.title || 'Товар',
      height: p.height_cm || '',
      category: p.category || '',
      price: p.amount || 0
    }];
  }
  
  // Формируем список товаров
  const itemsList = items.map((item: MessageItem) => {
    // Для декора с вариантами (height содержит "х") показываем размер как есть, без " см"
    // Для елок (height - число) показываем с " см"
    const isDecor = item.category === 'Декор';
    const hasVariant = item.height && /х/i.test(item.height); // Проверяем наличие "х" в размере
    const h = item.height 
      ? (isDecor && hasVariant ? ` (${escapeHtml(item.height)})` : ` ${escapeHtml(item.height)} см`)
      : '';
    const cat = item.category ? ` (${escapeHtml(item.category)})` : '';
    const price = item.price > 0 ? fmtRub(item.price) : '';
    return `• ${escapeHtml(item.name)}${h}${cat}${price ? ` — ${price}` : ''}`;
  }).join('\n');
  
  const itemBaseTotal = items.reduce((sum: number, item: MessageItem) => sum + (Number(item.price) || 0), 0);
  const calculatedDiscount = p.promo_code && itemBaseTotal > Number(p.amount || 0)
    ? itemBaseTotal - Number(p.amount || 0)
    : 0;
  const discountText = p.promo_discount_text
    ? escapeHtml(p.promo_discount_text)
    : calculatedDiscount > 0
      ? fmtRub(calculatedDiscount)
    : '';
  const giftText = p.promo_gift_text ? escapeHtml(p.promo_gift_text) : '';
  const promo = p.promo_code
    ? discountText && giftText
      ? `Промокод «${escapeHtml(p.promo_code)}» дал скидку <b>${discountText}</b> и подарок: <b>${giftText}</b>`
      : discountText
        ? `Промокод «${escapeHtml(p.promo_code)}» дал скидку <b>${discountText}</b>`
        : giftText
          ? `Промокод «${escapeHtml(p.promo_code)}» даёт подарок: <b>${giftText}</b>`
          : `Применён промокод «${escapeHtml(p.promo_code)}»`
    : '';
  const contactPref = String(p.contact_pref || '').trim();
  const phoneValue = normalizeOrderPhone(p.phone);
  // Для Telegram/WhatsApp номер должен быть кликабельным: без скобок, тире и пробелов
  const phoneForMessenger = phoneValue.replace(/[\s()\-]/g, '');
  let contact = '';
  if ((phoneValue || p.email) && /telegram|whatsapp/i.test(contactPref)) {
    contact = `Связаться можно в ${escapeHtml(contactPref)}${phoneValue ? ` (${escapeHtml(phoneForMessenger)})` : ''}`;
  } else if ((phoneValue || p.email) && /позвон/i.test(contactPref)) {
    contact = phoneValue ? `Покупателю можно позвонить: ${escapeHtml(phoneValue)}` : 'Покупатель просит позвонить';
  } else if ((phoneValue || p.email) && contactPref) {
    contact = `Предпочтительный способ связи: ${escapeHtml(contactPref)}${phoneValue ? ` (${escapeHtml(phoneValue)})` : ''}`;
  } else if (phoneValue) {
    contact = `Связаться можно по телефону: ${escapeHtml(phoneValue)}`;
  }
  const name  = p.clientId ? `Покупатель: ${escapeHtml(p.clientId)}` : '';
  const email = p.email ? `Email: ${escapeHtml(p.email)}` : '';
  const addr  = p.address ? `Адрес: ${escapeHtml(formatAddress(p.address))}` : '';


  // Если подарок без денежной скидки — сумма не меняется, строка «Итого» тут лишняя
  const giftOnly = !!giftText && !discountText;

  return [
    `\n<b>В заказе:</b>\n${itemsList}`,
    promo ? `\n${promo}` : '',
    giftOnly ? '' : `\n<b>Итого: ${fmtRub(p.amount)}</b>`,
    name ? `\n${name}` : '',
    contact,
    email ? `\n${email}` : '',
    addr
  ].filter(Boolean).join('\n');
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' };
  return String(value||'').replace(/[&<>"']/g, character => entities[character] || (character === "'" ? '&#39;' : character));
}

function formatAddress(address: string): string {
  return String(address || '')
    .replace(/(^|[\s,])город\s+/gi, '$1г. ')
    .replace(/\bобласть\b/gi, 'обл.');
}

function formatOrderDate(orderId: string): string {
  const match = String(orderId || '').match(/^LE-(\d{10,})-/i);
  if (!match) return '';
  const orderDate = new Date(Number(match[1]));
  if (Number.isNaN(orderDate.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', year: 'numeric' };
  const formatter = new Intl.DateTimeFormat('ru-RU', options);
  const dateText = formatter.format(orderDate).replace(/\s*г\.$/, '');
  const todayText = formatter.format(new Date()).replace(/\s*г\.$/, '');
  if (dateText === todayText) return '';
  return `Заказ был оформлен ${dateText}`;
}

// ======================== Deno / Supabase рантайм-обёртка ========================
// Превращает входящий Request в event-объект (httpMethod, path,
// headers, queryStringParameters, body), вызывает handler и мапит ответ в Response.
Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // заголовки → плоский объект с ключами в нижнем регистре (код читает и lower, и Capitalized —
  // lower-варианта достаточно, т.к. Headers и так регистронезависимы)
  const headersObj: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headersObj[k.toLowerCase()] = v;

  // query-параметры → объект
  const qs: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) qs[k] = v;

  // тело как строка (для GET/HEAD/OPTIONS — пусто)
  let body = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await boundedRequestBody(req); }
    catch (error) {
      const failure = paymentError(error);
      return new Response(JSON.stringify({ error: failure.message }), { status: failure.inputStatus || 400,
        headers: corsHeaders(process.env.CORS_ORIGIN || '*', headersObj.origin || '') });
    }
  }

  const event = {
    httpMethod: req.method,
    path: url.pathname,
    headers: headersObj,
    queryStringParameters: qs,
    body,
    isBase64Encoded: false,
  };

  let out: HttpResponse;
  try {
    out = await handler(event);
  } catch (e) {
    console.error('Handler crashed', e);
    out = resp(500, { error: 'Internal Error' }, corsHeaders(process.env.CORS_ORIGIN || '*', headersObj.origin || ''));
  }

  // 204/304 не могут иметь тело — иначе конструктор Response бросает исключение (→ 500 на preflight)
  const status = out.statusCode ?? 200;
  const nullBody = status === 204 || status === 304 || status === 101;
  return new Response(nullBody ? null : (out.body ?? ''), {
    status,
    headers: out.headers ?? {},
  });
});
