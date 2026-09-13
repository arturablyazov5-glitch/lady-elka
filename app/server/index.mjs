import {pricedProduct,validateSettings,resolveType} from '../public/js/pricing.js';
import {compressPhoto} from './photos.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {db,listProducts,uploadPhoto,getSettings,listPromos,listPaidOrders} from './db.mjs';
import {validateProduct,exportCSV} from './catalog.mjs';
import {exportPromoCSV,promoUsage} from './promos.mjs';
import {validatePromo,normalizeCode} from '../public/js/promo-model.js';
const port=Number(process.env.PORT || 4180), host=process.env.HOST || '127.0.0.1';
const password=process.env.CATALOG_ADMIN_PASSWORD;
if(!['127.0.0.1','localhost','::1'].includes(host) && !password) throw new Error('Для сетевого доступа задайте CATALOG_ADMIN_PASSWORD');
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const sessions=new Map(), attempts=new Map();
// Протухшие сессии и окна попыток входа никто не удаляет сам — подметаем раз в 15 минут, чтобы карты не росли без границ.
setInterval(()=>{
 const now=Date.now();
 for(const [token,expires] of sessions) if(expires<=now) sessions.delete(token);
 for(const [ip,a] of attempts) if(a.until<=now) attempts.delete(ip);
},15*60*1000).unref();
const same=(a,b)=>{const x=Buffer.from(a || ''),y=Buffer.from(b || '');return x.length===y.length && timingSafeEqual(x,y);};
function send(res,status,data,type='application/json; charset=utf-8',headers={}) {res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(typeof data==='string'?data:JSON.stringify(data));}
async function body(req,limit=2e6){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>limit) throw Object.assign(new Error('Слишком большой запрос'),{status:413});}try{return JSON.parse(raw);}catch{throw Object.assign(new Error('Некорректный JSON'),{status:400});}}
const promoRow=r=>({...r,rub:Number(r.rub),pct:Number(r.pct)});
function prepareProduct(input,settings){
 if(!input||!Array.isArray(input.variants))throw new Error('Некорректная карточка товара');
 for(const v of input.variants){
  if(!Number.isFinite(v.base_price)||v.base_price<=0||v.base_price>1e8)throw new Error('Укажите базовую цену больше нуля');
  if(input.kind==='trees'&&!settings.types.some(t=>t.id===v.type_id))throw new Error('Выберите тип из настроек');
 }
 return validateProduct(pricedProduct(input,settings));
}
const server=http.createServer(async(req,res)=>{
 try {
  const expectedHost=process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).host : null;
  if(![`localhost:${port}`,`127.0.0.1:${port}`,`[::1]:${port}`,expectedHost].filter(Boolean).includes(req.headers.host)) return send(res,403,{error:'Неизвестный адрес сервера'});
  const url=new URL(req.url,`http://${req.headers.host}`), route=url.pathname;
  if(route.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(req.method)){
   const origin=req.headers.origin;
   const allowed=process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
   if((origin && origin!==allowed) || req.headers['x-catalog-request']!=='1' || (req.method!=='DELETE' && !req.headers['content-type']?.startsWith('application/json'))) return send(res,403,{error:'Недопустимый источник запроса'});
  }
  if(route==='/api/login' && req.method==='POST'){
   const ip=req.socket.remoteAddress;let a=attempts.get(ip);if(!a || Date.now()>a.until){a={count:0,until:Date.now()+900000};attempts.set(ip,a);}if(++a.count>10) return send(res,429,{error:'Слишком много попыток. Повторите через 15 минут.'});
   const b=await body(req);if(!password || !same(b.password,password)) return send(res,401,{error:'Неверный пароль'});
   const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+86400000);attempts.delete(ip);
   return send(res,200,{ok:true},undefined,{'Set-Cookie':`le_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.PUBLIC_ORIGIN?.startsWith('https:')?'; Secure':''}`});
  }
  const isPublic=route==='/feeds/trees.csv'||route==='/feeds/decor.csv'||route==='/feeds/promos.csv'||route==='/pub';
  if(isPublic){
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS'};
   if(req.method==='OPTIONS') return send(res,204,'',undefined,headers);
   if(!['GET','HEAD'].includes(req.method)) return send(res,405,{error:'Только чтение'},undefined,headers);
   const gid=url.searchParams.get('gid');
   if(route==='/feeds/promos.csv' || (route==='/pub' && gid==='301234033')){
    const csv=exportPromoCSV(await listPromos());return send(res,200,req.method==='HEAD'?'':csv,'text/csv; charset=utf-8',headers);
   }
   const kind=route==='/feeds/decor.csv'||(route==='/pub' && gid==='500105078')?'decor':'trees';
   const [raw,settings]=await Promise.all([listProducts(),getSettings()]);const csv=exportCSV(raw.map(p=>pricedProduct(p,settings)),kind);return send(res,200,req.method==='HEAD'?'':csv,'text/csv; charset=utf-8',headers);
  }
  if(route.startsWith('/api/')){
   const token=req.headers.cookie?.match(/(?:^|;\s*)le_session=([^;]+)/)?.[1];
   if(password && !(sessions.get(token)>Date.now())) return send(res,401,{error:'Войдите для управления каталогом'});
   if(route==='/api/photos' && req.method==='POST'){
    const b=await body(req,12e6);if(typeof b.data!=='string') return send(res,400,{error:'Выберите фотографию'});
    const bytes=Buffer.from(b.data,'base64');if(bytes.length>8*1024*1024 || bytes.length<12) return send(res,400,{error:'Размер фото должен быть от 12 байт до 8 МБ'});
    const hex=bytes.subarray(0,12).toString('hex');
    const format=hex.startsWith('ffd8ff')?['image/jpeg','jpg']:hex.startsWith('89504e470d0a1a0a')?['image/png','png']:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?['image/webp','webp']:null;
    if(!format) return send(res,400,{error:'Поддерживаются фотографии JPG, PNG и WebP'});
    const compressed=await compressPhoto(bytes);const url=await uploadPhoto(compressed,'image/webp',`${randomBytes(18).toString('hex')}.webp`);return send(res,201,{url,format:'webp',quality:80,bytes:compressed.length,originalBytes:bytes.length});
   }
   if(route==='/api/catalog' && req.method==='GET') {const [raw,settings]=await Promise.all([listProducts(),getSettings()]);return send(res,200,{products:raw.map(p=>pricedProduct(p,settings)),settings,database:'Supabase',origin:process.env.PUBLIC_ORIGIN || url.origin});}
   if(route==='/api/settings' && req.method==='PUT') {
    const input=validateSettings(await body(req)),old=await getSettings();
    if(input.revision!==old.revision)return send(res,409,{error:'Настройки изменились в другом окне. Обновите страницу и повторите.'});
    const products=await listProducts();
    const used=new Set(products.filter(p=>p.kind==='trees').flatMap(p=>p.variants.map(v=>resolveType(v,old)?.id)));
    if(old.types.some(t=>used.has(t.id)&&!input.types.some(n=>n.id===t.id)))return send(res,400,{error:'Нельзя удалить тип, который используется в товарах. Сначала выберите для них другой тип.'});
    const payload={discount_pct:input.discount_pct,adjustment_pct:input.adjustment_pct,types:input.types.map(t=>{const prior=old.types.find(p=>p.id===t.id);return {id:t.id,name:t.name.trim(),aliases:prior?[...new Set([...(prior.aliases||[]),prior.name])]:[]};})};
    const rows=await db(`le_catalog_settings?id=eq.1&revision=eq.${old.revision}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({payload,revision:old.revision+1,updated_at:new Date().toISOString()})});
    if(!rows.length)return send(res,409,{error:'Настройки изменились в другом окне. Обновите страницу.'});
    return send(res,200,{...rows[0].payload,revision:rows[0].revision});
   }
   if(route==='/api/promos' && req.method==='GET'){
    const [promos,orders]=await Promise.all([listPromos(),listPaidOrders()]);
    const usage=promoUsage(orders);
    return send(res,200,{promos:promos.map(p=>({...p,usage:usage.get(normalizeCode(p.code))||{orders:0,amount:0,last:null}})),origin:process.env.PUBLIC_ORIGIN || url.origin});
   }
   if(route==='/api/promos' && req.method==='POST'){
    const input=validatePromo(await body(req));
    const rows=await db('le_promo_codes',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(input)});
    return send(res,201,promoRow(rows[0]));
   }
   if(route.startsWith('/api/promos/') && ['PUT','DELETE'].includes(req.method)){
    const id=decodeURIComponent(route.slice('/api/promos/'.length));
    if(!/^[0-9a-f-]{36}$/i.test(id)) return send(res,400,{error:'Неверный промокод'});
    if(req.method==='DELETE'){
     const rows=await db(`le_promo_codes?id=eq.${id}`,{method:'DELETE',headers:{Prefer:'return=representation'}});
     if(!rows.length) return send(res,404,{error:'Промокод уже удалён'});
     return send(res,200,{ok:true});
    }
    const raw=await body(req),input=validatePromo(raw);
    if(!Number.isInteger(raw.revision)||raw.revision<1) return send(res,400,{error:'Неверная версия промокода'});
    const rows=await db(`le_promo_codes?id=eq.${id}&revision=eq.${raw.revision}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({...input,revision:raw.revision+1,updated_at:new Date().toISOString()})});
    if(!rows.length) return send(res,409,{error:'Промокод изменён в другом окне. Обновите раздел и повторите.'});
    return send(res,200,promoRow(rows[0]));
   }
   if(route==='/api/products' && req.method==='POST'){
    const input=await body(req),settings=await getSettings();const p=prepareProduct(input,settings);const {revision,updated_at,...payload}=p;
    const rows=await db('le_catalog_products',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({id:p.id,payload})});
    return send(res,201,{...rows[0].payload,revision:rows[0].revision,updated_at:rows[0].updated_at});
   }
   if(route.startsWith('/api/products/') && req.method==='PUT'){
    const id=decodeURIComponent(route.slice('/api/products/'.length)),input=await body(req),settings=await getSettings();const p=prepareProduct(input,settings);
    if(p.id!==id || !Number.isInteger(p.revision) || p.revision<1) return send(res,400,{error:'Неверная версия товара'});
    const {revision,updated_at,...payload}=p;
    const rows=await db(`le_catalog_products?id=eq.${encodeURIComponent(id)}&revision=eq.${revision}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({payload,revision:revision+1,updated_at:new Date().toISOString()})});
    if(!rows.length) return send(res,409,{error:'Товар уже изменён в другом окне. Закройте карточку и обновите каталог перед повторным редактированием.'});
    return send(res,200,{...rows[0].payload,revision:rows[0].revision,updated_at:rows[0].updated_at});
   }
   if(route.startsWith('/api/products/') && req.method==='DELETE'){
    const id=decodeURIComponent(route.slice('/api/products/'.length));
    const rows=await db(`le_catalog_products?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',headers:{Prefer:'return=representation'}});
    if(!rows.length) return send(res,404,{error:'Товар уже удалён'});
    return send(res,200,{ok:true});
   }
   return send(res,404,{error:'Не найдено'});
  }
  if(req.method!=='GET') return send(res,405,{error:'Метод не поддерживается'});
  const file=route==='/'||route==='/app'||route==='/app/'?path.join(publicDir,'index.html'):path.resolve(publicDir,'.'+decodeURIComponent(route));
  if(!file.startsWith(publicDir)) return send(res,404,'Не найдено','text/plain');
  const ext=path.extname(file),mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[ext];
  if(!mime) return send(res,404,'Не найдено','text/plain');
  const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache','Content-Security-Policy':`default-src 'self'; img-src 'self' https: http: data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`});res.end(data);
 }catch(e){const status=e.code==='ENOENT'?404:e.status || (e instanceof TypeError?502:400);send(res,status,{error:e.code==='ENOENT'?'Не найдено':e.message});}
});
server.listen(port,host,()=>console.log(`Lady Elka: http://localhost:${port}/app — Supabase`));
