import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,cp,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createSnapshot,loadSnapshot,validateExport,checksum} from '../blog/snapshot.mjs';
import {isolatedWorkspace} from '../../scripts/offline-suite-isolated-workspace.mjs';
import {interceptionLifecycle} from './browser-interception-lifecycle-helper.mjs';
const run=promisify(execFile), root=resolve(import.meta.dirname,'../..');
const post={id:'12345678-1234-1234-1234-123456789012',revision:1,title:'Проверка блога QABLOG',slug:'qa-blog-publication',excerpt:'Локальный анонс',cover:'',alt:'',text:'Первый абзац <script>window.blogExecuted=true</script>\n\nВторой & абзац',seoTitle:'SEO QABLOG',seoDescription:'Описание "QABLOG"',status:'published',createdAt:'2026-10-03T08:00:00.000Z',updatedAt:'2026-10-03T08:00:00.000Z',url:'/blog/qa-blog-publication.html'};
const exp=posts=>({version:1,format:'plain-text',posts});
test('export fails closed for unpublished, malformed, route collision and unsafe media',async()=>{
 for(const status of ['draft','archived'])await assert.rejects(()=>validateExport(exp([{...post,status}])),/published/);
 for(const patch of [{slug:'../bad'},{slug:'index',url:'/blog/index.html'},{url:'/blog/else.html'},{title:''},{text:''},{cover:'javascript:alert(1)',alt:'x'},{cover:'https://u:p@example.test/a.jpg',alt:'x'},{revision:0},{updatedAt:'yesterday'}])await assert.rejects(()=>validateExport(exp([{...post,...patch}])));
 await assert.rejects(()=>validateExport(exp([post,post])),/collision/);
 await assert.rejects(()=>validateExport(exp([post,{...post,slug:'other',url:'/blog/other.html'}])),/duplicate id/);
 await assert.rejects(()=>validateExport(exp([post]),[post.slug]),/collision/);
 await assert.rejects(()=>validateExport({version:2,format:'plain-text',posts:[]}),/version/);
 await assert.rejects(()=>validateExport({version:1,format:'markdown',posts:[]}),/plain-text/);
 assert.deepEqual(await validateExport(exp([])),[]);
});
test('snapshot pins provenance, bytes and covers; explicit missing file fails',async()=>{
 const temp=await mkdtemp('/tmp/le-blog-snapshot-');
 try {
  const snapshot=await createSnapshot(exp([post]));const file=join(temp,'snapshot.json');await writeFile(file,JSON.stringify(snapshot));
  assert.equal((await loadSnapshot({file})).posts.length,1);
  snapshot.posts[0].title='tampered';await writeFile(file,JSON.stringify(snapshot));await assert.rejects(loadSnapshot({file}),/checksum/);
  await assert.rejects(loadSnapshot({file:join(temp,'absent.json')}),/ENOENT/);
  await assert.rejects(createSnapshot(exp([{...post,cover:'https://example.test/cover.jpg',alt:'Cover'}])),/local asset/);
  await assert.rejects(createSnapshot(exp([{...post,cover:'/images/missing.jpg',alt:'Cover'}])),/missing local/);
  const asset='/thumb/2/PtjAvngQxE8A8E2OLZFEuA/100r100/d/frame_62285_1.png';
  const covered=await createSnapshot(exp([{...post,cover:'https://example.test/cover.jpg',alt:'Cover'}]),{mapping:{'https://example.test/cover.jpg':asset}});
  assert.equal(covered.assets['https://example.test/cover.jpg'].url,asset);
  await writeFile(file,JSON.stringify(covered));await loadSnapshot({file});
  covered.assets['https://example.test/cover.jpg'].sha256='0'.repeat(64);covered.sha256=checksum({version:covered.version,format:covered.format,posts:covered.posts,assets:covered.assets,provenance:covered.provenance,productionReady:false});await writeFile(file,JSON.stringify(covered));await assert.rejects(loadSnapshot({file}),/cover checksum/);
 } finally {await rm(temp,{recursive:true,force:true});}
});
test('offline importer and static pipeline preserve legacy and support browser direct/reload/list/search',async()=>{
 const workspace=await isolatedWorkspace(root);let server,chrome,ws,lifecycle,profile;
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 try {
  const cwd=workspace.directory, dist=join(cwd,'storefront/dist');
  // TEMP full-suite copies exclude app; copy only the canonical public schema, never credentials.
  await mkdir(join(cwd,'app/public/js'),{recursive:true});const physicalRoot=resolve(await (await import('node:fs/promises')).realpath(join(root,'node_modules')),'..');
  await cp(join(physicalRoot,'app/public/js/blog-model.js'),join(cwd,'app/public/js/blog-model.js'));
  const deny='data:text/javascript,globalThis.fetch=()=>{throw new Error("Network forbidden")}';
  const build=()=>run(process.execPath,['--import',deny,'storefront/build.mjs','--mode=preview'],{cwd,maxBuffer:2e6,env:{...process.env,LE_BLOG_SNAPSHOT:join(cwd,'storefront/blog/snapshot.json')}});
  // Explicit absent default is tested with no override; external overrides must fail.
  await run(process.execPath,['--import',deny,'storefront/build.mjs','--mode=preview'],{cwd,env:{...process.env,LE_BLOG_SNAPSHOT:''}});
  const legacyNames=(await import('node:fs/promises')).readdir;
  const names=(await legacyNames(join(cwd,'storefront/public/blog'))).filter(n=>n.endsWith('.html'));
  const hashes={};for(const name of names)hashes[name]=checksum(await readFile(join(dist,'blog',name)));
  const listHash=checksum(await readFile(join(dist,'blog.html')));
  const empty=join(cwd,'empty.json');await writeFile(empty,JSON.stringify(exp([])));
  await run(process.execPath,['--import',deny,'storefront/blog/import.mjs','--input',empty],{cwd});await build();
  assert.equal(checksum(await readFile(join(dist,'blog.html'))),listHash);
  const input=join(cwd,'export.json');await writeFile(input,JSON.stringify(exp([post])));
  await assert.rejects(run(process.execPath,['storefront/blog/import.mjs','--input',input],{cwd}),/already exists/);
  await run(process.execPath,['--import',deny,'storefront/blog/import.mjs','--input',input,'--replace'],{cwd});await build();
  for(const name of names)assert.equal(checksum(await readFile(join(dist,'blog',name))),hashes[name],name);
  const article=await readFile(join(dist,post.url.slice(1)),'utf8');
  assert.equal(article,await readFile(join(dist,'blog',post.slug,'index.html'),'utf8'));
  assert.match(article,/<title>SEO QABLOG<\/title>/);assert.match(article,/<h1\b[^>]*>.*Проверка блога QABLOG/);
  assert.match(article,/canonical" href="https:\/\/lady-elka.ru\/blog\/qa-blog-publication.html/);
  assert.match(article,/&lt;script&gt;/);assert.doesNotMatch(article,/<script>window.blogExecuted/);
  assert.match(article,/content="Описание &quot;QABLOG&quot;"/);
  const index=JSON.parse(await readFile(join(dist,'search-index.json'),'utf8'));assert.equal(index.filter(p=>p.path===post.url).length,1);assert.equal(index.find(p=>p.path===post.url).kind,'article');assert.equal(index.length,68);
  assert.match(await readFile(join(dist,'sitemap.xml'),'utf8'),/qa-blog-publication.html/);
  assert.equal(JSON.parse(await readFile(join(dist,'build-manifest.json'),'utf8')).productionReady,false);
  const content={version:1,blocks:[{type:'heading2',runs:[{text:'Раздел RICHBODYONLY',bold:true}]},{type:'heading3',runs:[{text:'Подраздел'}]},{type:'paragraph',runs:[{text:'Курсив',italic:true},{text:' ссылка',href:'https://example.test/path?q=1&b=2'},{text:' <img src=x onerror=alert(1)>'}]},{type:'bulletList',items:[[{text:'Маркер',bold:true}]]},{type:'orderedList',items:[[{text:'Номер',italic:true}]]}]};
  await mkdir(join(cwd,'storefront/public/images'),{recursive:true});await cp(join(cwd,'storefront/public/thumb/2/PtjAvngQxE8A8E2OLZFEuA/100r100/d/frame_62285_1.png'),join(cwd,'storefront/public/images/blog-cover.png'));
  const richPost={...post,cover:'/images/blog-cover.png',alt:'Локальная обложка',id:'22345678-1234-1234-1234-123456789012',slug:'qa-rich-publication',url:'/blog/qa-rich-publication.html',title:'Rich article',seoTitle:'Rich SEO',seoDescription:'Rich description',text:'Раздел RICHBODYONLY\nПодраздел\nКурсив ссылка <img src=x onerror=alert(1)>\nМаркер\nНомер',contentFormat:'le-richtext-v1',content};
  const beforeRejectedImports=checksum(await readFile(join(cwd,'storefront/blog/snapshot.json')));
  for(const bad of [{contentFormat:'html'},{content:{version:1,blocks:[{type:'html',html:'<script>bad</script>'}]}},{text:'different fallback'},{content:{version:1,blocks:[{type:'paragraph',runs:[{text:'bad',href:'javascript:alert(1)'}]}]}},{content:{version:1,blocks:[{type:'paragraph',runs:[{text:'bad',href:'https://u:p@example.test'}]}]}},{content:{version:1,blocks:[{type:'paragraph',runs:[{text:'bad',style:'color:red'}]}]}}]){
   await writeFile(input,JSON.stringify(exp([{...richPost,...bad}])));await assert.rejects(run(process.execPath,['--import',deny,'storefront/blog/import.mjs','--input',input,'--replace'],{cwd}));assert.equal(checksum(await readFile(join(cwd,'storefront/blog/snapshot.json'))),beforeRejectedImports);
  }
  await writeFile(input,JSON.stringify(exp([post,richPost])));
  for(let repeat=0;repeat<2;repeat++)await run(process.execPath,['--import',deny,'storefront/blog/import.mjs','--input',input,'--replace'],{cwd});
  const saved=JSON.parse(await readFile(join(cwd,'storefront/blog/snapshot.json'),'utf8'));assert.deepEqual(saved.posts[1].content,content);
  await build();
  for(const name of names)assert.equal(checksum(await readFile(join(dist,'blog',name))),hashes[name],name);
  const richHtml=await readFile(join(dist,richPost.url.slice(1)),'utf8');
  assert.match(richHtml,/<h2><strong>Раздел RICHBODYONLY<\/strong><\/h2>/);assert.match(richHtml,/<h3>Подраздел<\/h3>/);assert.match(richHtml,/<ul><li><strong>Маркер/);assert.match(richHtml,/<ol><li><em>Номер/);assert.match(richHtml,/href="https:\/\/example.test\/path\?q=1&amp;b=2" rel="noopener noreferrer"/);assert.match(richHtml,/&lt;img/);
  const richIndex=JSON.parse(await readFile(join(dist,'search-index.json'),'utf8'));assert.equal(richIndex.length,69);assert.ok(richIndex.find(p=>p.path===richPost.url).description.includes('RICHBODYONLY'));assert.doesNotMatch(richIndex.find(p=>p.path===richPost.url).description,/<strong>/);
  // server.mjs pins build-manifest.json at start (503 after a rebuild) — restart it after each rebuild.
  const startServer=async()=>{server=spawn(process.execPath,['--import',deny,'storefront/server.mjs','--mode=preview'],{cwd,env:{...process.env,STOREFRONT_PORT:'0'},stdio:['ignore','pipe','pipe']});
  return new Promise((res,rej)=>{const timer=setTimeout(()=>rej(new Error('server timeout')),10000);server.stdout.on('data',b=>{const m=b.toString().match(/localhost:(\d+)/);if(m){clearTimeout(timer);res(`http://127.0.0.1:${m[1]}`);}});server.once('exit',rej);});};
  let origin=await startServer();
  for(const path of ['/blog/unpublished.html','/blog/unpublished','/blog/qa-blog-publication-extra.html'])assert.equal((await fetch(origin+path)).status,404);
  profile=await mkdtemp('/tmp/le-blog-chrome-');
  chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
  const endpoint=await new Promise((res,rej)=>{let output='';const timer=setTimeout(()=>rej(new Error('Chrome timeout')),15000);chrome.stderr.on('data',b=>{output+=b;const m=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);res(m[1]);}});chrome.once('error',rej);});
  const pages=await(await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/,'/json/list'))).json();
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  const requests=[],blocked=[];lifecycle=interceptionLifecycle(ws,{origin,requests,blocked});const command=lifecycle.command;
  const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  const until=async expression=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await delay(30);}throw new Error(`Browser timeout ${expression}`);};
  await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await command('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:'window.qaErrors=[];addEventListener("error",e=>qaErrors.push(e.message));'});
  const navigate=async path=>{const before=await evaluate('performance.timeOrigin');await command('Page.navigate',{url:origin+path});await until(`performance.timeOrigin!==${before} && document.readyState==='complete'`);};
  for(const path of [post.url,`/blog/${post.slug}`]){await navigate(path);assert.equal(await evaluate('document.title'),post.seoTitle);assert.equal(await evaluate('document.querySelectorAll("h1").length'),1);assert.equal(await evaluate('window.blogExecuted===true'),false);assert.deepEqual(await evaluate('qaErrors'),[]);const before=await evaluate('performance.timeOrigin');await command('Page.reload',{ignoreCache:true});await until(`performance.timeOrigin!==${before} && document.readyState==='complete'`);assert.equal(await evaluate('document.querySelector("h1").textContent'),post.title);}
  await navigate('/blog');assert.equal(await evaluate(`document.querySelectorAll('a[href="${post.url}"]').length`),1);assert.equal(await evaluate(`document.querySelector('a[href="${post.url}"]').getBoundingClientRect().height>0`),true);
  await navigate('/search?search=QABLOG');await until(`document.querySelector('.search-result__list a')?.getAttribute('href')==='${post.url}'`);assert.deepEqual(await evaluate('qaErrors'),[]);
  await navigate(richPost.url);assert.equal(await evaluate('document.querySelector("h2 strong").textContent'),'Раздел RICHBODYONLY');assert.equal(await evaluate('document.querySelectorAll("#idm088ivb_0 img").length'),1);assert.equal(await evaluate('document.querySelector("#idm088ivb_0 img").naturalWidth>0'),true);assert.deepEqual(await evaluate('qaErrors'),[]);
  await navigate('/search?search=RICHBODYONLY');await until(`document.querySelector('.search-result__list a')?.getAttribute('href')==='${richPost.url}'`);
  await lifecycle.drain();
  // Footer/header social logos are intentionally hotlinked from trace-logos.ru (build.mjs socialLogoSpecs, CSP img-src); everything else must stay local.
  assert.deepEqual(blocked.filter(url=>!/^https:\/\/trace-logos\.ru\/assets\/logos\/svgs\/[a-z-]+\.svg$/.test(url)),[]);assert.ok(requests.every(r=>r.method==='GET'));
  await run(process.execPath,['--import',deny,'storefront/blog/import.mjs','--input',empty,'--replace'],{cwd});await build();
  server.removeAllListeners('exit');server.kill('SIGTERM');await delay(300);origin=await startServer();
  for(const path of [post.url,`/blog/${post.slug}`,richPost.url,`/blog/${richPost.slug}`])assert.equal((await fetch(origin+path)).status,404);
  for(const name of names)assert.equal(checksum(await readFile(join(dist,'blog',name))),hashes[name],name);
  assert.equal(checksum(await readFile(join(dist,'blog.html'))),listHash);assert.equal(JSON.parse(await readFile(join(dist,'search-index.json'),'utf8')).length,67);assert.doesNotMatch(await readFile(join(dist,'sitemap.xml'),'utf8'),/qa-(?:blog|rich)-publication/);
  console.log('Blog browser verified: .html + clean route, reload, visible list, actual search, escaped text, no external requests/writes; legacy byte hashes identical.');
 } finally {
  lifecycle?.stop();ws?.close();if(chrome?.pid){try{process.kill(-chrome.pid,'SIGTERM');}catch{}await delay(700);try{process.kill(-chrome.pid,'SIGKILL');}catch{}}
  server?.kill('SIGTERM');await delay(300);if(profile)await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});await workspace.cleanup();
 }
});
