// Lady Elka owns one store subscription. Never reuse Genvito account tables.
export const FEATURES = ['orders', 'analytics', 'advanced-promos'];
export const PLANS={'1 месяц':{amount:299,months:1},'3 месяца':{amount:799,months:3},'6 месяцев':{amount:1490,months:6},'1 год':{amount:2790,months:12}};
export function nextMonth(value,months=1) {
 const d=new Date(value), day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
 const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString();
}
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function createBilling({read,update,env,fetcher=fetch,now=()=>Date.now()}) {
 const shop=env('YOOKASSA_SHOP_ID'),secret=env('YOOKASSA_SECRET_KEY');
 const amount=PLANS['1 месяц'].amount;
 const configured=Boolean(shop&&secret&&Number.isFinite(amount)&&amount>=1);
 const testMode=Boolean(secret?.startsWith('test_'));
 const active=s=>Boolean(s?.end&&new Date(s.end).getTime()>now());
 async function provider(path,payload,key) {
  if(!configured)fail('Оплата пока не настроена',503);
  const r=await fetcher(`https://api.yookassa.ru/v3${path}`,{method:payload?'POST':'GET',headers:{Authorization:`Basic ${btoa(`${shop}:${secret}`)}`,'Content-Type':'application/json',...(key?{'Idempotence-Key':key}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(20000)});
  const p=await r.json().catch(()=>({}));if(!r.ok)fail('ЮKassa не приняла запрос. Повторите проверку позже.',502);return p;
 }
 function view(s){const sub=s.subscription||{};return {plan:sub.plan||'Lady Elka PRO',plans:PLANS,amount:PLANS[sub.plan]?.amount||amount,configured,testMode,features:FEATURES,active:active(sub),end:sub.end||null,autoRenew:Boolean(sub.autoRenew),email:sub.email||'',card:sub.method?{last4:sub.last4||'',brand:sub.brand||''}:null,history:(s.payments||[]).filter(p=>p.status).map(p=>({id:p.id,status:p.status,amount:p.amount,createdAt:p.createdAt,test:p.test,plan:p.plan,trial:p.trial})).reverse()};}
 async function reconcile(intent) {
  if(!intent.id)return intent;
  const p=await provider(`/payments/${encodeURIComponent(intent.id)}`);
  if(p.id!==intent.id||p.metadata?.product!=='lady-elka-pro'||p.metadata?.intent!==intent.key||p.recipient?.account_id!==shop||p.amount?.currency!=='RUB'||Number(p.amount.value)!==intent.amount||Boolean(p.test)!==testMode)fail('Платёж не соответствует подписке Lady Elka',409);
  await update(s=>{
   const stored=s.payments.find(x=>x.key===intent.key);if(!stored)fail('Платёж не найден',404);
   stored.status=p.status;stored.test=Boolean(p.test);
   if(p.status==='succeeded'&&p.paid===true&&!stored.applied){
    const old=s.subscription||{},canSave=p.payment_method?.saved===true&&p.payment_method?.type==='bank_card';
    s.subscription={...old,email:stored.email,plan:stored.plan||'1 месяц',end:nextMonth(Math.max(now(),Date.parse(old.end)||0),stored.months||1)};
    if(!stored.renewal){s.subscription.autoRenew=Boolean(stored.autoRenew&&canSave);s.subscription.method=canSave?p.payment_method.id:null;s.subscription.shop=canSave?shop:null;s.subscription.last4=p.payment_method?.card?.last4||'';s.subscription.brand=p.payment_method?.card?.card_type||'';}
    stored.applied=true;
   }
   if(p.status==='canceled'&&stored.renewal)s.subscription.autoRenew=false;
  });return p;
 }
 async function submit(intent){
  if(intent.id)return reconcile(intent);
  // YooKassa keeps idempotency keys for 24 hours. Never retry an ambiguous older request.
  if(now()-Date.parse(intent.createdAt)>23*3600000)fail('Платёж требует сверки с ЮKassa. Новое списание остановлено.',409);
  const payload={amount:{value:intent.amount.toFixed(2),currency:'RUB'},capture:true,description:'Lady Elka PRO — '+(intent.plan||'1 месяц'),metadata:{product:'lady-elka-pro',intent:intent.key},...(intent.renewal?{payment_method_id:intent.method}:{payment_method_data:{type:intent.method==='card'?'bank_card':'sbp'},save_payment_method:intent.method==='card'&&intent.autoRenew,confirmation:{type:'redirect',return_url:env('LE_PAYMENT_RETURN_URL')||'http://localhost:4180/#payment'}})};
  const p=await provider('/payments',payload,intent.key);
  if(!p.id)fail('ЮKassa не вернула номер платежа',502);
  await update(s=>{const row=s.payments.find(x=>x.key===intent.key);row.id=p.id;row.url=p.confirmation?.confirmation_url||null;});
  return reconcile({...intent,id:p.id});
 }
 async function refresh(){const s=await read();for(const p of s.payments||[])if(!['succeeded','canceled'].includes(p.status))await submit(p);return view(await read());}
 return {
  async handle(action,method,b={}) {
   if(['status','config','history'].includes(action)&&method==='GET')return view(await read());
   if(action==='refresh'&&method==='POST')return refresh();
   if(action==='checkout'&&method==='POST'){
    if(!configured)fail('Укажите стоимость подписки в серверных настройках',503);
    const email=(await read()).subscription?.email||'';
    if(!['card','sbp'].includes(b.method)||(testMode&&b.method==='sbp'))fail('Выберите доступный способ оплаты');
    const plan=b.plan||'1 месяц',tariff=PLANS[plan];if(!tariff)fail('Выберите тариф');
    let key;
    await update(s=>{s.payments||=[];const pending=s.payments.find(p=>!['succeeded','canceled'].includes(p.status));if(pending){key=pending.key;return;}if(active(s.subscription))fail('Подписка уже действует. Следующая оплата — после окончания периода.',409);key=crypto.randomUUID();s.payments.push({key,plan,months:tariff.months,amount:tariff.amount,email,method:b.method,autoRenew:b.method==='card',createdAt:new Date(now()).toISOString()});});
    await submit((await read()).payments.find(p=>p.key===key));
    const s=await read(),p=s.payments.find(p=>p.key===key);return {...view(s),paymentUrl:p.status==='pending'?p.url:null,paymentStatus:p.status};
   }
   if(action==='auto-renew'&&method==='POST'){
    if(typeof b.enabled!=='boolean')fail('Неверное значение автопродления');
    await update(s=>{const sub=s.subscription;if(!sub)fail('Подписка не найдена',404);if(b.enabled&&(!active(sub)||!sub.method||sub.shop!==shop))fail('Для автопродления нужна действующая подписка с сохранённой картой');sub.autoRenew=b.enabled;});return view(await read());
   }
   if(action==='detach'&&method==='POST') {await update(s=>{if(s.subscription){s.subscription.autoRenew=false;s.subscription.method=null;s.subscription.shop=null;s.subscription.last4='';s.subscription.brand='';}});return view(await read());}
   fail('Не найдено',404);
  },
  async webhook(id){if(!/^[\w-]{1,80}$/.test(id||''))fail('Неверный платёж');const p=(await read()).payments?.find(p=>p.id===id);if(p)await reconcile(p);return {ok:true};},
  async renew(){await refresh();let key;await update(s=>{const sub=s.subscription;if(!sub?.autoRenew||!sub.method||sub.shop!==shop||active(sub)||s.payments?.some(p=>!['succeeded','canceled'].includes(p.status)))return;key=crypto.randomUUID();const plan=sub.plan==='3 дня'?'1 месяц':sub.plan||'1 месяц';s.payments.push({key,plan,months:PLANS[plan].months,amount:PLANS[plan].amount,email:sub.email,method:sub.method,autoRenew:true,renewal:true,createdAt:new Date(now()).toISOString()});});if(key)await submit((await read()).payments.find(p=>p.key===key));return {ok:true,attempted:Boolean(key)};},
  async requireFeature(feature){if(!FEATURES.includes(feature)||!active((await read()).subscription))fail('Нужна подписка Lady Elka PRO',402);}
 };
}
