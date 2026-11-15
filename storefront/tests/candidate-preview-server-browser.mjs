// Existing local Chrome, isolated profile and artifact. External network fails closed.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
assert.ok(process.argv[2], 'Usage: node storefront/tests/candidate-preview-server-browser.mjs ARTIFACT_DIRECTORY');
const root = resolve(process.argv[2]);
assert.equal(JSON.parse(await readFile(join(root, 'build-manifest.json'))).candidatePreview.ownerAccepted, false);
const server = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--mode=preview', '--root=' + root], {env:{...process.env, STOREFRONT_PORT:'0'},stdio:['ignore','pipe','pipe']});
const origin = await new Promise((resolve,reject)=>{let output='';server.stdout.on('data',b=>{output+=b;const match=output.match(/http:\/\/localhost:(\d+)/);if(match)resolve('http://127.0.0.1:'+match[1]);});server.once('exit',code=>reject(new Error('Server exited '+code)));server.stderr.on('data',b=>reject(new Error(String(b))));});
const profile = await mkdtemp(join(tmpdir(),'le-candidate-server-browser-'));
const requests = [];
const csp = (await fetch(origin)).headers.get('content-security-policy');
let chrome, ws; const pending = new Map(); let seq = 0; const blocked = [], errors = [];
const command = (method,params={}) => new Promise((resolve,reject)=> {const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const evaluate = async expression => {const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
try {
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((r,j)=>{let s='';const timer=setTimeout(()=>j(new Error('CDP timeout')),15000);chrome.stderr.on('data',b=>{s+=b;const m=s.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);r(m[1]);}});chrome.once('error',j);});
  const pages=await (await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=async e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Fetch.requestPaused'){requests.push({url:m.params.request.url,method:m.params.request.method});const url=new URL(m.params.request.url);if(url.origin!==origin){blocked.push(url.href);await command('Fetch.failRequest',{requestId:m.params.requestId,errorReason:'BlockedByClient'});}else await command('Fetch.continueRequest',{requestId:m.params.requestId});}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);};
  await command('Page.enable');await command('Runtime.enable');await command('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  const results=[];
  const routes=JSON.parse(await readFile(new URL('../product-routes.json',import.meta.url)));
  for (const id of ['1','13']) {
    const route=routes.find(r=>r.id===id);await command('Page.navigate',{url:origin+route.path});
    for(let i=0;i<150;i++){if(await evaluate(`document.readyState==='complete' && !!document.querySelector('[data-storefront-page-product]')`))break;await new Promise(r=>setTimeout(r,30));}
    await command('Page.reload');
    for(let i=0;i<150;i++){if(await evaluate(`document.readyState==='complete' && !!document.querySelector('[data-storefront-page-product]')`))break;await new Promise(r=>setTimeout(r,30));}
    const data=await evaluate(`JSON.parse(document.querySelector('[data-storefront-page-product]').textContent)`);
    let checks=0;
    for(const variant of data.variants){
      const result=await evaluate(`(()=>{const root=document.querySelector('[data-storefront-product]');const wanted=${JSON.stringify(variant)};for(const key of ['category','height','size']){const select=root.querySelector('[data-storefront-option="'+key+'"]');if(select && [...select.options].some(o=>o.value===wanted.options[key])){select.value=wanted.options[key];select.dispatchEvent(new Event('change',{bubbles:true}));}}return {main:root.querySelector('[data-storefront-image] img')?.getAttribute('src'),secondary:[...root.querySelectorAll('[data-storefront-gallery] img')].map(img=>img.getAttribute('src'))};})()`);
      if(variant.photos.length)assert.equal(result.main,variant.photos[0]);assert.deepEqual(result.secondary,variant.photos.slice(1));checks++;
    }
    await evaluate(`Promise.all([...document.images].map(img=>img.decode().catch(()=>null)))`);
    const broken=await evaluate(`[...document.querySelectorAll('[data-storefront-gallery-root] img,[data-storefront-gallery] img')].filter(img=>img.getAttribute('src') && !img.naturalWidth).map(img=>img.src)`);assert.deepEqual(broken,[]);
    if(data.variants.some(v=>v.photos.length>1)) {
      const opened=await evaluate(`(()=>{document.querySelector('[data-storefront-gallery-root] img').click();return !!document.querySelector('[data-gallery-close]');})()`);assert.equal(opened,true);
      await evaluate(`document.querySelector('[data-gallery-close]').click()`);
    }
    results.push({id,path:route.path,variants:data.variants.length,checks,price:data.variants[0]?.price,unavailable:data.variants.length===0});
  }
  assert.ok(results.find(r=>r.id==='13').price===22000);
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'));
  console.log(JSON.stringify({results,externalRequests:blocked.length,runtimeErrors:errors.length,writeRequests:0,csp},null,2));
} finally {ws?.close();chrome?.kill('SIGTERM'); server.kill('SIGTERM');await new Promise(r=>setTimeout(r,300));await rm(profile,{recursive:true,force:true});}
