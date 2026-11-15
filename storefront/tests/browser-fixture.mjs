import { configScript } from '../config/runtime.mjs';
// Local browser fixture only. Never included in the storefront build or deployed.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { build } from 'esbuild';
import { orderDatabase } from './helpers/order-db.mjs';
import { assessAlfaRecovery } from '../../supabase/functions/_shared/alfa-recovery.mjs';

const root = resolve(import.meta.dirname, '../dist');
const port = Number(process.env.LE_BROWSER_TEST_PORT || 4176);
const origin = `http://127.0.0.1:${port}`;
const database = await orderDatabase();
const html = await readFile(resolve(root, 'tree/miranda/index.html'), 'utf8');
const productMatch = html.match(/<script[^>]*data-storefront-page-product[^>]*>([\s\S]*?)<\/script>/);
if (!productMatch) throw new Error('Generated product data is missing. Finish npm run build:storefront before starting the fixture.');
const product = JSON.parse(productMatch[1]);
const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;
const trees = 'id,title,active,category,height_cm,price\n' + product.variants.map(v =>
  [product.id, product.title, '1', v.category, v.height, v.price].map(csvCell).join(',')).join('\n') + '\n';
const feeds = { 'trees.csv': trees, 'decor.csv': 'id,title,active,category,variants,price\n',
  'promos.csv': 'promocode,ruble-offer,percent-offer,gift-offer\nCODE,1000,0,\n' };
const env = { TG_BOT_TOKEN: 'fixture-token', TG_CHAT_IDS: 'first-chat,second-chat',
  CORS_ORIGIN: origin, SUPABASE_URL: 'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture-key',
  ALFA_API_USER: 'fixture-user', ALFA_API_PASS: 'fixture-pass', ALFA_CALLBACK_TOKEN: 'fixture-poll',
  COD_DELIVERY_RETRY_TOKEN: 'fixture-cod-token-at-least-32-characters' };
