import { readFile, writeFile, mkdir } from 'node:fs/promises';

// Reuse the reviewed checkout handler. Never hand-edit its generated sibling.
export const names = {
  le_reserve_cod_order: 'le_v2_reserve_cod_order',
  payment_orders: 'le_v2_payment_orders',
  le_orders: 'le_v2_orders',
  le_order_effects: 'le_v2_order_effects',
  le_rate_limits: 'le_v2_rate_limits',
  le_rate_limit_take: 'le_v2_rate_limit_take',
  le_recover_bank_order: 'le_v2_recover_bank_order',
};
export const migrationPath = 'supabase/migrations/20261012120000_pay_v2_isolated.sql';
export async function preparePayV2() {
  const directory = 'supabase/functions/pay-v2';
  await mkdir(directory, { recursive: true });
  let source = await readFile('supabase/functions/pay/index.ts', 'utf8');
  const requestAnchor = 'async function supabaseAdminRequest(path: string, options: RequestInit = {}): Promise<Response> {';
  const serveAnchor = 'Deno.serve(async (req: Request): Promise<Response> => {';
  if (source.split(requestAnchor).length !== 2 || source.split(serveAnchor).length !== 2)
    throw new Error('Payment source structure changed; review the generator');
  source = source.replace(requestAnchor, requestAnchor + '\n  path = isolatedStoragePath(path);');
  source = source.replace(serveAnchor, serveAnchor + `
  const gate = await preparedPaymentResponse(req, (key: string) => Deno.env.get(key), (request: Request) => authenticateWorker(request, {
    secret:Deno.env.get('LE_V2_WORKER_TOKEN'), claim:async (bucket: string) => {
      const result = await supabaseAdminRequest('rpc/le_rate_limit_take', {method:'POST',body:JSON.stringify({p_buckets:[bucket],p_limits:[1],p_windows:[300]})});
      if (!result.ok) throw new Error('Worker nonce store unavailable');
      return await result.json() === 0;
    }
  }));
  if (gate) return gate;
`);
  const headerAnchor = 'const headersObj:';
  const headerStart = source.indexOf(headerAnchor, source.indexOf(serveAnchor));
  if (headerStart < 0) throw new Error('Request wrapper changed');
  const eventStart = source.indexOf('  const event =', headerStart);
  if (eventStart < 0) throw new Error('Request event changed');
  source = source.slice(0,eventStart) + `
  // Private routes reached this point only after HMAC + one-use nonce verification.
  const workerAction = new URL(req.url).searchParams.get('action');
  if (workerAction === 'poll-payments') headersObj['x-poll-token'] = Deno.env.get('LE_V2_WORKER_TOKEN') || '';
  if (workerAction === 'retry-cod-delivery') headersObj['x-cod-retry-token'] = Deno.env.get('LE_V2_WORKER_TOKEN') || '';
` + source.slice(eventStart);
  const envAnchor = "typeof key === 'string' ? Deno.env.get(key) : undefined";
  if (!source.includes(envAnchor)) throw new Error('Payment env shim changed');
  source = source.replace(envAnchor, "typeof key === 'string' ? Deno.env.get(({ ALFA_CALLBACK_TOKEN: 'LE_V2_WORKER_TOKEN', COD_DELIVERY_RETRY_TOKEN: 'LE_V2_WORKER_TOKEN', HOOK_SECRET: 'LE_V2_HOOK_SECRET', NEW_ORDER_ADMISSION: 'LE_V2_NEW_ORDER_ADMISSION', CORS_ORIGIN: 'LE_V2_CORS_ORIGIN' } as Record<string,string>)[key] || key) : undefined");
  const routerAnchor = "      if (action === 'create-cod-order') {";
  source = source.replace(routerAnchor, `      if (action === 'order-status' || action === 'check-payment' || action === 'check') return await v2Operations.status(data, headers, client);
      if (action === 'qa-create') {
        // Only the URL action passed the signed admission gate; body.action cannot authorize QA.
        if (qs.action !== 'qa-create') return resp(403, {message:'QA requires server authorization'}, headers);
        try { await qaPolicy.validatePayload(data); }
        catch { return resp(400, {message:'QA payload is not server approved'}, headers); }
        return await routePay(data, headers, client, true);
      }
      if (qaPolicy.applies(data)) return resp(403, {message:'QA requires server authorization'}, headers);
` + routerAnchor);
  const pollStart = source.indexOf('async function routePollPayments(');
  const pollEnd = source.indexOf('\nconst orderStore =', pollStart);
  if (pollStart < 0 || pollEnd < 0) throw new Error('Payment polling structure changed');
  source = source.slice(0, pollStart) + `async function routePollPayments(event: PaymentEvent, headers: HeaderValues): Promise<HttpResponse> {
    const expected = process.env.ALFA_CALLBACK_TOKEN || '';
    if (expected.length < 32 || event.headers?.['x-poll-token'] !== expected) return resp(401, {ok:false}, headers);
    return v2Operations.poll(headers);
  }
  ` + source.slice(pollEnd);
  const storeAnchor = 'const orderStore = createOrderStore(supabaseAdminRequest) as OrderStore;';
  source = source.replace(storeAnchor, storeAnchor + `
const v2Operations = createV2Operations({ store: orderStore, request: supabaseAdminRequest, getBank: getAlfaOrderStatus,
  validateRow: qaPolicy.validateRow, validateBank: qaPolicy.validateBank,
  evidence: alfaPaymentEvidence, response: resp, admit: admitRequest,
  notifyPaid: (row: any, bank: any, headers: any) => notifyAlfaPayment(normPaymentPayload({
    paid:true, status:'paid', invoice_id:row.payment_id, orderId:row.order_id, amount:Number(row.total),
    description:stringOf(recordOf(row.payload).description) }), headers) });
`);
  // Keep the existing Telegram webhook. Its message-only status controls remain compatible for card orders; COD never exposes a bank link.
  source = source.replace("'card', false, stored.notification_chat_ids", "'card', true, stored.notification_chat_ids");
  const replaceQa = (anchor, replacement) => {
    if (source.split(anchor).length !== 2) throw new Error('QA generator anchor changed: ' + anchor.slice(0, 80));
    source = source.replace(anchor, replacement);
  };
  replaceQa('async function routePay(data: JsonRecord, headers: HeaderValues, client: RequestClient = UNKNOWN_CLIENT): Promise<HttpResponse>{',
    'async function routePay(data: JsonRecord, headers: HeaderValues, client: RequestClient = UNKNOWN_CLIENT, qaAuthorized = false): Promise<HttpResponse>{');
  replaceQa("  if (data.paymentMethod !== 'card') return resp(400, { message: 'Выберите оплату картой' }, headers);", `  const qa = qaPolicy.applies(data);
  if (qa && !qaAuthorized) return resp(403, {message:'QA requires server authorization'}, headers);
  if (qaAuthorized) await qaPolicy.validatePayload(data);
  if (data.paymentMethod !== 'card') return resp(400, { message: 'Выберите оплату картой' }, headers);`);
  replaceQa('    const previous = await orderStore.existing(orderId, data);',
    '    const previous = await orderStore.existing(orderId, data);\n    if (qa && previous) await qaPolicy.validateRow(previous);');
  replaceQa("      validated = await routeCodOrder({ ...data, paymentMethod: 'card' }, headers, true);",
    "      validated = qa ? {notification:qaPolicy.notification} : await routeCodOrder({ ...data, paymentMethod: 'card' }, headers, true);");
  replaceQa('    let recipients = previous?.notification_chat_ids || configuredRecipients();',
    '    let recipients = qa ? await qaPolicy.selectRecipients(previous, configuredRecipients()) : previous?.notification_chat_ids || configuredRecipients();');
  replaceQa('    if (!snapshot?.notification_chat_ids?.length) throw new Error(\'Card recipient snapshot is missing\');',
    "    if (!snapshot?.notification_chat_ids?.length) throw new Error('Card recipient snapshot is missing');\n    if (qa) await qaPolicy.validateRow(snapshot);");
  replaceQa('        amount: String(amountKopecks),', '        amount: String(amountKopecks),\n        ...(qa ? {currency: \'643\', sessionTimeoutSecs: String(qaPolicy.sessionTimeoutSecs)} : {}),');
  replaceQa('  const stored = await orderStore.payment(p.invoice_id);',
    '  const stored = await orderStore.payment(p.invoice_id);\n  if (stored) await qaPolicy.validateRow(stored);');
  replaceQa("'card', true, stored.notification_chat_ids, p.phone || orderPhone(stored?.payload));",
    "'card', true, stored.notification_chat_ids, p.phone || orderPhone(stored?.payload), qaPolicy.isOrder(stored.order_id));");
  replaceQa("automatic = false, recipients?: string[], phone = ''): Promise<void> {",
    "automatic = false, recipients?: string[], phone = '', privateQA = false): Promise<void> {");
  replaceQa("  const replyMarkup = paymentMethod === 'cash_on_delivery'", "  const replyMarkup = privateQA ? {inline_keyboard:[]} : paymentMethod === 'cash_on_delivery'");
  replaceQa("  const sendAsPhoto = Boolean(photoUrl) && String(text).length <= 1024;",
    "  if (privateQA) await qaPolicy.validateRecipients(ids);\n  const sendAsPhoto = Boolean(photoUrl) && String(text).length <= 1024;");
  const policyAnchor = "paymentMethod === 'cash_on_delivery' ? { automatic, maxAttempts: 5, backoffSeconds: 60 } : {}";
  if (!source.includes(policyAnchor)) throw new Error('Notification retry policy changed');
  source = source.replace(policyAnchor, "{ automatic, maxAttempts: 5, backoffSeconds: 60 }");
  // orderControls in pay/index.ts is shared: Alfa link for card orders, customer messenger buttons when a phone is known.
  source = source.replace("const origins = ['https://lady-elka.ru'", "const origins = ['https://arturablyazov5-glitch-lady-elka-cloud-preview-3626.twc1.net', 'https://lady-elka.ru'");
  source = '// GENERATED by scripts/prepare-pay-v2.mjs from pay/index.ts; do not hand-edit.\n'
    + "import { isolatedStoragePath, preparedPaymentResponse } from './isolation.mjs';\nimport { createV2Operations } from './operations.mjs';\nimport { authenticateWorker } from './worker-auth.mjs';\nimport { qaPolicy } from './qa-policy.mjs';\n" + source;
  await writeFile(directory + '/index.ts', source);
  const sources = ['20261001120000_order_idempotency.sql', '20261001130000_cod_delivery_retry.sql', '20261008160000_order_rate_limits.sql'];
  const queue = `create table public.le_v2_payment_orders (
    md_order text primary key, order_number text not null, amount numeric(12,2) not null,
    description text not null default '', status text not null default 'pending',
    created_at timestamptz not null default now(), last_checked_at timestamptz,
    notified_at timestamptz, last_error text
  );
  alter table public.le_v2_payment_orders enable row level security;
  revoke all on public.le_v2_payment_orders from public, anon, authenticated;
  grant select, insert, update on public.le_v2_payment_orders to service_role;`;
  const fragments = await Promise.all(sources.map(file => readFile('supabase/migrations/' + file, 'utf8')));
  let sql = fragments.join('\n').replace(/^begin;\s*$/gmi, '').replace(/^commit;\s*$/gmi, '')
    .replace(/^notify pgrst, 'reload schema';\s*$/gmi, '');
  // One replacement pass prevents substituting a prefix twice.
  sql = sql.replace(/payment_orders|le_order_effects|le_recover_bank_order|le_rate_limit_take|le_rate_limits|le_orders/g, name => names[name]);
  sql = '-- GENERATED by scripts/prepare-pay-v2.mjs. Additive isolated namespace; no legacy queue or cron changes.\n'
    + 'begin;\n' + queue + '\n' + sql + "\ncommit;\nnotify pgrst, 'reload schema';\n";
  await writeFile(migrationPath, sql);
  return { directory, migrationPath };
}
if (process.argv[1]?.endsWith('/prepare-pay-v2.mjs')) {
  console.log(await preparePayV2());
}
