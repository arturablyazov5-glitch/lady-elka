// Local-only Chromium check, with page JavaScript disabled and all outside requests blocked.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export async function browserProof(origin, {expectedPrice=22000, screenshot}={}) {
  const profile=await mkdtemp('/private/tmp/le-sync-chrome-'); let ws;
  const child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
  try {
    const endpoint=await new Promise((ok,fail)=>{let text='';const timeout=setTimeout(()=>fail(Error('Chrome startup timeout')),15000);child.stderr.on('data',b=>{text+=b;const m=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timeout);ok(m[1]);}});child.once('error',fail);});
    const pages=await(await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/,'/json/list'))).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
    let id=0;const pending=new Map(),external=new Set();
    function command(method,params={}){return new Promise((ok,fail)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);fail(Error(`CDP timeout ${method}`));},15000);pending.set(n,{ok:v=>{clearTimeout(timer);ok(v)},fail:e=>{clearTimeout(timer);fail(e)}});ws.send(JSON.stringify({id:n,method,params}));});}
    ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.fail(Error(m.error.message)):p.ok(m.result);}}else if(m.method==='Fetch.requestPaused'){const r=m.params,local=r.request.url.startsWith(origin+'/');if(!local)external.add(new URL(r.request.url).hostname);command(local?'Fetch.continueRequest':'Fetch.failRequest',local?{requestId:r.requestId}:{requestId:r.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}};
    const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error('Browser evaluation failed');return r.result.value;};
    await command('Page.enable');await command('Emulation.setScriptExecutionDisabled',{value:true});await command('Fetch.enable',{patterns:[{urlPattern:'*'}]});await command('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
    // Cards intentionally use derived WebP thumbnails (build thumbnail map); every thumbnail must map back to a served
    // pinned original with the same content hash. Only these two local prefixes are allowed, never remote hosts.
    const PINNED='/media/catalog-pinned/',THUMBS='/media/catalog-thumbs/';
    const configText=await(await fetch(origin+'/f/storefront-config.js')).text();
    const thumbMap=JSON.parse(configText.slice(configText.indexOf('=')+1).trim().replace(/;$/,'')).thumbnails||{};
    const originalOf=new Map();
    for(const [original,sizes] of Object.entries(thumbMap))for(const entry of Object.values(sizes)){
      assert.ok(original.startsWith(PINNED)&&entry.url.startsWith(THUMBS),`thumbnail map entry outside local prefixes: ${original} -> ${entry.url}`);
      originalOf.set(entry.url,original);
    }
    // Intentional content-hash change: resolve hashed derived images back to
    // their legacy thumbnail provenance, then verify the actual served bytes.
    const budgetAssets=await(await fetch(origin+'/request-assets.json')).json();
    const derivedPaths=new Map(Object.entries(budgetAssets.assets).map(([from,to])=>[to,from]));
    const checkedOriginals=new Map();
    const assertLocalImage=async(url,path)=>{
      const served=url.startsWith(origin+'/')?url.slice(origin.length):url;
      const local=derivedPaths.get(served)||served;
      if(served.startsWith('/assets/')){
        const bytes=Buffer.from(await(await fetch(origin+served)).arrayBuffer());
        assert.equal(createHash('sha256').update(bytes).digest('hex'),served.split('/').pop().split('.')[0],`${path}: derived image content hash mismatch`);
      }
      if(local.startsWith(PINNED))return;
      assert.ok(local.startsWith(THUMBS),`${path}: image outside ${PINNED} / ${THUMBS}: ${url}`);
      const original=originalOf.get(local);
      assert.ok(original,`${path}: thumbnail without pinned original in the build thumbnail map: ${local}`);
      const hash=s=>s.split('/').pop().match(/^([0-9a-f]{64})/)?.[1];
      assert.ok(hash(local)&&hash(local)===hash(original),`${path}: thumbnail ${local} is not derived from ${original}`);
      if(!checkedOriginals.has(original)){const r=await fetch(origin+original);await r.arrayBuffer();checkedOriginals.set(original,r.ok&&/^image\//.test(r.headers.get('content-type')||''));}
      assert.ok(checkedOriginals.get(original),`${path}: pinned original is not served: ${original}`);
    };
    const results=[];
    for(const path of ['/catalog','/catalog/landscape-gardening','/catalog-tree','/tree/darina']) {
      await command('Page.navigate',{url:origin+path});
      let state;
      for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,50));state=await evaluate(`({ready:document.readyState,path:location.pathname,scriptRan:!!window.__LE_STOREFRONT_CONFIG__,images:[...document.querySelectorAll('[data-storefront-image] img')].map(i=>({url:i.getAttribute('src'),current:i.currentSrc,srcset:(i.getAttribute('srcset')||'').split(',').map(c=>c.trim().split(/\\s+/)[0]).filter(Boolean),loaded:i.complete&&i.naturalWidth>0})),price:document.querySelector('.price-button-wrapper__product__cms .price')?.textContent,title:document.querySelector('h1')?.textContent,cards:document.querySelectorAll('[data-storefront-variants]').length})`);if(state.path===path&&state.ready==='complete'&&state.images.length&&state.images.every(i=>i.loaded))break;}
      assert.equal(state.scriptRan,false);assert.ok(state.images.length>0,path);assert.ok(state.images.every(i=>i.loaded),path);for(const image of state.images)for(const url of [image.url,image.current,...image.srcset])await assertLocalImage(url,path);
      if(path==='/tree/darina'){assert.equal(Number(state.price.replace(/\D/g,'')),expectedPrice);if(screenshot){const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(screenshot,Buffer.from(shot.data,'base64'));}}
      results.push({path,images:state.images.length,thumbnails:state.images.filter(i=>i.url.startsWith(THUMBS)).length,loaded:true,jsDisabled:true,price:state.price,title:state.title,cards:state.cards});
    }
    assert.ok(!external.has('mgnotvaahftrbifqtahf.supabase.co'));assert.ok(!external.has('lady-elka.ru'));return {results,externalHosts:[...external]};
  } finally {
    ws?.close(); const closed=new Promise(r=>child.once('close',r));try{process.kill(-child.pid,'SIGTERM')}catch{};await closed;await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
