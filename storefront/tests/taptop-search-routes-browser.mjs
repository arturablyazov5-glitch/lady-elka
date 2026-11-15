// Real offline artifact in an ephemeral Chrome. Run only against an isolated copy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { interceptionLifecycle } from './browser-interception-lifecycle-helper.mjs';
const root = process.env.LE_ROUTES_QA_ROOT;
assert.ok(root?.startsWith('/tmp/') || root?.startsWith('/private/tmp/'), 'An isolated TEMP project is required');
const server = spawn(process.execPath, ['--import','data:text/javascript,globalThis.fetch=()=>{throw new Error("Server network forbidden")}',join(root,'storefront/server.mjs'),'--mode=preview','--emulate-host'], {env:{...process.env,STOREFRONT_PORT:'0'},stdio:['ignore','pipe','pipe']});
const profile = await mkdtemp(join(tmpdir(),'le-routes-chrome-'));
let chrome, ws, lifecycle;
const evidence=[], blocked=[], requests=[], slashRedirects=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const command=(method,params={})=>lifecycle.command(method,params);
const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const until=async expression=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await delay(30);}throw new Error(`Timeout: ${expression}; state=${JSON.stringify(await evaluate("({url:location.href,title:document.title,active:document.activeElement?.tagName,results:document.querySelector(\".search-result__list\")?.textContent,errors:window.__qaErrors})"))}`);};
try {
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server timeout')),10000);server.stdout.on('data',b=>{const m=b.toString().match(/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});server.once('exit',code=>reject(new Error(`server exit ${code}`)));});
 const origin=`http://127.0.0.1:${port}`;
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-quic','--disable-domain-reliability','--metrics-recording-only','--disable-features=MediaRouter,OptimizationHints','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
 const endpoint=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(new Error('Chrome timeout')),15000);chrome.stderr.on('data',b=>{s+=b;const m=s.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});chrome.once('error',reject);});
 const pages=await(await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Network.requestWillBeSent' && message.params.redirectResponse?.status === 308) slashRedirects.push(message.params.redirectResponse.url); });
 lifecycle=interceptionLifecycle(ws,{origin,requests,blocked});
 await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await command('Network.setBypassServiceWorker',{bypass:true});await command('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
 await command('Page.addScriptToEvaluateOnNewDocument',{source:'window.__qaErrors=[];addEventListener("error",e=>__qaErrors.push(e.message));'});
 const navigate=async path=>{const previous=await evaluate('performance.timeOrigin');await command('Page.navigate',{url:origin+path});await until(`performance.timeOrigin!==${previous} && document.readyState==='complete'`);};
 const cards=()=>evaluate(`([...document.querySelectorAll('[data-storefront-product]')].filter(e=>e.getBoundingClientRect().height>0).length)`);
 // Intentional Timeweb directory URLs: links and GET search submit directly to the slash form.
 // Expected = cards generated into the artifact from the active snapshot (new cabinet products are appended by the build).
 const catalogCards=(await readFile(join(root,'storefront/dist/catalog/index.html'),'utf8')).match(/<div\b[^>]*data-storefront-product="/g).length;assert.ok(catalogCards>=19);
 await navigate('/catalog/');assert.equal(await cards(),catalogCards);assert.deepEqual(await evaluate('__qaErrors'),[]);evidence.push({route:'/catalog/',visibleCards:catalogCards});
 const previous=await evaluate('performance.timeOrigin');await command('Page.reload',{ignoreCache:true});await until(`performance.timeOrigin!==${previous} && document.readyState==='complete'`);assert.equal(await cards(),catalogCards);evidence.push({route:'/catalog/',reload:true,visibleCards:catalogCards});
 await evaluate(`document.querySelectorAll('.pop-up[aria-hidden="false"]').forEach(e=>e.style.display='none');const input=[...document.querySelectorAll('form[action="/search/"] input[name="search"]')].find(e=>e.getBoundingClientRect().height>0);input.value='Миранда';input.focus();`);
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await until(`location.pathname==='/search/' && document.querySelector('.search-result__list > *')?.textContent.includes('Миранда')`);assert.equal(await evaluate(`document.querySelector('.search-result__list a').getAttribute('href')`),'/tree/miranda/');evidence.push({search:'Миранда',keyboardSubmit:true,route:'/search/',first:'/tree/miranda/'});
 for(const [query,expected] of [['каталог','/catalog/'],['туя','/tree/tuya-smaragd/']]){await navigate('/search/?search='+encodeURIComponent(query));await until(` [...document.querySelectorAll('.search-result__list a')].some(a=>a.getAttribute('href')===${JSON.stringify(expected)})`);const links=await evaluate(`[...document.querySelectorAll('.search-result__list a')].map(a=>a.getAttribute('href'))`);assert.ok(links.includes(expected),JSON.stringify({query,links}));evidence.push({search:query,links});}
 await navigate('/search/?search=zzzz_no_such_product');await until(`document.querySelector('.search-result__list')?.textContent==='Ничего не найдено'`);evidence.push({search:'no-results',text:'Ничего не найдено'});
 await navigate('/search/');await until(`document.querySelector('.search-result__list')?.textContent==='Введите запрос'`);evidence.push({search:'empty',text:'Введите запрос'});
 for(const route of ['/catalog/landscape-gardening/','/catalog-tree/','/spasibo/','/pay-return/?fail=1&oid=synthetic','/testy/']){await navigate(route);assert.deepEqual(await evaluate('__qaErrors'),[],route);const state=await evaluate(`({title:document.title,h1:document.querySelector('h1')?.textContent,cards:[...document.querySelectorAll('[data-storefront-product]')].filter(e=>e.getBoundingClientRect().height>0).length})`);if(route.includes('catalog'))assert.ok(state.cards>0);if(route.includes('pay-return'))assert.equal(state.h1,'Оплата не завершена');evidence.push({route,...state});}
 await navigate('/catalog/');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});assert.equal(await evaluate(`getComputedStyle(document.querySelector('.storefront-menu-mobile')).display`),'inline');const menu=await evaluate(`document.querySelector('.menu__burger-button').click();document.querySelector('.menu').classList.contains('is-opened')`);assert.equal(menu,true);await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await evaluate(`document.querySelector('.menu').classList.contains('is-opened')`),false);evidence.push({mobileMenu:true,escapeCloses:true});
 assert.ok(!requests.some(r=>r.method==='HEAD'),'Fast search HEAD probing remains');assert.ok(!requests.some(r=>r.method!=='GET'),'Unexpected write');assert.equal(blocked.length,0);
 await evaluate(`document.querySelectorAll('.pop-up[aria-hidden="false"]').forEach(e=>e.style.display='none');document.querySelector('.buy-btn').focus()`);
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
 assert.equal(await evaluate(`document.querySelector('[data-cart-popup]').getAttribute('aria-hidden')`),'false');
 assert.equal(await evaluate(`document.querySelectorAll('[data-cart-items] [data-cart-index]').length`),1);
 evidence.push({cartKeyboard:true,ownPopupHook:true,cartRows:1});
 await navigate('/o-nas/');await evaluate(`document.querySelector('[data-cart-open]').click()`);assert.equal(await evaluate(`document.querySelectorAll('[data-cart-items] [data-cart-index]').length`),1);evidence.push({route:'/o-nas/',cartRestored:true});
 await navigate('/search/p/1/?search='+encodeURIComponent('туя'));await until(`document.querySelector('.search-result__list a')!==null`);evidence.push({searchPagination:true,links:await evaluate(`[...document.querySelectorAll('.search-result__list a')].map(a=>a.getAttribute('href'))`)});
 await lifecycle.drain();
 assert.deepEqual(slashRedirects, [], 'internal navigation/search must never incur host 308');
 const report={browser:await command('Browser.getVersion'),slashRedirects:slashRedirects.length,scenarios:evidence.length,evidence,externalRequests:blocked,writes:0,headProbes:0};
 if(process.env.LE_ROUTES_QA_REPORT)await writeFile(process.env.LE_ROUTES_QA_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {
 lifecycle?.stop();ws?.close();
 if(chrome?.pid){const signal=s=>{try{process.kill(-chrome.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}};signal('SIGTERM');await delay(700);signal('SIGKILL');await delay(400);}
 server.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
