// A separate blog-only Edge Function. No imports from catalog/payment backends.
import {validatePost} from '../../public/js/blog-model.js';
const base=(Deno.env.get('SUPABASE_URL')||'').replace(/\/$/,''),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const origins=new Set((Deno.env.get('CATALOG_ALLOWED_ORIGINS')||'https://arturablyazov5-glitch.github.io,http://localhost:4180').split(',').map(s=>s.trim()));
const secret=Deno.env.get('CATALOG_SESSION_SECRET')||'',encoder=new TextEncoder();
const sourceTitles={'iskusstvennaya-yelka-cena-i-chto-na-nee-vliyaet':'Искусственная ёлка: цена и что на неё влияет','novogodnie-iskusstvennye-yelki-kak-vybrat-idealnuyu-yelku-dlya-doma-na-dolgie-gody':'Новогодние искусственные ёлки: как выбрать идеальную ёлку для дома на долгие годы'};
const reserved=new Set(Object.keys(sourceTitles));
const fail=(message:string,status=400)=>{throw Object.assign(new Error(message),{status});};
function decode(s:string){return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));}
async function admin(req:Request){try{if(!secret)return false;const token=req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]||'',[payload,signature,extra]=token.split('.');if(!payload||!signature||extra)return false;const hmac=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);return await crypto.subtle.verify('HMAC',hmac,decode(signature),encoder.encode(payload))&&Number(JSON.parse(new TextDecoder().decode(decode(payload))).exp)>Date.now();}catch{return false;}}
async function db(query:string,options:RequestInit={}){const res=await fetch(`${base}/rest/v1/le_blog_posts${query}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=representation'}});if(!res.ok){const error=await res.json().catch(()=>({}));if(error.code==='23505')fail('Этот адрес уже занят',409);fail('Не удалось сохранить блог',502);}return res.json();}
const post=(r:any)=>({...r.payload,id:r.id,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at});
Deno.serve(async req=>{
 const origin=req.headers.get('origin'),route=new URL(req.url).pathname.replace(/^.*\/le-admin-blog/,'');
 const publicRead=route==='/published'&&['GET','HEAD'].includes(req.method);
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':publicRead?'*':(origin&&origins.has(origin)?origin:''),'Access-Control-Allow-Methods':'GET, HEAD, POST, PUT, DELETE, OPTIONS','Access-Control-Allow-Headers':'authorization, content-type, x-catalog-request',Vary:'Origin'};
 const respond=(status:number,data:unknown)=>new Response(req.method==='HEAD'||status===204?null:JSON.stringify(data),{status,headers});
 try{
  if(req.method==='OPTIONS')return respond(204,null);
  if(publicRead){const rows=await db('?status=eq.published&select=*');return respond(200,{version:1,format:'plain-text',posts:rows.map(post)});}
  if(origin&&!origins.has(origin))return respond(403,{error:'Недопустимый источник запроса'});
  if(!await admin(req))return respond(401,{error:'Войдите для управления блогом'});
  if(route==='/posts'&&req.method==='GET')return respond(200,{posts:(await db('?select=*&order=created_at.desc')).map(post),sources:[...reserved].map(slug=>({slug,title:sourceTitles[slug],status:'source',source:`storefront/public/blog/${slug}.html`}))});
  if(route==='/export'&&req.method==='GET')return respond(200,{version:1,format:'plain-text',posts:(await db('?status=eq.published&select=*')).map((r:any)=>({...post(r),url:`/blog/${r.slug}.html`}))});
  if(!['POST','PUT','DELETE'].includes(req.method))return respond(404,{error:'Не найдено'});
  if(req.headers.get('x-catalog-request')!=='1'||!req.headers.get('content-type')?.startsWith('application/json'))return respond(403,{error:'Недопустимый запрос'});
  const raw=await req.text();if(raw.length>200000)fail('Слишком большой запрос',413);let input;try{input=JSON.parse(raw);}catch{fail('Некорректный JSON');}
  if(route==='/posts'&&req.method==='POST'){const p=validatePost(input);if(reserved.has(p.slug))fail('Адрес занят исходной статьёй',409);const rows=await db('',{method:'POST',body:JSON.stringify({slug:p.slug,status:p.status,payload:p})});return respond(201,post(rows[0]));}
  const id=route.match(/^\/posts\/([0-9a-f-]{36})$/)?.[1];if(!id||!['PUT','DELETE'].includes(req.method))return respond(404,{error:'Не найдено'});
  if(!Number.isInteger(input.revision)||input.revision<1)fail('Неверная версия статьи');
  const query=`?id=eq.${id}&revision=eq.${input.revision}`;
  if(req.method==='DELETE'){const rows=await db(query,{method:'DELETE'});if(!rows.length)fail('Статья изменена или удалена',409);return respond(200,{ok:true});}
  const p=validatePost(input);if(reserved.has(p.slug))fail('Адрес занят исходной статьёй',409);const rows=await db(query,{method:'PATCH',body:JSON.stringify({slug:p.slug,status:p.status,payload:p,revision:input.revision+1,updated_at:new Date().toISOString()})});if(!rows.length)fail('Статья изменена в другом окне. Обновите список.',409);return respond(200,post(rows[0]));
 }catch(e){return respond(e.status||400,{error:e.message||'Ошибка блога'});}
});
