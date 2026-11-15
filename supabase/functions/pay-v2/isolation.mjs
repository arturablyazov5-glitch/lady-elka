const names = {
  le_reserve_cod_order: 'le_v2_reserve_cod_order',
  payment_orders: 'le_v2_payment_orders', le_orders: 'le_v2_orders',
  le_order_effects: 'le_v2_order_effects', le_rate_limits: 'le_v2_rate_limits',
  le_rate_limit_take: 'le_v2_rate_limit_take', le_recover_bank_order: 'le_v2_recover_bank_order',
};
export function isolatedStoragePath(path) {
  const match = /^(rpc\/)?([a-z_]+)(?=\?|$)/.exec(path);
  if (!match || !names[match[2]]) throw new Error('Unreviewed payment storage path');
  return (match[1] || '') + names[match[2]] + path.slice(match[0].length);
}
// Admission and worker authorization are V2-only secrets; shared legacy secrets cannot open it.
/**
 * @param {Request} request
 * @param {(key: string) => string | undefined} env
 * @param {(request: Request) => Promise<number>} authorizeWorker
 */
export async function preparedPaymentResponse(request, env = () => undefined, authorizeWorker = async () => 401) {
  const origin = request.headers.get('origin') || '';
  const preview = 'https://arturablyazov5-glitch-lady-elka-cloud-preview-3626.twc1.net';
  const allowed = ['https://lady-elka.ru', 'https://www.lady-elka.ru', preview];
  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Expose-Headers': 'Retry-After',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  if (origin && !allowed.includes(origin)) return Response.json({ error: 'Origin not allowed' }, { status: 403, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const action = new URL(request.url).searchParams.get('action') || '';
  const enabled = env('LE_V2_ADMISSION') === 'enabled' && (env('LE_V2_WORKER_TOKEN') || '').length >= 32;
  if (request.method === 'GET' && action === 'readiness')
    return Response.json({service:'pay-v2',state:enabled?'active':'prepared',admission:enabled?'open':'closed',confirmation:'alfa-api-poll'}, {headers});
  if (!enabled) return Response.json({ ok:false, message:'Новый приём заказов ещё не включён. Свяжитесь с нами для оформления.' },
    {status:503,headers:{...headers,'Retry-After':'600'}});
  if (request.method !== 'POST') return Response.json({error:'Method Not Allowed'}, {status:405,headers});
  if (!['', 'pay', 'qa-create', 'create-cod-order', 'order-status', 'check-payment', 'check', 'poll-payments', 'retry-cod-delivery'].includes(action))
    return Response.json({error:'Not Found'}, {status:404,headers});
  if (['poll-payments','retry-cod-delivery','qa-create'].includes(action)) {
    const code = await authorizeWorker(request);
    if (code) return Response.json({ok:false,error:'Worker authorization failed'}, {status:code,headers});
  }
  return null;
}
