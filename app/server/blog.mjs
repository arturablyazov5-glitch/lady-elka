import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePost} from '../public/js/blog-model.js';
export {validatePost} from '../public/js/blog-model.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function createBlogStore(file=process.env.BLOG_CONTENT_FILE||fileURLToPath(new URL('../blog-content/posts.json',import.meta.url))){
 let queue=Promise.resolve();
 const read=async()=>{try{const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.version!==1||!Array.isArray(data.posts))fail('Неизвестный формат хранилища',500);return data.posts;}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const mutate=fn=>{const op=queue.then(async()=>{const posts=await read(),result=fn(posts);await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${randomUUID()}.tmp`;try{await fs.writeFile(tmp,JSON.stringify({version:1,posts},null,2)+'\n',{mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}return result;});queue=op.catch(()=>{});return op;};
 return {list:async()=>{await queue;return read();},save:async(raw,id)=>{
  if((await sourcePosts()).some(p=>p.slug===raw?.slug))fail('Адрес занят исходной статьёй; выберите другой адрес',409);
  return mutate(posts=>{
  const input=validatePost(raw),index=id?posts.findIndex(p=>p.id===id):-1;
  if(id&&index<0)fail('Статья не найдена',404);
  if(posts.some(p=>p.slug===input.slug&&p.id!==id))fail('Этот адрес уже занят',409);
  const old=posts[index];if(old&&raw.revision!==old.revision)fail('Статья изменена в другом окне. Обновите список.',409);
  const post={...input,id:old?.id||randomUUID(),revision:(old?.revision||0)+1,updatedAt:new Date().toISOString(),createdAt:old?.createdAt||new Date().toISOString()};
  if(old)posts[index]=post;else posts.push(post);return post;
 });},remove:(id,revision)=>mutate(posts=>{const i=posts.findIndex(p=>p.id===id);if(i<0)fail('Статья не найдена',404);if(posts[i].revision!==revision)fail('Статья изменена в другом окне',409);posts.splice(i,1);return {ok:true};})};
}
export async function sourcePosts(){
 const dir=fileURLToPath(new URL('../../storefront/public/blog/',import.meta.url));
 try{return await Promise.all((await fs.readdir(dir)).filter(n=>/^[a-z0-9-]+\.html$/.test(n)).map(async name=>{const html=await fs.readFile(path.join(dir,name),'utf8');return {slug:name.slice(0,-5),title:html.match(/<title>(.*?)<\/title>/s)?.[1]||name,status:'source',source:`storefront/public/blog/${name}`};}));}catch(e){if(e.code==='ENOENT')return [];throw e;}
}
export function exportBlog(posts){return {version:1,format:'plain-text',posts:posts.filter(p=>p.status==='published').map(p=>({...p,url:`/blog/${p.slug}.html`}))};}
