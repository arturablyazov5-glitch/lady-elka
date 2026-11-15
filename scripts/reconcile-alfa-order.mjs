import {
  alfaRecoveryWindow,
  assessAlfaRecovery,
  extractAlfaOrders
} from '../supabase/functions/_shared/alfa-recovery.mjs';

const [orderId, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const confirmedOrderId = flags.find(flag => flag.startsWith('--confirm-order-id='))?.split('=').slice(1).join('=');

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function firstRecord(value) {
  return Array.isArray(value) && value.length && typeof value[0] === 'object' ? value[0] : null;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function usage() {
  console.log('Usage: node scripts/reconcile-alfa-order.mjs <order-id> [--apply --confirm-order-id=<same-order-id>]');
  console.log('Read-only bank/database checks are the default. Applying a verified recovery requires both flags.');
}

if (!orderId || !/^LE-\d{10,}-[\w-]{0,32}$/.test(orderId)) {
  usage();
  process.exit(1);
}
if (apply && confirmedOrderId !== orderId) {
  usage();
  process.exit(1);
}

async function readJson(response, source) {
  let value;
  try { value = await response.json(); }
  catch { throw new Error(`${source} returned invalid JSON`); }
  if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);
  return value;
}

const supabaseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '');
const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const alfaBase = (process.env.ALFA_API_BASE || 'https://payment.alfabank.ru/payment/rest').replace(/\/$/, '');
const alfaUser = requiredEnv('ALFA_API_USER');
const alfaPass = requiredEnv('ALFA_API_PASS');
const alfaHost = new URL(alfaBase).hostname;
const timeZone = process.env.ALFA_API_TIME_ZONE || 'Europe/Moscow';

async function adminRequest(path, options = {}) {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function alfaPost(method, params) {
  const response = await fetch(`${alfaBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ userName: alfaUser, password: alfaPass, language: 'ru', ...params })
  });
  return record(await readJson(response, `Alfa ${method}`));
}

async function paymentHistory(order) {
  const createdAt = new Date(order.created_at);
  const { from, to } = alfaRecoveryWindow(createdAt, timeZone);
  const size = 200;
  const common = {
    size: String(size), from, to,
    transactionStates: 'CREATED,APPROVED,DEPOSITED,DECLINED,REVERSED,REFUNDED',
    merchants: process.env.ALFA_MERCHANTS || '',
    searchByCreatedDate: 'true'
  };
  let totalCount = null;
  const rows = [];
  for (let page = 0; page < 20; page += 1) {
    const response = await alfaPost('getLastOrdersForMerchants.do', { ...common, page: String(page) });
    const errorCode = String(response.errorCode ?? '0');
    if (errorCode !== '' && errorCode !== '0') throw new Error(`Alfa history lookup failed with code ${errorCode}`);
    rows.push(...extractAlfaOrders(response));
    totalCount = Number(response.totalCount ?? rows.length);
    if (!Number.isFinite(totalCount) || totalCount <= rows.length) return rows;
  }
  if (totalCount > rows.length) throw new Error('Alfa history result is too large; narrow the recovery window manually');
  return rows;
}

async function main() {
  const orderResponse = await adminRequest(`le_orders?order_id=eq.${encodeURIComponent(orderId)}&select=order_id,payment_method,status,total,payload,payment_id,result,created_at`);
  const order = firstRecord(await readJson(orderResponse, 'Supabase order read'));
  if (!order) throw new Error('Order was not found in le_orders');
  if (order.payment_method !== 'card') throw new Error('Only card payments are eligible for bank recovery');

  const effectResponse = await adminRequest(`le_order_effects?effect_key=eq.${encodeURIComponent(`bank:${orderId}`)}&select=effect_key,state,result,last_error`);
  const effect = firstRecord(await readJson(effectResponse, 'Supabase effect read'));
  if (!effect) throw new Error('Bank registration effect was not found');
  if (effect.state !== 'unknown') {
    console.log(JSON.stringify({ orderId, effectState: effect.state, action: 'no_change' }, null, 2));
    if (effect.state === 'running') process.exitCode = 2;
    return;
  }

  const [bankStatus, bankHistory] = await Promise.all([
    alfaPost('getOrderStatusExtended.do', { orderNumber: orderId }),
    paymentHistory(order)
  ]);
  const plan = assessAlfaRecovery({
    orderId,
    expectedTotal: Number(order.total),
    statusResponse: bankStatus,
    historyRows: bankHistory,
    apiHost: alfaHost,
    paymentUrlTemplate: process.env.ALFA_PAYMENT_FORM_URL_TEMPLATE || ''
  });
  const summary = {
    orderId,
    effectState: effect.state,
    recoveryReady: plan.ready,
    reason: plan.reason,
    paymentId: plan.paymentId,
    bankStatus: plan.bankStatus,
    amountKopecks: plan.amountKopecks,
    paid: plan.paid,
    paymentUrlAvailable: Boolean(plan.paymentUrl),
    writeMode: apply ? 'apply' : 'read_only'
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!plan.ready) {
    if (apply) throw new Error('Bank evidence is not sufficient for recovery; no write was sent');
    return;
  }
  if (!apply) return;

  const payload = record(order.payload);
  const description = String(payload.description || bankStatus.orderDescription || 'Оплата заказа');
  const rpcResponse = await adminRequest('rpc/le_recover_bank_order', {
    method: 'POST',
    body: JSON.stringify({
      p_order_id: orderId,
      p_payment_id: plan.paymentId,
      p_bank_status: plan.bankStatus,
      p_bank_amount_kopecks: plan.amountKopecks,
      p_payment_url: plan.paymentUrl,
      p_description: description.slice(0, 512)
    })
  });
  await readJson(rpcResponse, 'Supabase recovery transaction');
  console.log(JSON.stringify({ orderId, paymentId: plan.paymentId, applied: true,
    paid: plan.paid, queue: 'payment_orders updated atomically' }, null, 2));
}

main().catch(error => {
  console.error(`Recovery stopped: ${error.message}`);
  process.exitCode = 1;
});