let handler;
globalThis.Deno = { env: { get: key => env[key] }, serve: callback => { handler = callback; }, createHttpClient: () => ({}) };
const compiled = await build({ entryPoints: [resolve(import.meta.dirname, '../../supabase/functions/pay/index.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false });
await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const config = { telegram: 'success', bank: 'success', delay: 0, storageDown: false };
const telegram = [], payments = new Map(), requests = [], blocked = [];
// No real fetch is retained: every provider call must match an explicit mock.
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.startsWith(`${env.SUPABASE_URL}/rest/v1/`)) {
    if (config.storageDown) return new Response('{}', { status: 503 });
    return database.request(url.split('/rest/v1/')[1], options);
  }
  const feed = url.split('/').at(-1);
  if (url.includes('/le-catalog-feeds/') && feeds[feed]) return new Response(feeds[feed]);
  if (url.startsWith('https://api.telegram.org/botfixture-token/')) {
    const body = JSON.parse(options.body); telegram.push(body);
    if (config.telegram === 'unknown') throw new Error('Fixture: Telegram acknowledgement lost');
    const reject = config.telegram === 'reject' || config.telegram === 'partial' && body.chat_id === 'second-chat';
    return Response.json(reject ? { ok: false, description: 'Fixture explicit rejection' }
      : { ok: true, result: { message_id: telegram.length } }, { status: reject ? 400 : 200 });
  }
  if (url.endsWith('/register.do')) {
    const params = new URLSearchParams(options.body);
    const paymentId = `fixture-payment-${payments.size + 1}`;
    const payment = { orderNumber: params.get('orderNumber'), amount: Number(params.get('amount')),
      orderStatus: 0, paymentId, orderDescription: params.get('description') };
    payments.set(paymentId, payment);
    if (config.bank === 'unknown') throw new Error('Fixture: bank acknowledgement lost');
    if (config.bank === 'reject') { payments.delete(paymentId); return Response.json({ errorCode: '7', errorMessage: 'Fixture bank rejection' }); }
    return Response.json({ orderId: paymentId, formUrl: `${origin}/__test/payment?id=${paymentId}` });
  }
  if (url.endsWith('/getOrderStatusExtended.do')) {
    const params = new URLSearchParams(options.body);
    const payment = payments.get(params.get('orderId')) || [...payments.values()].find(p => p.orderNumber === params.get('orderNumber'));
    return Response.json(payment || { errorCode: '6' });
  }
  blocked.push(url); throw new Error(`Unexpected provider request blocked: ${url}`);
};

const guard = `(() => {
  window.__LE_LOCAL_CHECKOUT__ = { endpoint: location.origin + '/functions/v1/pay', blocked: [] };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    let url = new URL(input instanceof Request ? input.url : input, location.href);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.hostname === 'mgnotvaahftrbifqtahf.supabase.co') {
      if (url.pathname === '/functions/v1/pay') url = new URL('/functions/v1/pay' + url.search, location.origin);
      else if (url.pathname.includes('/le-catalog-feeds/')) url = new URL('/__test/feeds/' + url.pathname.split('/').pop(), location.origin);
    }
    if (url.origin !== location.origin || !['GET','HEAD'].includes(method) && !['/functions/v1/pay','/__test/control'].includes(url.pathname)) {
      window.__LE_LOCAL_CHECKOUT__.blocked.push({url:url.href,method});
      return Promise.reject(new Error('Unexpected browser request blocked by local fixture'));
    }
    return nativeFetch(url.href, init);
  };
  navigator.sendBeacon = () => false;
})();`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.mp4': 'video/mp4' };
async function invoke(action, body = {}, headers = {}) {
  const response = await handler(new Request(`${origin}/functions/v1/pay?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
async function control(body) {
  if (body.op === 'configure') { Object.assign(config, body.config); return { ...config }; }
  if (body.op === 'reset') {
    await database.db.exec('delete from le_order_effects; delete from payment_orders; delete from le_orders;');
    telegram.length = 0; requests.length = 0; blocked.length = 0; payments.clear();
    Object.assign(config, { telegram: 'success', bank: 'success', delay: 0, storageDown: false }); return { ok: true };
  }
  if (body.op === 'due') { await database.db.exec("update le_order_effects set next_attempt_at=now()-interval '1 minute' where state='failed'"); return { ok: true }; }
  if (body.op === 'retry') return invoke('retry-cod-delivery', {}, { 'X-Cod-Retry-Token': env.COD_DELIVERY_RETRY_TOKEN });
  const payment = payments.get(body.paymentId) || [...payments.values()].at(-1);
  if (!payment) throw new Error('No fixture payment');
  if (body.op === 'hook') { payment.orderStatus = 2; return invoke('hook', { mdOrder: payment.paymentId, operation: 'deposited', status: '1' }); }
  if (body.op === 'poll') { payment.orderStatus = 2; return invoke('poll-payments', {}, { 'X-Poll-Token': env.ALFA_CALLBACK_TOKEN }); }
  if (body.op === 'recoverPaid') {
    payment.orderStatus = 2;
    const plan = assessAlfaRecovery({ orderId: payment.orderNumber, expectedTotal: payment.amount / 100,
      statusResponse: payment, historyRows: [{ ...payment, attributes: [{ name: 'mdOrder', value: payment.paymentId }] }], apiHost: 'payment.alfabank.ru' });
    if (!plan.ready || !plan.paid) throw new Error('Fixture recovery evidence rejected');
    const response = await database.request('rpc/le_recover_bank_order', { method: 'POST', body: JSON.stringify({
      p_order_id: payment.orderNumber, p_payment_id: plan.paymentId, p_bank_status: 2,
      p_bank_amount_kopecks: plan.amountKopecks, p_payment_url: '', p_description: payment.orderDescription }) });
    return response.json();
  }
  throw new Error('Unknown fixture control');
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; object-src 'none'");
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('Fixture request too large'); }
    if (url.pathname === '/functions/v1/pay') {
      const payload = body ? JSON.parse(body) : {};
      const recorded = { action: url.searchParams.get('action') || 'pay', payload };
      requests.push(recorded);
      if (config.delay) await new Promise(resolve => setTimeout(resolve, config.delay));
      const response = await handler(new Request(url.href, { method: req.method, headers: req.headers, body: body || undefined }));
      const responseBody = await response.text();
      recorded.status = response.status;
      try { recorded.result = JSON.parse(responseBody); } catch {}
      res.writeHead(response.status, Object.fromEntries(response.headers)); return res.end(responseBody);
    }
    if (url.pathname === '/__test/control' && req.method === 'POST') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await control(JSON.parse(body)))); }
    if (url.pathname === '/__test/state') {
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ config, requests, telegram, payments: [...payments.values()], blocked,
        orders: (await database.db.query('select order_id,status,total,telegram_sent,result,notification_chat_ids from le_orders order by created_at')).rows,
        effects: (await database.db.query('select effect_key,state,attempt_count,next_attempt_at from le_order_effects order by effect_key')).rows }));
    }
    if (url.pathname === '/f/storefront-config.js') { res.setHeader('Content-Type', mime['.js']); return res.end(configScript('fixture')); }
    if (url.pathname === '/__test/guard.js') { res.setHeader('Content-Type', mime['.js']); return res.end(guard); }
    if (url.pathname.startsWith('/__test/feeds/')) { res.setHeader('Content-Type', 'text/csv'); return res.end(feeds[url.pathname.split('/').at(-1)] || ''); }
    if (url.pathname === '/__test/payment') { res.setHeader('Content-Type', mime['.html']); return res.end('<h1>Локальная имитация оплаты</h1><a href="/tree/miranda">Вернуться к заказу</a>'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    for (const candidate of extname(relative) ? [relative] : [`${relative}/index.html`, `${relative}.html`]) {
      const file = resolve(root, candidate);
      if (!file.startsWith(root + sep)) continue;
      try {
        if (!(await stat(file)).isFile()) continue;
        let data = await readFile(file);
        if (extname(file) === '.html') data = Buffer.from(data.toString().replaceAll('/local-guard.js', '/__test/guard.js'));
        res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); return res.end(data);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    res.writeHead(404); res.end('Not found');
  } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: error.message })); }
});
server.listen(port, '127.0.0.1', () => console.log(`Isolated checkout fixture: ${origin}/tree/miranda`));
process.on('SIGINT', () => { server.close(); database.db.close().then(() => process.exit()); });
