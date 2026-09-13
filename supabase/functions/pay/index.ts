// Supabase Edge Function (Deno) — порт бывшей YandexCloud Function.
// Логика платежей PayKeeper + вебхук → Telegram перенесена БЕЗ изменений.
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

async function fetchAlfa(url: string, opts: RequestInit = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, client: getAlfaHttpClient() });
  } finally {
    clearTimeout(timer);
  }
}

// fetch с таймаутом: без этого зависший внешний хост (напр. IP-фильтр на стороне
// PayKeeper) вешает функцию на весь платформенный лимит вместо понятной ошибки.
async function fetchT(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Шим: даём коду обращаться к process.env.* как раньше
const process = { env: new Proxy({}, { get: (_t, k) => Deno.env.get(String(k)) }) };

async function handler(event) {
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

  // ВРЕМЕННО: echo env и кандидатов
  if (false) { // debug-эндпоинт отключён: раньше отдавал HOOK_SECRET в hex/base64 публично
    const H  = event.headers || {};
    const qs = event.queryStringParameters || {};
    const { data = {} } = await readBodyAny(event);

    const norm = s => String(s||'')
      .replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/[\r\n]/g,'')
      .replace(/[\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]/g,' ')
      .replace(/[\u2010-\u2015\u2212]/g,'-').trim();

    const hookSecret = norm(process.env.HOOK_SECRET);

    const bearer = (() => {
      const a = String(H['authorization']||H['Authorization']||'');
      return a.startsWith('Bearer ') ? a.slice(7) : '';
    })();

  const candRaw = [
    H['x-hook-secret'], H['X-Hook-Secret'],
    qs.secret,
    data.secret_word, data.secret, data.key, data.token,
    bearer
  ].filter(v=>v!=null);

  const cand = candRaw.map(norm).filter(Boolean);

  const toHex = s => Buffer.from(s,'utf8').toString('hex');
  const toB64 = s => Buffer.from(s,'utf8').toString('base64');

  return resp(200, {
    env_len: hookSecret.length,
    env_head: hookSecret.slice(0,4),
    env_tail: hookSecret.slice(-4),
    env_hex: toHex(hookSecret),
    env_b64: toB64(hookSecret),
    cand: cand.map(x => ({
      len: x.length,
      head: x.slice(0,4),
      tail: x.slice(-4),
      hex: toHex(x),
      b64: toB64(x)
    }))
  }, headers);
}

  // ---- Роутер
  try {
    if (method === 'POST') {
      const { data = {} } = await readBodyAny(event);
      
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
      const action = qs.action || data.action || '';
      
      if (isPayIntent && (path.endsWith('/api/pay') || path.includes('/pay') || action === 'pay')) {
        // Это запрос на создание платежа
        return await routePay(data, headers);
      }
      
      // Новый endpoint: проверка статуса платежа через API PayKeeper
      if (action === 'check-payment' || action === 'check') {
        return await routeCheckPayment(data, headers);
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

  } catch (e) {
    console.error('Unhandled error', e);
    return resp(500, { error: 'Internal Error', detail: String(e?.message || e) }, headers);
  }
};

// Кеш для дедупликации уведомлений (в памяти, только для текущего инстанса)
// Ключ: invoice_id или orderId-amount, значение: timestamp последней отправки
// ВАЖНО: в serverless функциях кеш работает только в рамках одного инстанса
// Для production лучше использовать внешнее хранилище (Redis, DynamoDB)
const notificationCache = new Map();

// Очистка старых записей из кеша (старше 24 часов)
// Кеш хранится дольше, чтобы предотвратить дубликаты даже для старых заказов
function cleanNotificationCache() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 часа
  for (const [key, timestamp] of notificationCache.entries()) {
    if (now - timestamp > maxAge) {
      notificationCache.delete(key);
    }
  }
}

// ======================== /api/hook ========================
async function routeHook(event, headers){
  const qs = event.queryStringParameters || {};
  const H  = event.headers || {};
  const { data = {}, raw = '', ctype = '' } = (event.__data ? {data:event.__data, raw:'', ctype:''} : await readBodyAny(event));

  // Логируем только ошибки и успешные отправки

  // нормализация: убираем zero-width, \r, \n, табы и пробелы по краям
  const norm = s => String(s||'')
    .replace(/[\u200B-\u200D\uFEFF]/g,'')
    .replace(/\r|\n/g,'')
    .trim();

  const hookSecret = norm(process.env.HOOK_SECRET);

  // собираем все возможные места секрета и нормализуем
  const candidates = [
    H['x-hook-secret'], H['X-Hook-Secret'],
    qs.secret, // PayKeeper отправляет секрет в query string
    data.secret_word, data.secret, data.key, data.token,
    // на всякий случай Bearer
    (String(H['authorization']||H['Authorization']||'').startsWith('Bearer ')
      ? String(H['authorization']||H['Authorization']).slice(7) : '')
  ].map(norm).filter(Boolean);

  // Проверка секрета (логируем только при ошибке)

  if (hookSecret && !candidates.includes(hookSecret)) {
    console.error('Bad hook secret', {
      expected: hookSecret.slice(0,4)+'...'+hookSecret.slice(-4),
      received: candidates.map(s => s.slice(0,4)+'...'+s.slice(-4))
    });
    return resp(401, { ok:false, error:'Bad hook secret' }, headers);
  }

  if (data.callback_query) {
    return await handleTelegramCallback(data.callback_query, headers);
  }

  const callbackData = { ...qs, ...data };
  const isAlfaCallback = Boolean(
    callbackData.mdOrder || callbackData.orderNumber || callbackData.operation
  );

  let p;
  if (isAlfaCallback) {
    const operation = String(callbackData.operation || '').toLowerCase();
    const callbackStatus = String(callbackData.status || '');
    const mdOrder = String(callbackData.mdOrder || '').trim();

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
    const deposited =
      Number(alfaOrder?.orderStatus) === 2 ||
      String(alfaOrder?.paymentState || '').toUpperCase() === 'DEPOSITED';

    if (!deposited) {
      return resp(200, {
        ok: true,
        received: true,
        paid: false,
        reason: 'Payment is not deposited according to Alfa API'
      }, headers);
    }

    const amountKopecks = Number(
      alfaOrder?.paymentAmountInfo?.depositedAmount ??
      alfaOrder?.paymentAmountInfo?.paymentAmount ??
      alfaOrder?.amount ?? 0
    );
    const description = String(
      alfaOrder?.orderDescription || callbackData.description || ''
    );

    p = normPaymentPayload({
      ...callbackData,
      ...getAlfaCustomerDetails(alfaOrder),
      paid: true,
      status: 'paid',
      invoice_id: mdOrder,
      orderId: alfaOrder?.orderNumber || callbackData.orderNumber || '',
      amount: amountKopecks / 100,
      description,
      service_name: description
    });
  } else {
    p = normPaymentPayload(data);
  }
  
  // ВАЖНО: Проверяем возраст заказа ДО автоматической проверки через API
  // Если заказ старше 10 минут, не обрабатываем его (даже если он оплачен)
  // Это предотвращает отправку уведомлений о старых заказах
  // PayKeeper может отправлять webhook'и для старых неоплаченных заказов одновременно
  if (p.orderId) {
    const orderIdMatch = p.orderId.match(/LE-(\d+)-/);
    if (orderIdMatch) {
      const orderTimestamp = parseInt(orderIdMatch[1], 10);
      const now = Date.now();
      const orderAge = now - orderTimestamp;
      const maxAge = 10 * 60 * 1000; // 10 минут (ужесточено с 30 минут)
      
      if (orderAge > maxAge) {
        // Старый заказ - игнорируем, даже если он оплачен
        return resp(200, { ok:true, received:true, paid:p.paid, notified:false, reason: 'Old order (more than 10 minutes ago)' }, headers);
      }
    }
  }
  
  if (!p.paid) {
    // Если webhook приходит с неопределенным статусом (пустой status и paid=false),
    // но есть invoice_id и sum, проверяем статус через API PayKeeper
    // Это может быть webhook ДО оплаты или webhook с неполными данными
    const hasInvoiceId = p.invoice_id && p.invoice_id.trim();
    const hasAmount = p.amount && p.amount > 0;
    const hasUncertainStatus = !data.status || data.status.trim() === '' || data.status === '0';
    
    if (hasInvoiceId && hasAmount && hasUncertainStatus) {
      // Проверяем статус через API PayKeeper (логируем только ошибки)
      try {
        const pkHost = process.env.PK_HOST || '';
        const pkUser = process.env.PK_USER || '';
        const pkPass = process.env.PK_PASS || '';
        
        if (pkHost && pkUser && pkPass) {
          const base = `https://${pkHost}`;
          const auth = 'Basic ' + Buffer.from(`${pkUser}:${pkPass}`).toString('base64');
          const apiUrl = `${base}/info/invoice/byid/?id=${encodeURIComponent(p.invoice_id)}`;
          
          const res = await fetchT(apiUrl, {
            headers: {
              'Authorization': auth,
              'Content-Type': 'application/json'
            }
          });
          
          if (res.ok) {
            const invoiceData = await res.json().catch(() => null);
            
            if (invoiceData) {
              const isPaid = invoiceData.paid === true || 
                             invoiceData.status === 'paid' || 
                             String(invoiceData.status || '').toLowerCase().includes('paid') ||
                             invoiceData.status === '1';
              
              if (isPaid) {
                // Обновляем статус и продолжаем обработку
                p.paid = true;
                p.status = invoiceData.status || 'paid';
                
                // Обновляем данные из API, если они есть
                if (invoiceData.orderid && !p.orderId) p.orderId = invoiceData.orderid;
                if (invoiceData.clientid && !p.clientId) p.clientId = invoiceData.clientid;
                if (invoiceData.client_email && !p.email) p.email = invoiceData.client_email;
                if (invoiceData.client_phone && !p.phone) p.phone = invoiceData.client_phone;
                if (invoiceData.service_name && !p.title) p.title = invoiceData.service_name;
              } else {
                return resp(200, { ok:true, received:true, paid:false, reason: 'Payment not paid (checked via API)' }, headers);
              }
            }
          }
        }
      } catch (apiError) {
        console.error('API check failed, using webhook data', {
          invoice_id: p.invoice_id,
          error: String(apiError)
        });
        // Если проверка через API не удалась, используем данные из webhook
        return resp(200, { ok:true, received:true, paid:false, reason: 'Status is not "paid" or payment not confirmed' }, headers);
      }
    } else {
      // Если нет invoice_id или sum, или статус явно неоплаченный - просто возвращаем
      return resp(200, { ok:true, received:true, paid:false, reason: 'Status is not "paid" or payment not confirmed' }, headers);
    }
  }

  // Дедупликация: проверяем, не отправляли ли мы уже уведомление для этого платежа
  // Используем invoice_id как основной ключ (это уникальный ID платежа от PayKeeper)
  // Если invoice_id нет, используем orderId для уникальности
  // ВАЖНО: используем invoice_id, так как это уникальный ID платежа от PayKeeper
  
  // Создаем уникальный ключ для дедупликации
  // Используем invoice_id если есть, иначе orderId (без amount, так как amount может быть одинаковым)
  const cacheKey = p.invoice_id || p.orderId || 'unknown';
  cleanNotificationCache();
  
  // Проверяем, не отправляли ли мы уже уведомление для этого платежа
  // ВАЖНО: в serverless окружении кеш работает только в рамках одного инстанса
  // PayKeeper может отправлять webhook повторно через 5 минут, и запрос может обработаться другим инстансом
  // Поэтому проверяем через API PayKeeper, если invoice_id уже был обработан ранее
  if (notificationCache.has(cacheKey)) {
    const lastSent = notificationCache.get(cacheKey);
    const timeSinceLastSent = Date.now() - lastSent;
    // Если прошло меньше 10 минут с момента последней отправки - это дубликат
    if (timeSinceLastSent < 10 * 60 * 1000) {
      return resp(200, { ok:true, received:true, paid:true, notified:false, duplicate:true, reason: 'Duplicate webhook (already sent within 10 minutes)' }, headers);
    }
  }
  
  // Дополнительная проверка: если invoice_id есть, проверяем через API PayKeeper
  // был ли этот invoice_id уже обработан ранее (для защиты от повторных webhook'ов от PayKeeper)
  // PayKeeper может отправлять webhook повторно через 5 минут для того же invoice_id
  if (p.invoice_id && p.paid) {
    // Проверяем, был ли этот invoice_id уже обработан в последние 10 минут
    // Если да, и он уже был оплачен - это повторный webhook, не отправляем
    const cacheKeyForInvoice = `invoice_${p.invoice_id}`;
    if (notificationCache.has(cacheKeyForInvoice)) {
      const lastSentForInvoice = notificationCache.get(cacheKeyForInvoice);
      const timeSinceLastSentForInvoice = Date.now() - lastSentForInvoice;
      if (timeSinceLastSentForInvoice < 10 * 60 * 1000) {
        return resp(200, { ok:true, received:true, paid:true, notified:false, duplicate:true, reason: 'Duplicate webhook for invoice_id (already sent within 10 minutes)' }, headers);
      }
    }
  }

  // Сохраняем в кеш ПЕРЕД отправкой, чтобы предотвратить параллельные отправки
  const now = Date.now();
  notificationCache.set(cacheKey, now);
  // Также сохраняем по invoice_id для дополнительной защиты от повторных webhook'ов
  if (p.invoice_id) {
    notificationCache.set(`invoice_${p.invoice_id}`, now);
  }
  
  try {
    // ВРЕМЕННО: логируем desc для отладки
    const descForParsing = p.raw_description || p.service_name || p.description || p.title || '';
    console.log('desc for parsing:', descForParsing.substring(0, 300));
    
    const msg = buildMsg(p);
    await tgBroadcast(msg, p.invoice_id);
    await markPaymentNotified(p.invoice_id);
    console.log('✅ Telegram sent', { invoice_id: p.invoice_id, orderId: p.orderId });
    return resp(200, { ok:true, notified:true, orderId: p.orderId, invoice_id: p.invoice_id }, headers);
  } catch (tgError) {
    // Если отправка не удалась, удаляем из кеша, чтобы можно было повторить
    notificationCache.delete(cacheKey);
    if (p.invoice_id) {
      notificationCache.delete(`invoice_${p.invoice_id}`);
    }
    console.error('Telegram notification failed', {
      error: String(tgError),
      stack: tgError.stack,
      orderId: p.orderId,
      invoice_id: p.invoice_id
    });
    return resp(200, { ok:true, received:true, paid:true, notified:false, error: String(tgError) }, headers);
  }
}

// ======================== /api/check-payment ========================
// Проверка статуса платежа через API PayKeeper (если webhook не приходит)
async function routeCheckPayment(data, headers){
  const invoiceId = String(data.invoice_id || data.id || '').trim();
  const orderId = String(data.orderId || data.orderid || '').trim();
  
  if (!invoiceId && !orderId) {
    return resp(400, { error: 'Missing invoice_id or orderId' }, headers);
  }
  
  const pkHost = process.env.PK_HOST || '';
  const pkUser = process.env.PK_USER || '';
  const pkPass = process.env.PK_PASS || '';
  
  if (!pkHost || !pkUser || !pkPass) {
    return resp(500, { error: 'PayKeeper not configured' }, headers);
  }
  
  try {
    const base = `https://${pkHost}`;
    const auth = 'Basic ' + Buffer.from(`${pkUser}:${pkPass}`).toString('base64');
    
    // Получаем информацию о счете через API PayKeeper
    // PayKeeper API: /info/invoice/byid/?id={invoice_id}
    const apiUrl = invoiceId 
      ? `${base}/info/invoice/byid/?id=${encodeURIComponent(invoiceId)}`
      : `${base}/info/invoice/byorder/?orderid=${encodeURIComponent(orderId)}`;
    
    // Проверяем статус через API PayKeeper
    
    const res = await fetchT(apiUrl, {
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json'
      }
    });
    
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('PayKeeper API error', { status: res.status, body: text.substring(0, 200) });
      return resp(502, { error: 'PayKeeper API error', status: res.status }, headers);
    }
    
    const invoiceData = await res.json().catch(() => null);
    
    if (!invoiceData) {
      return resp(502, { error: 'Invalid response from PayKeeper' }, headers);
    }
    
    // Данные от PayKeeper получены
    
    // Если платеж оплачен, отправляем уведомление в Telegram
    const isPaid = invoiceData.paid === true || 
                   invoiceData.status === 'paid' || 
                   String(invoiceData.status || '').toLowerCase().includes('paid') ||
                   invoiceData.status === '1';
    
    if (isPaid) {
      // Нормализуем данные для отправки в Telegram
      const normalizedData = {
        id: invoiceData.id,
        invoice_id: invoiceData.id,
        sum: invoiceData.sum,
        status: invoiceData.status || 'paid',
        paid: true,
        orderid: invoiceData.orderid || orderId,
        clientid: invoiceData.clientid || '',
        client_email: invoiceData.client_email || '',
        client_phone: invoiceData.client_phone || '',
        service_name: invoiceData.service_name || ''
      };
      
      const p = normPaymentPayload(normalizedData);
      
      // ВАЖНО: Проверяем возраст заказа ДО отправки уведомления
      // Если заказ старше 10 минут, не отправляем уведомление
      if (p.orderId) {
        const orderIdMatch = p.orderId.match(/LE-(\d+)-/);
        if (orderIdMatch) {
          const orderTimestamp = parseInt(orderIdMatch[1], 10);
          const now = Date.now();
          const orderAge = now - orderTimestamp;
          const maxAge = 10 * 60 * 1000; // 10 минут (ужесточено с 30 минут)
          
          if (orderAge > maxAge) {
            return resp(200, { 
              ok: true, 
              paid: true, 
              notified: false, 
              reason: 'Old order (more than 10 minutes ago)' 
            }, headers);
          }
        }
      }
      
      // Проверяем дедупликацию
      const cacheKey = p.invoice_id || p.orderId || 'unknown';
      cleanNotificationCache();
      
      if (notificationCache.has(cacheKey)) {
        return resp(200, { 
          ok: true, 
          paid: true, 
          notified: false, 
          duplicate: true,
          message: 'Payment already notified' 
        }, headers);
      }
      
      notificationCache.set(cacheKey, Date.now());
      
      try {
        const msg = buildMsg(p);
        await tgBroadcast(msg, p.invoice_id);
        // Уведомление отправлено
        return resp(200, { 
          ok: true, 
          paid: true, 
          notified: true,
          invoice_id: p.invoice_id,
          orderId: p.orderId
        }, headers);
      } catch (tgError) {
        notificationCache.delete(cacheKey);
        console.error('Telegram notification failed in check-payment', tgError);
        return resp(200, { 
          ok: true, 
          paid: true, 
          notified: false, 
          error: String(tgError) 
        }, headers);
      }
    } else {
      return resp(200, { 
        ok: true, 
        paid: false, 
        status: invoiceData.status,
        message: 'Payment not paid yet' 
      }, headers);
    }
    
  } catch (error) {
    console.error('Check payment error', error);
    return resp(500, { error: 'Internal error', detail: String(error) }, headers);
  }
}

