import { readFile, writeFile, mkdir } from 'node:fs/promises';
import https from 'node:https';
import tls from 'node:tls';
import { leadEnv } from './lead-env.mjs';

// Owner-authorized scope: one unpaid RUB 100 invoice and one private message.
// This tests providers, not the still-closed public checkout. Never auto-retry
// registration or message delivery after an unknown network outcome.
if (process.argv[2] !== '--authorized-one-unpaid-private-test') throw new Error('Explicit one-test flag required');
const env = await leadEnv();
const ids = (env.TG_CHAT_IDS || '').split(/[\s,;]+/).filter(id => /^\d+$/.test(id) && Number(id) > 0);
if (ids.length !== 1 || !env.TG_BOT_TOKEN || !env.ALFA_API_USER || !env.ALFA_API_PASS || !env.SUPABASE_ACCESS_TOKEN)
  throw new Error('Exactly one private recipient and provider credentials are required');
const reportPath = 'audit/pay-v2/provider-smoke.json';
await mkdir('audit/pay-v2', { recursive: true });
try { await readFile(reportPath); throw new Error('Test journal already exists; inspect it instead of creating another invoice'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const report = { time: new Date().toISOString(), scope: 'one unpaid invoice and one private message',
  orderId: 'LEV2QA-' + Date.now(), amountRub: 100, chargeAttempted: false,
  publicCheckoutTested: false, legacyWrites: false };
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const bankBase = new URL(env.ALFA_API_BASE || 'https://payment.alfabank.ru/payment/rest');
if (bankBase.protocol !== 'https:' || bankBase.host !== 'payment.alfabank.ru') throw new Error('Unexpected bank host');
const ca = (await readFile('supabase/functions/pay/index.ts', 'utf8')).match(/const RUSSIAN_TRUSTED_ROOT_CA = `([\s\S]+?)`;/)?.[1];
if (!ca) throw new Error('Trusted bank CA unavailable');
async function bank(method, values) {
  const body = new URLSearchParams({ userName: env.ALFA_API_USER, password: env.ALFA_API_PASS, ...values }).toString();
  return new Promise((resolve, reject) => {
    const request = https.request(bankBase.href.replace(/\/$/, '') + '/' + method, {
      method: 'POST', ca: [...tls.rootCertificates, ca], timeout: 20000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { const data = JSON.parse(text); resolve({ http: response.statusCode, data }); }
        catch { reject(new Error('Invalid bank response; no automatic retry')); }
      });
    });
    request.on('error', () => reject(new Error('Bank response unavailable; no automatic retry')));
    request.on('timeout', () => request.destroy());
    request.end(body);
  });
}
async function telegram(method, body) {
  if (String(body.chat_id) !== ids[0]) throw new Error('Unexpected recipient');
  const response = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error('Telegram operation not confirmed');
  return data.result;
}
try {
  const chat = await telegram('getChat', { chat_id: ids[0] });
  if (chat.type !== 'private' || String(chat.id) !== ids[0]) throw new Error('Private recipient not confirmed');
  report.privateRecipientVerified = true;
  report.registration = 'started';
  await save();
  const registered = await bank('register.do', {
    orderNumber: report.orderId, amount: '10000',
    returnUrl: 'https://lady-elka.ru/spasibo', failUrl: 'https://lady-elka.ru/pay-return?fail=1',
    description: 'ТЕСТ pay-v2: неоплаченный счёт 100 рублей. Не оплачивать.', language: 'ru',
  });
  const { data } = registered;
  if (registered.http !== 200 || !data.orderId || !data.formUrl || String(data.errorCode ?? '0') !== '0') {
    report.registration = 'not confirmed'; await save(); throw new Error('Invoice registration not confirmed; no retry');
  }
  if (!/^[0-9a-f-]{36}$/i.test(data.orderId)) throw new Error('Invalid bank payment ID');
  report.registration = 'confirmed'; report.paymentId = data.orderId; report.paymentUrlReceived = true;
  await save();
  const status = await bank('getOrderStatusExtended.do', { orderId: data.orderId });
  report.bankStatus = { http: status.http, errorCode: String(status.data.errorCode ?? '0'),
    orderStatus: status.data.orderStatus, amountKopecks: status.data.amount,
    orderNumberMatches: status.data.orderNumber === report.orderId };
  await save();
  if (status.http !== 200 || report.bankStatus.errorCode !== '0' || Number(status.data.orderStatus) !== 0
      || Number(status.data.amount) !== 10000 || !report.bankStatus.orderNumberMatches)
    throw new Error('Expected registered, unpaid RUB 100 invoice');
  const response = await fetch('https://api.supabase.com/v1/projects/mgnotvaahftrbifqtahf/database/query', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.SUPABASE_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `BEGIN;
      INSERT INTO public.le_v2_payment_orders(md_order,order_number,amount,description,status)
      VALUES ('${report.paymentId}','${report.orderId}',100,'ТЕСТ — неоплаченный счёт; только личная проверка','pending');
      SELECT NOT EXISTS(SELECT 1 FROM public.payment_orders WHERE md_order='${report.paymentId}') AS legacyQueueUntouched;
      COMMIT;` }), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Isolated test queue write not confirmed');
  const rows = await response.json();
  if (rows[0]?.legacyqueueuntouched !== true) throw new Error('Legacy isolation not confirmed');
  report.isolatedQueueVerified = true;
  report.telegram = { state: 'started' }; await save();
  const message = await telegram('sendMessage', { chat_id: ids[0],
    text: `ТЕСТ нового backend Lady Elka\n\nСчёт ${report.orderId}: 100 ₽.\nАльфа-Банк подтвердил: зарегистрирован, НЕ ОПЛАЧЕН.\nСписания не было. Ничего оплачивать не нужно.\n\nЭто проверка банка и личной доставки; новый публичный checkout пока закрыт.`,
  });
  if (message.chat?.type !== 'private' || String(message.chat.id) !== ids[0] || !message.message_id)
    throw new Error('Private delivery acknowledgement missing');
  report.telegram = { state: 'confirmed', privateChat: true, recipientMatches: true, messageAcknowledged: true, messageId: message.message_id };
  report.success = true; await save();
  console.log(JSON.stringify({ success: true, orderId: report.orderId, amountRub: 100, unpaid: true,
    privateDeliveryConfirmed: true, legacyQueueUntouched: true, publicCheckoutStillClosed: true }));
} catch (error) {
  report.success = false; report.error = error.message; await save();
  console.error(error.message); process.exitCode = 1;
}
