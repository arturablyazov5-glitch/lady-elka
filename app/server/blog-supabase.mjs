// Хранилище блога локального кабинета в Supabase (public.le_blog_posts) — та же модель, что у edge le-admin-blog:
// payload = validatePost(), оптимистичная блокировка по revision, slug исходных статей зарезервированы.
// Сайт забирает опубликованные статьи через le-admin-blog/published (storefront/blog/sync.mjs).
import {db} from './db.mjs';
import {validatePost} from '../public/js/blog-model.js';
import {sourcePosts} from './blog.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const rowToPost=r=>({...r.payload,id:r.id,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at});
export function createSupabaseBlogStore({query=db}={}){
 const call=async(path,options={})=>{
  try{return await query(path,{...options,headers:{Prefer:'return=representation',...options.headers}});}
  catch(e){if(e.status===409)fail('Этот адрес уже занят',409);throw e;}
 };
 const reserved=async slug=>{if((await sourcePosts()).some(p=>p.slug===slug))fail('Адрес занят исходной статьёй; выберите другой адрес',409);};
 const missingOrStale=async id=>{const rows=await call(`le_blog_posts?id=eq.${id}&select=id`);fail(rows?.length?'Статья изменена в другом окне. Обновите список.':'Статья не найдена',rows?.length?409:404);};
 return {
  storage:'supabase',
  list:async()=>(await call('le_blog_posts?select=*&order=created_at.desc')).map(rowToPost),
  save:async(raw,id)=>{
   const input=validatePost(raw);await reserved(input.slug);
   if(!id){const rows=await call('le_blog_posts',{method:'POST',body:JSON.stringify({slug:input.slug,status:input.status,payload:input})});return rowToPost(rows[0]);}
   if(!uuid.test(id))fail('Неверный идентификатор статьи');
   if(!Number.isInteger(raw.revision)||raw.revision<1)fail('Статья изменена в другом окне. Обновите список.',409);
   const rows=await call(`le_blog_posts?id=eq.${id}&revision=eq.${raw.revision}`,{method:'PATCH',body:JSON.stringify({slug:input.slug,status:input.status,payload:input,revision:raw.revision+1,updated_at:new Date().toISOString()})});
   if(!rows?.length)await missingOrStale(id);
   return rowToPost(rows[0]);
  },
  remove:async(id,revision)=>{
   if(!uuid.test(id))fail('Неверный идентификатор статьи');
   if(!Number.isInteger(revision)||revision<1)fail('Статья изменена в другом окне',409);
   const rows=await call(`le_blog_posts?id=eq.${id}&revision=eq.${revision}`,{method:'DELETE'});
   if(!rows?.length)await missingOrStale(id);
   return {ok:true};
  },
 };
}
