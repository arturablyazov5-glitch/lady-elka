import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
const out='release-candidates/legacy-price-hotfix/';
const raw=await readFile('/tmp/le-live-incident.html','utf8');
const bundle=await readFile(out+'catalog.js','utf8');
const csv=await readFile('/tmp/le-incident-trees.csv','utf8');
const html=raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>','<script src="/fixture.js"></script><script src="/catalog.js"></script></body>');
const server=http.createServer((req,res)=>{
 if(req.url==='/catalog.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle);}
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(`window.qaCalls=0; window.qaRequests=[]; const mode=new URLSearchParams(location.search).get('mode'); window.fetch=async(url,options={})=>{qaRequests.push({url:String(url),method:options.method||'GET'}); if(!String(url).endsWith('/trees.csv'))throw Error('blocked outside fixture');qaCalls++;if(mode==='fail'||(mode==='recover'&&qaCalls===1))return new Response('Unavailable',{status:503});return new Response(${JSON.stringify(csv)},{status:200});};`);}
 res.setHeader('Content-Type','text/html');res.end(html);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const profile=await mkdtemp('/tmp/le-legacy-price-chrome-');let ws;const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
try{
 const endpoint=await new Promise((resolve,reject)=>{let text='';chrome.stderr.on('data',b=>{text+=b;const m=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]);});chrome.once('error',reject);});
 const pages=await(await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/,'/json/list'))).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 let id=0;const pending=new Map();ws.onmessage=({data})=>{const msg=JSON.parse(data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(msg.error):p.resolve(msg.result);}else if(msg.method==='Fetch.requestPaused'){const p=msg.params;command(p.request.url.startsWith(origin)?'Fetch.continueRequest':'Fetch.failRequest',p.request.url.startsWith(origin)?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}};
 function command(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});}
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await command('Page.enable');await command('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 const results=[];
 for(const mode of ['recover','fail']){
 await command('Page.navigate',{url:origin+'/catalog?mode='+mode});
 let state;for(let n=0;n<200;n++){await new Promise(r=>setTimeout(r,50));state=await evaluate(`({calls:window.qaCalls,statuses:[...document.querySelectorAll('[data-price-status]')].map(c=>c.dataset.priceStatus)})`);if(state.calls>=2&&state.statuses?.length&&state.statuses.every(s=>s!=='loading'))break;}
 assert.ok(state.statuses.length);assert.ok(state.statuses.every(s=>s!=='loading'));assert.equal(state.calls,mode==='recover'?2:3);
 if(mode==='recover')assert.ok(state.statuses.includes('ready'));else assert.ok(state.statuses.every(s=>s==='error'));
 const detail=await evaluate(`(()=>{const c=document.querySelector('[data-price-status="${mode==='recover'?'ready':'error'}"]');const b=c.querySelector('.buy-btn');const before=localStorage.getItem('le_cart');b.click();return {price:b.dataset.price,status:c.dataset.priceStatus,text:c.querySelector('.price,[data-price-decor]')?.textContent,requests:qaRequests,storage:Object.fromEntries(Object.entries(localStorage))};})()`);
 if(mode==='fail')assert.equal(detail.price,undefined);else assert.ok(Number(detail.price)>0);
 assert.ok(detail.requests.every(r=>r.method==='GET'));results.push({mode,...state,...detail});
 }
 await writeFile(out+'browser-proof.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({mode,calls,statuses,price})=>({mode,calls,cards:statuses.length,ready:statuses.filter(s=>s==='ready').length,price}))));
}finally{ws?.close();server.close();try{process.kill(-chrome.pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,500));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