// ======================== /api/send-notification ========================
// Ручная отправка уведомления в Telegram (для тестирования)
async function routeSendNotification(event, headers){
  const data = event.__data || await readBodyAny(event).then(r => r.data);
  
  // Проверяем секрет для безопасности
  const qs = event.queryStringParameters || {};
  const secret = qs.secret || data.secret || '';
  const expectedSecret = (process.env.HOOK_SECRET || '').trim();
  
  if (secret !== expectedSecret) {
    return resp(401, { error: 'Unauthorized' }, headers);
  }
  
  try {
    const p = normPaymentPayload(data);
    
    if (!p.paid) {
      return resp(400, { error: 'Payment not paid', paid: p.paid, status: p.status }, headers);
    }
    
    const cacheKey = p.invoice_id || p.orderId || 'unknown';
    cleanNotificationCache();
    
    // Пропускаем дедупликацию для ручной отправки (или делаем принудительную отправку)
    const force = data.force === true || data.force === 'true';
    
    if (!force && notificationCache.has(cacheKey)) {
      return resp(200, { 
        ok: true, 
        notified: false, 
        duplicate: true,
        message: 'Already notified, use force=true to resend' 
      }, headers);
    }
    
    if (force) {
      notificationCache.delete(cacheKey);
    }
    
    notificationCache.set(cacheKey, Date.now());
    
    const msg = buildMsg(p);
      await tgBroadcast(msg, p.invoice_id);
    
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

async function getAlfaOrderStatus(mdOrder){
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
  const body = await res.json().catch(() => null);

  const errorCode = String(body?.errorCode ?? '0');
  if (!res.ok || !body || (errorCode !== '0' && errorCode !== '')) {
    throw new Error(body?.errorMessage || `Alfa status API returned HTTP ${res.status}`);
  }
  return body;
}

function getAlfaCustomerDetails(order) {
  const arrays = [order?.merchantOrderParams, order?.attributes, order?.transactionAttributes]
    .filter(Array.isArray);
  const param = (...names) => {
    const wanted = names.map(name => String(name).toLowerCase());
    for (const list of arrays) {
      const found = list.find(item => wanted.includes(String(item?.name || item?.key || '').toLowerCase()));
      const value = found?.value ?? found?.val;
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
  };
  const first = (...values) => String(values.find(value => value != null && String(value).trim()) || '').trim();
  return {
    clientid: first(order?.clientId, order?.clientInfo?.clientId, param('clientId', 'client_id', 'fio', 'name')),
    client_email: first(order?.email, order?.clientEmail, order?.clientInfo?.email, order?.orderBundle?.customerDetails?.email, param('email', 'client_email')),
    client_phone: first(order?.phone, order?.clientPhone, order?.clientInfo?.phone, order?.orderBundle?.customerDetails?.phone, param('phone', 'client_phone'))
  };
}

async function supabaseAdminRequest(path, options = {}) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !serviceKey) throw new Error('Supabase service role is not configured');

  return await fetchT(`${base}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function savePaymentOrder(order) {
  const res = await supabaseAdminRequest('payment_orders?on_conflict=md_order', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(order)
  });
  if (!res.ok) throw new Error(`Cannot save payment order: ${await res.text()}`);
}

async function markPaymentNotified(mdOrder) {
  if (!mdOrder) return;
  const res = await supabaseAdminRequest(`payment_orders?md_order=eq.${encodeURIComponent(mdOrder)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'paid', notified_at: new Date().toISOString(), last_error: null })
  });
  if (!res.ok) console.error('Cannot mark payment notified', await res.text());
}

