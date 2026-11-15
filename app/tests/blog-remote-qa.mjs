// Explicit remote QA: creates and cleans only a unique synthetic blog draft.
import {isDeepStrictEqual} from 'node:util';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
const ref='mgnotvaahftrbifqtahf',id=randomUUID(),slug=`qa-blog-${id}`,base=`https://${ref}.supabase.co/functions/v1/le-admin-blog`;
const dir=await fs.mkdtemp('/tmp/elka-blog-remote-');
async function sql(query){const file=dir+'/query.sql';await fs.writeFile(file,query);const result=JSON.parse(execFileSync('supabase',['db','query','--linked','--file',file,'--output','json'],{encoding:'utf8'}));return result.rows;}
const assert=(x,m)=>{if(!x)throw Error(m);};
try{
 const projects=JSON.parse(execFileSync('supabase',['projects','list','--output','json'],{encoding:'utf8'}));assert(projects.some(p=>p.id===ref&&p.linked&&p.name==='lady elka'),'wrong target');
 const content={version:1,blocks:[{type:'heading2',runs:[{text:'Synthetic heading',bold:true}]},{type:'paragraph',runs:[{text:'Synthetic italic',italic:true}]}]};
 const p={contentFormat:'le-richtext-v1',content,title:'Synthetic blog QA',slug,status:'draft',excerpt:'QA only',text:'QA only',cover:'/images/qa-blog-cover.webp',alt:'Synthetic cover reference',seoTitle:'',seoDescription:''};
 await sql(`insert into public.le_blog_posts(id,slug,status,payload) values ('${id}','${slug}','draft','${JSON.stringify(p)}'::jsonb)`);
 const rows=await sql(`select id,slug,status,revision,payload->>'cover' as cover,payload->'content' as content from public.le_blog_posts where id='${id}' and slug='${slug}'`);assert(rows.length===1&&rows[0].cover===p.cover&&isDeepStrictEqual(rows[0].content,content),'persistence');
 const publicPosts=async()=>{const r=await fetch(base+'/published');assert(r.status===200,'public endpoint');return (await r.json()).posts;};
 assert(!(await publicPosts()).some(p=>p.id===id),'draft leaked');
 assert((await fetch(base+'/posts')).status===401,'anonymous admin read');
 assert((await fetch(base+'/posts',{method:'POST',headers:{'Content-Type':'application/json','X-Catalog-Request':'1'},body:JSON.stringify(p)})).status===401,'anonymous write');
 assert((await fetch(base+'/posts',{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/json'},body:'{}'})).status===403,'foreign origin');
 const anonymous=await sql(`begin; set local role anon; select id from public.le_blog_posts where id='${id}'; rollback;`);assert(!anonymous?.length,'RLS draft leak');
 await sql(`update public.le_blog_posts set payload=jsonb_set(payload,'{title}','"Synthetic blog QA edited"'),revision=2 where id='${id}' and slug='${slug}' and revision=1`);
 const edited=await sql(`select payload->>'title' as title,revision from public.le_blog_posts where id='${id}' and slug='${slug}'`);assert(edited[0].revision===2&&edited[0].title.endsWith('edited'),'edit');
 await sql(`update public.le_blog_posts set status='archived',payload=jsonb_set(payload,'{status}','"archived"'),revision=3 where id='${id}' and slug='${slug}'`);assert(!(await publicPosts()).some(p=>p.id===id),'archive leaked');
 console.log(JSON.stringify({project:ref,remote:'SQL synthetic draft create/read/edit/archive; public draft/archive denied; cover reference persisted; unauth read/write 401; foreign origin 403',limitation:'Authenticated Edge writes not exercised: no admin session; cover file not uploaded (URL-only editor)'}));
}finally{await sql(`delete from public.le_blog_posts where id='${id}' and slug='${slug}'`);await fs.rm(dir,{recursive:true,force:true});}
