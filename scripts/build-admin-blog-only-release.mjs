import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {projectRoot,snapshot} from './build-admin-release.mjs';
export const BASELINE='40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9';
export const additions=['css/blog.css','js/blog.js','js/blog-model.js','js/blog-rich-editor.js'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const replaceOnce=(s,from,to)=>{if(s.split(from).length!==2)throw Error('Ambiguous insertion anchor');return s.replace(from,()=>to);};
export function blogIntegration(index,app,currentIndex){
  const take=re=>{const matches=[...currentIndex.matchAll(re)];if(matches.length!==1)throw Error('Ambiguous blog source fragment');return matches[0][0];};
  const fragments={css:take(/<link rel="stylesheet" href="\.\/css\/blog\.css">/g),nav:take(/<a class="tab-btn" href="#blog" data-nav="blog">[\s\S]*?<\/a>/g),section:take(/<section class="tab-panel contact-finder-panel" id="blog-page" hidden>[\s\S]*?<\/form><\/section>/g),dialog:take(/<dialog id="blog-link-dialog"[\s\S]*?<\/dialog>/g),script:take(/<script type="module" src="\.\/js\/blog\.js"><\/script>/g)};
  for(const s of Object.values(fragments))if(/payment-success|pro-ticket/.test(s))throw Error('Non-blog fragment');
  const before=index;
  index=replaceOnce(index,'</head>',fragments.css+'</head>');
  index=replaceOnce(index,'<a class="tab-btn" href="#orders"',fragments.nav+'<a class="tab-btn" href="#orders"');
  index=replaceOnce(index,'<section class="tab-panel contact-finder-panel" id="promos-page"',fragments.section+'\n<section class="tab-panel contact-finder-panel" id="promos-page"');
  index=replaceOnce(index,'<div class="toast"',fragments.dialog+'<div class="toast"');
  index=replaceOnce(index,'</body>',fragments.script+'</body>');
  let reversed=index;for(const s of Object.values(fragments))reversed=replaceOnce(reversed,s,'');
  // Section insertion adds exactly one separator newline.
  reversed=reversed.replace('\n\n<section class="tab-panel contact-finder-panel" id="promos-page"','\n<section class="tab-panel contact-finder-panel" id="promos-page"');
  if(reversed!==before)throw Error('Non-blog DOM change');
  const line=app.split('\n').find(s=>s.startsWith('function navigate(page)'));
  if(!line || app.split(line).length!==2 || line.includes('payment-success'))throw Error('Unexpected baseline navigation');
  if(line.split("['catalog','orders'").length!==3)throw Error('Unexpected navigation lists');
  let changed=line.replaceAll("['catalog','orders'","['catalog','blog','orders'");
  changed=replaceOnce(changed,"${{profile:","${{blog:'Блог',profile:");
  const restored=changed.replaceAll("['catalog','blog','orders'","['catalog','orders'").replace("${{blog:'Блог',profile:","${{profile:");
  if(restored!==line)throw Error('Non-blog navigation change');
  return {index,app:app.replace(line,()=>changed),fragments};
}
export function baselineFiles(){
  const rows=execFileSync('git',['ls-tree','-r',BASELINE,'--','app/public'],{cwd:projectRoot,encoding:'utf8'}).trim().split('\n');
  return rows.map(row=>{const m=row.match(/^100644 blob ([0-9a-f]{40})\tapp\/public\/(.+)$/);if(!m)throw Error('Unsafe baseline entry');return {path:m[2],blob:m[1],bytes:execFileSync('git',['show',`${BASELINE}:app/public/${m[2]}`],{cwd:projectRoot})};});
}
export async function buildBlogOnly(output){
  if(!output || !path.isAbsolute(output))throw Error('Absolute external fresh output required');
  output=path.resolve(output);if(output===projectRoot.replace(/\/$/,'')||output.startsWith(projectRoot)||projectRoot.startsWith(output+'/'))throw Error('External output required');
  for(let p=output;p!==path.dirname(p);p=path.dirname(p)){try{if((await fs.lstat(p)).isSymbolicLink())throw Error('Symlink output ancestor');}catch(e){if(e.code!=='ENOENT')throw e;}}
  try{await fs.lstat(output);throw Error('Output exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  const baseline=baselineFiles(), map=new Map(baseline.map(f=>[f.path,f.bytes]));
  const workflow=execFileSync('git',['show',`${BASELINE}:.github/workflows/pages.yml`],{cwd:projectRoot});
  if(!workflow.equals(await fs.readFile(path.join(projectRoot,'.github/workflows/pages.yml'))))throw Error('Workflow drift');
  const currentIndex=await fs.readFile(path.join(projectRoot,'app/public/index.html'),'utf8');
  const integrated=blogIntegration(map.get('index.html').toString(),map.get('js/app.js').toString(),currentIndex);
  map.set('index.html',Buffer.from(integrated.index));map.set('js/app.js',Buffer.from(integrated.app));
  const sources=[];
  for(const relative of additions){const full=path.join(projectRoot,'app/public',relative);if(!(await fs.lstat(full)).isFile()||(await fs.lstat(full)).isSymbolicLink())throw Error('Unsafe blog source');const bytes=await fs.readFile(full);if(map.has(relative))throw Error('Blog already in baseline');map.set(relative,bytes);sources.push({path:'app/public/'+relative,sha256:hash(bytes)});}
  await fs.mkdir(output,{recursive:true});
  try{
    const write=async(rel,bytes)=>{const full=path.join(output,rel);await fs.mkdir(path.dirname(full),{recursive:true});await fs.writeFile(full,bytes,{flag:'wx'});};
    for(const f of baseline)await write('baseline/app/public/'+f.path,f.bytes);
    for(const [rel,bytes] of map){await write('candidate/app/public/'+rel,bytes);await write('site/'+rel,bytes);}
    for(const dir of ['baseline','candidate'])await write(dir+'/.github/workflows/pages.yml',workflow);
    const files=await snapshot(path.join(output,'site'));
    const delta=files.filter(f=>!baseline.some(b=>b.path===f.path&&hash(b.bytes)===f.sha256));
    if(JSON.stringify(delta.map(f=>f.path).sort())!==JSON.stringify(['index.html','js/app.js',...additions].sort()))throw Error('Unexpected delta');
    const diff=spawnSync('git',['diff','--no-index','--binary','--','baseline','candidate'],{cwd:output,encoding:'utf8',maxBuffer:10_000_000});if(diff.status!==1)throw Error('Patch generation failed');
    await write('baseline-to-blog-only.patch',diff.stdout);
    const manifest={version:1,baselineSHA:BASELINE,workflowSHA256:hash(workflow),files,baseline:baseline.map(f=>({path:f.path,blobSHA:f.blob,sha256:hash(f.bytes)})),sources:[...sources,{path:'app/public/index.html',sha256:hash(currentIndex),fragments:Object.fromEntries(Object.entries(integrated.fragments).map(([k,v])=>[k,hash(v)]))}],delta:delta.map(f=>({...f,baselineSHA256:baseline.find(b=>b.path===f.path)?hash(baseline.find(b=>b.path===f.path).bytes):null})),unchangedBaselineFiles:baseline.length-2,patch:{path:'baseline-to-blog-only.patch',sha256:hash(diff.stdout)},published:false};
    await write('manifest.json',JSON.stringify(manifest,null,2)+'\n');
    return {output,files:files.length,unchangedBaselineFiles:manifest.unchangedBaselineFiles,patch:path.join(output,manifest.patch.path)};
  }catch(e){await fs.rm(output,{recursive:true,force:true});throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await buildBlogOnly(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