async function routePollPayments(event, headers) {
  const pollToken = String(event.headers?.['x-poll-token'] || event.headers?.['X-Poll-Token'] || '');
  const expectedToken = process.env.ALFA_CALLBACK_TOKEN || '';
  if (!expectedToken || pollToken !== expectedToken) {
    return resp(401, { ok: false, error: 'Unauthorized' }, headers);
  }

  const select = 'md_order,order_number,amount,description,created_at';
  const query = `payment_orders?select=${select}&notified_at=is.null&created_at=gte.${encodeURIComponent(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())}&order=created_at.asc&limit=50`;
  const pendingRes = await supabaseAdminRequest(query);
  if (!pendingRes.ok) throw new Error(`Cannot load pending payments: ${await pendingRes.text()}`);
  const pending = await pendingRes.json();
  let notified = 0;

  for (const order of pending) {
    try {
      const alfaOrder = await getAlfaOrderStatus(order.md_order);
      const deposited = Number(alfaOrder?.orderStatus) === 2 ||
        String(alfaOrder?.paymentState || '').toUpperCase() === 'DEPOSITED';
      if (!deposited) continue;

      const amountKopecks = Number(
        alfaOrder?.paymentAmountInfo?.depositedAmount ??
        alfaOrder?.paymentAmountInfo?.paymentAmount ??
        Math.round(Number(order.amount || 0) * 100)
      );
      const description = String(alfaOrder?.orderDescription || order.description || 'Оплата заказа');
      const p = normPaymentPayload({
        ...getAlfaCustomerDetails(alfaOrder),
        paid: true,
        status: 'paid',
        invoice_id: order.md_order,
        orderId: alfaOrder?.orderNumber || order.order_number,
        amount: amountKopecks / 100,
        description,
        service_name: description
      });
      await tgBroadcast(buildMsg(p), p.invoice_id);
      await markPaymentNotified(order.md_order);
      notified += 1;
    } catch (error) {
      console.error('Payment polling failed', { mdOrder: order.md_order, error: String(error) });
      await supabaseAdminRequest(`payment_orders?md_order=eq.${encodeURIComponent(order.md_order)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_checked_at: new Date().toISOString(), last_error: String(error).slice(0, 500) })
      }).catch(() => null);
    }
  }

  return resp(200, { ok: true, checked: pending.length, notified }, headers);
}

async function routePay(data, headers){
  // ВАЖНО: функция должна возвращать JSON с URL на оплату, а не редирект!
  
  const amount = Number(data.amount || 0);
  const description = String(data.description || 'Оплата заказа');
  const email = String(data.email || '').trim();
  const phone = String(data.phone || '').trim();
  const orderId = String(data.orderId || `order-${Date.now()}`).trim();
  const clientId = String(data.clientId || '').trim();
  const successUrl = String(data.successUrl || 'https://lady-elka.ru/spasibo').trim();
  const failUrl = String(data.failUrl || 'https://lady-elka.ru/pay-return?fail=1').trim();
  const promoCode = String(data.promoCode || '').trim();

  // Проверяем обязательные поля
  if (!amount || amount <= 0) {
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

  try {
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
    let alfaJson;
    try { alfaJson = JSON.parse(alfaText); }
    catch { alfaJson = null; }

    if (!alfaRes.ok || !alfaJson?.formUrl) {
      console.error('Alfa-Bank order registration failed', {
        status: alfaRes.status,
        errorCode: alfaJson?.errorCode,
        errorMessage: alfaJson?.errorMessage
      });
      return resp(502, {
        error: 'Payment registration failed',
        errorCode: alfaJson?.errorCode || '',
        message: alfaJson?.errorMessage || 'Альфа-Банк не создал платёж'
      }, headers);
    }

    try {
      await savePaymentOrder({
        md_order: alfaJson.orderId,
        order_number: orderId.slice(0, 32),
        amount,
        description: description.slice(0, 512),
        status: 'pending'
      });
    } catch (storeError) {
      console.error('Payment order persistence failed', String(storeError));
    }

    return resp(200, {
      url: alfaJson.formUrl,
      paymentId: alfaJson.orderId,
      orderId: orderId,
      amount: amount,
      description: description
    }, headers);

  } catch (error) {
    console.error('Alfa-Bank integration error', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return resp(500, { 
      error: 'Payment creation failed', 
      message: 'Не удалось создать платеж: ' + errorMessage,
      detail: String(error)
    }, headers);
  }
}

function corsHeaders(allowed, origin){
  const list = String(allowed).split(',').map(s=>s.trim()).filter(Boolean);
  let allow = '*';
  if (!list.includes('*') && origin) allow = list.includes(origin) ? origin : list[0] || origin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-hook-secret,authorization',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

// ======================== Helpers =========================
function resp(code, data, headers){
  return { statusCode: code, headers, body: typeof data==='string' ? data : JSON.stringify(data) };
}

async function readBody(event){
  try { return JSON.parse(event.body || '{}'); } catch { return {}; }
}
// читает JSON или form-urlencoded
async function readBodyAny(event){
  const ctype = String(event.headers?.['content-type'] || event.headers?.['Content-Type'] || '').toLowerCase();

  // достаём сырое тело + декод base64 при необходимости
  let raw = event.body || '';
  if (event.isBase64Encoded && typeof raw === 'string') {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch {}
  }

  if (ctype.includes('application/json')) {
    try { return { data: JSON.parse(raw || '{}'), raw, ctype }; } catch { return { data:{}, raw, ctype }; }
  }
  if (ctype.includes('application/x-www-form-urlencoded')) {
    const params = Object.fromEntries(new URLSearchParams(raw));
    return { data: params, raw, ctype };
  }

  // попытка распарсить как json, иначе пусто
  try { return { data: JSON.parse(raw || '{}'), raw, ctype }; } catch { return { data:{}, raw, ctype }; }
}

async function safeJson(res){ try { return await res.json(); } catch { return null; } }
async function safeText(res){ try { return await res.text(); } catch { return null; } }

async function handleTelegramCallback(callback, headers){
  const token = (Deno.env.get('TG_BOT_TOKEN') || '').trim();
  if (!token || !callback?.id) {
    return resp(400, { ok:false, error:'Invalid callback' }, headers);
  }

  const api = `https://api.telegram.org/bot${token}`;
  const currentMarkup = callback.message?.reply_markup || {};
  const alfaUrl = currentMarkup.inline_keyboard?.flat?.()
    ?.find(button => button?.text === 'Детали заказа в Alfa')?.url || alfaTransactionUrl('');
  const statusByCallback = {
    order_status_waiting: { label: '⏳ Ожидает', notice: 'Статус: ожидает' },
    order_status_contacted: { label: '💬 Связались', notice: 'Статус: связались' },
    order_status_preparing: { label: '📦 Подготовка товара', notice: 'Статус: подготовка товара' },
    order_status_sent: { label: '✅ Отправлен', notice: 'Статус: отправлен' },
    order_processed: { label: '✅ Отправлен', notice: 'Статус: отправлен' }
  };
  const selectedStatus = statusByCallback[callback.data];
  const nextMarkup = callback.data === 'order_status_menu'
    ? orderStatusChoices()
    : selectedStatus
      ? orderControls(alfaUrl, selectedStatus.label)
      : null;
  const notice = callback.data === 'order_status_menu'
    ? 'Выберите статус заказа'
    : selectedStatus?.notice || 'Текущий статус заказа';

  await fetchT(`${api}/answerCallbackQuery`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      callback_query_id: callback.id,
      text: notice
    })
  }).catch(() => null);

  if (nextMarkup && callback.message) {
    await fetchT(`${api}/editMessageReplyMarkup`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: nextMarkup
      })
    }).catch(() => null);
  }

  return resp(200, { ok:true }, headers);
}

