import { fileURLToPath } from 'node:url';
try {process.loadEnvFile(fileURLToPath(new URL('../../.env',import.meta.url)));} catch(e) {if(e.code!=='ENOENT') throw e;}
export const project = process.env.SUPABASE_PROJECT_REF;
const base = process.env.SUPABASE_URL || `https://${project}.supabase.co`;
export async function db(path, options={}) {
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key || !project) throw new Error('Настройте Supabase в .env');
  const res=await fetch(`${base}/rest/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(20000)});
  if(!res.ok) { const err=await res.json().catch(()=>({})); const where=`${err.message||''} ${err.details||''}`;
   const duplicate=err.code==='23505'&&(/le_promo_code/.test(where)?'Такой промокод уже есть — регистр и «ё» не различаются':'Товар с таким артикулом уже существует');
   const e=new Error(duplicate||(err.code==='23514'?'Проверьте значения промокода: скидка и срок заданы неверно':err.message || `Supabase: ${res.status}`));
   e.status=err.code==='23505'?409:err.code==='23514'?400:502; throw e; }
  const text=await res.text(); return text ? JSON.parse(text) : null;
}
export async function listProducts(){ return (await db('le_catalog_products?select=payload,revision,updated_at&order=created_at.asc,id.asc')).map(r=>({...r.payload,revision:r.revision,updated_at:r.updated_at})); }
export async function uploadPhoto(bytes,type,filename){
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 const r=await fetch(`${base}/storage/v1/object/le-catalog-images/${filename}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':type,'Cache-Control':'3600'},body:bytes,signal:AbortSignal.timeout(30000)});
 if(!r.ok) throw Object.assign(new Error('Не удалось загрузить фото в Supabase'),{status:502});
 return `${base}/storage/v1/object/public/le-catalog-images/${filename}`;
}
// PostgREST отдаёт numeric строкой — приводим к числу, чтобы проверки и экспорт работали одинаково.
export async function listPromos(){return (await db('le_promo_codes?select=id,code,comment,rub,pct,gift,active,revision,created_at,updated_at&order=created_at.desc')).map(r=>({...r,rub:Number(r.rub),pct:Number(r.pct)}));}
// Оплаченные заказы нужны только для счётчика использований; ошибка статистики не должна ломать раздел.
export async function listPaidOrders(){try{return await db('payment_orders?select=description,amount,created_at&status=eq.paid&order=created_at.desc&limit=2000');}catch{return [];}}
export async function getSettings(){const [row]=await db('le_catalog_settings?id=eq.1&select=payload,revision,updated_at');if(!row)throw new Error('Не созданы настройки каталога');return {...row.payload,revision:row.revision,updated_at:row.updated_at};}