function fmtRub(n){ return (Number(n)||0).toLocaleString('ru-RU')+' ₽'; }

// Телега
function alfaTransactionUrl(transactionId){
  const base = String(Deno.env.get('ALFA_DASHBOARD_URL') || 'https://payment.alfabank.ru/generalmp3/admin/transactions').trim().replace(/\/+$/, '');
  const id = String(transactionId || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? `${base}/${encodeURIComponent(id)}`
    : base;
}

function orderControls(alfaUrl, statusLabel = '⏳ Ожидает'){
  return { inline_keyboard: [
    [{ text: 'Детали заказа в Alfa', url: alfaUrl }],
    [{ text: `Статус заказа: ${statusLabel}`, callback_data: 'order_status_menu' }],
    [{ text: '✏️ Изменить статус', callback_data: 'order_status_menu' }]
  ] };
}

function orderStatusChoices(){
  return { inline_keyboard: [
    [{ text: '⏳ Ожидает', callback_data: 'order_status_waiting' }],
    [{ text: '💬 Связались', callback_data: 'order_status_contacted' }],
    [{ text: '📦 Подготовка товара', callback_data: 'order_status_preparing' }],
    [{ text: '✅ Отправлен', callback_data: 'order_status_sent' }]
  ] };
}

async function tgBroadcast(text, transactionId = ''){
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const photoUrl = String(process.env.TG_ORDER_PHOTO_URL || '').trim();
  const replyMarkup = orderControls(alfaTransactionUrl(transactionId));
  // ИСПРАВЛЕНО: улучшенный парсинг TG_CHAT_IDS - убираем все пробелы и разбиваем по запятой
  const rawIds = String(process.env.TG_CHAT_IDS||'').trim();
  const ids = rawIds.split(',').map(s=>s.trim()).filter(s => s && s.length > 0);
  
  // Логируем для отладки
  console.log('TG_CHAT_IDS parsing', {
    raw: rawIds,
    parsed: ids,
    count: ids.length
  });
  
  if (!token || !ids.length) { 
    console.warn('TG not configured', { hasToken: !!token, idsCount: ids.length }); 
    throw new Error('Telegram is not configured');
  }

  const sendAsPhoto = Boolean(photoUrl) && String(text).length <= 1024;
  const url = `https://api.telegram.org/bot${token}/${sendAsPhoto ? 'sendPhoto' : 'sendMessage'}`;

  await Promise.all(ids.map(async (id) => {
    try {
      // ИСПРАВЛЕНО: убеждаемся, что chat_id передается как строка (Telegram API принимает и строки, и числа)
      const chatId = String(id).trim();
      
      const res = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(sendAsPhoto
          ? {chat_id: chatId, photo: photoUrl, caption: text, parse_mode:'HTML', reply_markup: replyMarkup}
          : {chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true, reply_markup: replyMarkup})
      });
      
      let responseStatus = res.status;
      let j = await res.json().catch(()=>null);
      if ((!res.ok || !j?.ok) && sendAsPhoto) {
        const fallbackRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true, reply_markup: replyMarkup})
        });
        responseStatus = fallbackRes.status;
        j = await fallbackRes.json().catch(()=>null);
      }
      
      // ИСПРАВЛЕНО: проверяем ответ Telegram и логируем ошибки с деталями
      if (!j?.ok) {
        console.error('TG send error', {
          chatId, 
          status: responseStatus,
          statusText: res.statusText,
          body: j,
          errorCode: j?.error_code,
          description: j?.description
        });
        // Если ошибка 400 - возможно проблема с HTML тегами
        if (responseStatus === 400) {
          console.error('TG 400 error - возможно проблема с HTML тегами в сообщении:', text.substring(0, 200));
        }
        throw new Error(j?.description || `Telegram API returned HTTP ${res.status}`);
      } else {
        console.log('✅ TG message sent successfully', { chatId, messageId: j?.result?.message_id });
      }
    } catch (e){
      console.error('TG send exception', {id, error:String(e), stack: e.stack});
      throw e;
    }
  }));
}

// Строим нормальный объект платежа из разных форматов
function normPaymentPayload(src){
  const s = src || {};
  // статус
  const status = (s.status || s.payment_status || s.order_status || '').toString().toLowerCase();
  const statusNum = Number(s.status) || 0;
  
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
  
  // Проверяем, что это НЕ явно неоплаченный статус
  const isNotPaid = ['new','pending','wait','waiting','created','processing','cancel','canceled','fail','failed','error'].some(k=>status.includes(k));
  
  let paid = false;
  
  // Если статус явно неоплаченный - не оплачено
  if (isNotPaid) {
    paid = false;
  } else if (status && status.trim()) {
    // Есть статус и он не явно неоплаченный - проверяем признаки оплаты
    paid = ['paid','success','successfully','approved','confirmed','ok','done'].some(k=>status.includes(k)) ||
           (statusNum === 1) || // PayKeeper может отправлять 1 для успешной оплаты
           String(s.paid||s.success||'').toLowerCase()==='true' ||
           String(s.result||'').toLowerCase()==='success';
  } else {
    // Статус пустой - проверяем явные поля и возраст заказа
    // Если есть явное поле paid=true или success=true - оплачено
    // Иначе - не оплачено (PayKeeper отправляет webhook при создании счета без статуса)
    paid = String(s.paid||'').toLowerCase()==='true' ||
           String(s.success||'').toLowerCase()==='true' ||
           String(s.result||'').toLowerCase()==='success';
  }

  // сумма (PayKeeper отправляет sum)
  const amount = Number(s.amount || s.sum || s.total || 0);

  // реквизиты
  const p = {
    paid,
    status: status || (paid?'paid':''),
    invoice_id: s.invoice_id || s.id || s.bill_id || '',
    orderId: s.orderid || s.order_id || s.orderId || '',
    clientId: s.clientid || s.client_id || s.client || '',
    email: s.email || s.client_email || '',
    phone: s.phone || s.client_phone || '',
    title: s.title || s.product || s.service_name || '',
    category: s.category || '',
    height_cm: s.height_cm || '',
    amount,

    // наша мета (если фронт пробрасывает)
    address: s.address || s.addr || '',
    contact_pref: s.contact_pref || s.contact || '',
    promo_code: s.promo_code || s.promocode || s.promo || '',
    promo_discount_text: '',
    promo_gift_text: '',
    cartItems: s.cartItems || s.cart_items || null // массив товаров из корзины
  };
  
  // Логируем только при необходимости (убрано для уменьшения логов)

  // Пытаемся выдернуть из service_name то, что добавили в /api/pay
  // Пример: "Елка — Заснеженная, 180 см | Адрес: ... | Связь: ... | Промо: ..."
  const desc = s.service_name || s.description || '';
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
  p.service_name = s.service_name || s.description || '';
  p.description  = s.description  || s.service_name || '';
  p.raw_description = s.service_name || s.description || '';

  return p;
}

function buildMsg(p){
  // Пытаемся извлечь товары из cartItems или из description
  let items = [];
  if (p.cartItems && Array.isArray(p.cartItems)) {
    // Товары переданы напрямую
    items = p.cartItems;
  } else {
    // Пытаемся извлечь из description или service_name
    // Формат: "Товар1 — цена ₽ | Товар2 — цена ₽ | Адрес: ..."
    // ИСПРАВЛЕНО: используем raw_description, чтобы получить полный текст со всеми товарами
    const desc = p.raw_description || p.service_name || p.description || p.title || '';
    if (desc) {
      // Разбиваем по | и извлекаем товары (до "Адрес:", "Связь:", "Промо:")
      const parts = desc.split('|').map(s => s.trim());
      
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
  const itemsList = items.map(item => {
    // Для декора с вариантами (height содержит "х") показываем размер как есть, без " см"
    // Для елок (height - число) показываем с " см"
    const isDecor = item.category === 'Декор';
    const hasVariant = item.height && /х/i.test(item.height); // Проверяем наличие "х" в размере
    const h = item.height 
      ? (isDecor && hasVariant ? ` (${item.height})` : ` ${item.height} см`)
      : '';
    const cat = item.category ? ` (${item.category})` : '';
    const price = item.price > 0 ? fmtRub(item.price) : '';
    return `• ${escapeHtml(item.name)}${h}${cat}${price ? ` — ${price}` : ''}`;
  }).join('\n');
  
  const itemBaseTotal = items.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
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
  const phoneValue = String(p.phone || '').trim();
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
  const orderDate = formatOrderDate(p.orderId);

  // Если подарок без денежной скидки — сумма не меняется, строка «Итого» тут лишняя
  const giftOnly = !!giftText && !discountText;

  return [
    `\n<b>В заказе:</b>\n${itemsList}`,
    promo ? `\n${promo}` : '',
    giftOnly ? '' : `\n<b>Итого: ${fmtRub(p.amount)}</b>`,
    orderDate ? `\n${orderDate}` : '',
    name ? `\n${name}` : '',
    contact,
    email ? `\n${email}` : '',
    addr
  ].filter(Boolean).join('\n');
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

function formatAddress(address){
  return String(address || '')
    .replace(/(^|[\s,])город\s+/gi, '$1г. ')
    .replace(/\bобласть\b/gi, 'обл.');
}

function formatOrderDate(orderId){
  const match = String(orderId || '').match(/^LE-(\d{10,})-/i);
  if (!match) return '';
  const orderDate = new Date(Number(match[1]));
  if (Number.isNaN(orderDate.getTime())) return '';
  const options = { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', year: 'numeric' };
  const formatter = new Intl.DateTimeFormat('ru-RU', options);
  const dateText = formatter.format(orderDate).replace(/\s*г\.$/, '');
  const todayText = formatter.format(new Date()).replace(/\s*г\.$/, '');
  if (dateText === todayText) return '';
  return `Заказ был оформлен ${dateText}`;
}

// ======================== Deno / Supabase рантайм-обёртка ========================
// Превращает входящий Request в event-объект формата YandexCloud (httpMethod, path,
// headers, queryStringParameters, body), вызывает handler и мапит ответ в Response.
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // заголовки → плоский объект с ключами в нижнем регистре (код читает и lower, и Capitalized —
  // lower-варианта достаточно, т.к. Headers и так регистронезависимы)
  const headersObj = {};
  for (const [k, v] of req.headers.entries()) headersObj[k.toLowerCase()] = v;

  // query-параметры → объект
  const qs = {};
  for (const [k, v] of url.searchParams.entries()) qs[k] = v;

  // тело как строка (для GET/HEAD/OPTIONS — пусто)
  let body = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await req.text(); } catch { body = ''; }
  }

  const event = {
    httpMethod: req.method,
    path: url.pathname,
    headers: headersObj,
    queryStringParameters: qs,
    body,
    isBase64Encoded: false,
  };

  let out;
  try {
    out = await handler(event);
  } catch (e) {
    console.error('Handler crashed', e);
    out = { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Internal Error' }) };
  }

  // 204/304 не могут иметь тело — иначе конструктор Response бросает исключение (→ 500 на preflight)
  const status = out.statusCode ?? 200;
  const nullBody = status === 204 || status === 304 || status === 101;
  return new Response(nullBody ? null : (out.body ?? ''), {
    status,
    headers: out.headers ?? {},
  });
});
