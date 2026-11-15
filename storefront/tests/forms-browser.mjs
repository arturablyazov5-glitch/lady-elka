// All page instances, actual Chrome + local HTTP + actual lead handler/SQL.
// Network is restricted to localhost; Telegram transport is synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeadHandler } from '../../supabase/functions/lead/handler.mjs';
import { leadDatabase } from '../../supabase/functions/lead/tests/database.mjs';
import { readFeedText } from '../products/build-feed.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const localGuardSource=await readFile('storefront/public/local-guard.js','utf8');
const inventory=JSON.parse(await readFile('agent-context/forms-inventory.json','utf8'));
const {db,request}=await leadDatabase();
const feeds=Object.fromEntries(await Promise.all(['trees','decor','promos'].map(async n=>[n,n === 'promos' ? 'code,type,value,active\n' : await readFeedText(n)])));
const server=spawn(process.execPath,['storefront/server.mjs','--mode=preview',...(process.env.LE_QA_ARTIFACT?['--root='+process.env.LE_QA_ARTIFACT]:[])],{env:{...process.env,STOREFRONT_PORT:'0'},stdio:['ignore','pipe','pipe']});
const profile=await mkdtemp(join(tmpdir(),'le-forms-chrome-'));
const evidence=[],posts=[],messages=[];let chrome,ws,proxy,forceError=false,origin;
const handler=createLeadHandler({env:k=>({SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',TG_BOT_TOKEN:'synthetic',TG_CHAT_IDS:'101,-100202',CORS_ORIGIN:origin}[k]),fetch:async(url,options)=>{
 if(url.startsWith('https://db.test/'))return request(url,options);
 assert.ok(['https://api.telegram.org/botsynthetic/sendMessage','https://api.telegram.org/botsynthetic/sendPhoto'].includes(url));
 const p=JSON.parse(options.body);messages.push(p);return Response.json({ok:true,result:{chat:{id:p.chat_id},message_id:messages.length}});
}});
let sequence=0;const pending=new Map();
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
try {
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server timeout')),10000);server.stdout.on('data',b=>{const m=b.toString().match(/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});server.once('exit',c=>reject(new Error('server exit '+c)));});
 proxy=createServer(async(req,res)=>{
  try {
   const path=new URL(req.url,'http://local.test').pathname;
   if(path==='/local-guard.js'){res.setHeader('Content-Type','application/javascript');res.end('// Isolated local forms fixture; external network blocked by Chrome.');return;}
   if(path==='/f/storefront-config.js') {res.setHeader('Content-Type','application/javascript');res.end(`window.__LE_STOREFRONT_CONFIG__=${JSON.stringify({mode:'preview',lead:'/functions/v1/lead',payment:null,catalog:Object.fromEntries(['trees','decor','promos'].map(n=>[n,'/__offline/catalog/'+n+'.csv']))})};`);return;}
   const feed=/^\/__offline\/catalog\/(trees|decor|promos)\.csv$/.exec(path);
   if(feed){res.setHeader('Content-Type','text/csv');res.end(feeds[feed[1]]);return;}
   if(path==='/functions/v1/lead') {
    let body='';for await(const b of req)body+=b;posts.push(JSON.parse(body));await delay(60);
    if(forceError){forceError=false;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,message:'Тестовая ошибка'}));return;}
    const result=await handler(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',origin,'x-forwarded-for':'fixture-'+posts.length},body}));
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
   }
   const result=await fetch('http://127.0.0.1:'+port+req.url,{redirect:'manual'});
   const bytes=Buffer.from(await result.arrayBuffer());const text=bytes.toString().replace(localGuardSource.trim(),'// Local-only lead fixture; external transport blocked by Chrome proxy.');const isConfig=(result.headers.get('content-type')||'').includes('javascript') && /^window\.__LE_STOREFRONT_CONFIG__=/.test(text);const body=isConfig?Buffer.from(text.replace(/^window\.__LE_STOREFRONT_CONFIG__=[^\n]*\n/,`window.__LE_STOREFRONT_CONFIG__=${JSON.stringify({mode:'preview',lead:'/functions/v1/lead',payment:null,catalog:Object.fromEntries(['trees','decor','promos'].map(n=>[n,'/__offline/catalog/'+n+'.csv']))})};\n`)):bytes;const headers=Object.fromEntries(result.headers);delete headers['content-length'];res.writeHead(result.status,headers);res.end(body);
  }catch{res.writeHead(500);res.end('local fixture error');}
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+proxy.address().port;
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-quic','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
 const endpoint=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(new Error('chrome timeout')),15000);chrome.stderr.on('data',b=>{s+=b;const m=s.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});chrome.once('error',reject);});
 const pages=await(await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 await command('Page.enable');await command('Runtime.enable');await command('Network.enable');
 let count=0;
 for(const route of [...new Set(inventory.leads.map(f=>f.route))]) {
  const previous=await evaluate('performance.timeOrigin');await command('Page.navigate',{url:origin+route});
  for(let i=0;i<200;i++){if(await evaluate(`performance.timeOrigin!==${previous} && document.readyState==='complete' && [...document.querySelectorAll('[data-lead-type]')].every(f=>!f.querySelector('[data-form-submit-notice]'))`))break;if(i===199)throw new Error('load timeout '+route);await delay(30);}
  await evaluate(`document.querySelector('form[data-lead-type]')?.dispatchEvent(new Event('pointerdown',{bubbles:true}))`);
  for(let i=0;i<250;i++){if(await evaluate(`[...document.querySelectorAll('[data-lead-enable]')].every(b=>!b.disabled)`))break;if(i===249)throw new Error('demand runtime timeout '+route);await delay(20);}
  const forms=inventory.leads.filter(f=>f.route===route);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-lead-type]')].map(f=>f.id).sort()"),forms.map(f=>f.id).sort());
  for(const entry of forms){
   const id=JSON.stringify(entry.id),phone='+7999'+String(++count).padStart(7,'0');
   const filled=await evaluate(`(()=>{const f=document.getElementById(${id});const modal=f.closest('.pop-up');if(modal){modal.style.display='flex';modal.setAttribute('aria-hidden','false');}for(const c of f.querySelectorAll('[data-lead-field]')){const k=c.dataset.leadField;if(c.type==='checkbox')c.checked=true;else c.value=({name:'ТЕСТ browser',email:'qa@example.test',phone:${JSON.stringify(phone)},comment:'ТЕСТ вопрос <b>&',city:'Москва',business:'Дизайн'})[k];}return [...f.querySelectorAll('[data-lead-field]')].every(c=>c.name===c.dataset.leadField)})()`);assert.equal(filled,true);
   const before=posts.length;
   await evaluate(`(()=>{const f=document.getElementById(${id});f.querySelector('[data-lead-field=consent]').checked=false;f.requestSubmit()})()`);await delay(20);assert.equal(posts.length,before,'consent '+route);
   await evaluate(`(()=>{const f=document.getElementById(${id});f.querySelector('[data-lead-field=consent]').checked=true;f.querySelector('[data-lead-field=phone]').value='123';f.requestSubmit()})()`);await delay(20);assert.equal(posts.length,before,'phone '+route);
   await evaluate(`document.getElementById(${id}).querySelector('[data-lead-field=phone]').value=${JSON.stringify(phone)}`);
   if(count===1){
    forceError=true;
    await evaluate(`document.getElementById(${id}).requestSubmit()`);
    for(let i=0;i<200;i++){if(await evaluate(`document.getElementById(${id}).querySelector('[data-form-submit-notice]').textContent.includes('Сервис временно недоступен')`))break;if(i===199)throw new Error('error timeout: '+JSON.stringify(await evaluate(`({notice:document.getElementById(${id}).querySelector('[data-form-submit-notice]').textContent,config:window.__LE_STOREFRONT_CONFIG__,fields:[...document.getElementById(${id}).querySelectorAll('[data-lead-field]')].map(e=>({key:e.dataset.leadField,value:e.value,checked:e.checked,invalid:e.getAttribute('aria-invalid')}))})`)));await delay(20);}
    assert.equal(await evaluate(`document.getElementById(${id}).querySelector('[data-lead-field=phone]').value`),phone);
   }
   const beforeSuccess=posts.length;
   await evaluate(`(()=>{const f=document.getElementById(${id});f.requestSubmit();f.requestSubmit()})()`);
   assert.equal(await evaluate(`document.getElementById(${id}).querySelector('button[type=submit]').disabled`),true);
   for(let i=0;i<250;i++){if(await evaluate(`document.getElementById(${id}).querySelector('[data-form-submit-notice]').textContent.includes('Заявка принята')`))break;if(i===249)throw new Error('success timeout '+route+' '+entry.id+': '+await evaluate(`document.getElementById(${id}).querySelector('[data-form-submit-notice]').textContent`));await delay(20);}
   assert.equal(posts.length,beforeSuccess+1,'double submit '+route);
   if(count===1)assert.equal(posts[0].id,posts[1].id,'retry must reuse ID');
   assert.equal(posts.at(-1).type,entry.type);assert.equal(posts.at(-1).page,await evaluate('location.href'));assert.equal(posts.at(-1).phone.replace(/\D/g,''),phone.replace(/\D/g,''));
   assert.equal(await evaluate(`document.getElementById(${id}).querySelector('[data-lead-field=phone]').value`),'');
   evidence.push({...entry,consent:true,phoneValidation:true,doubleSubmit:true,success:true});
  }
  if(count%20<forms.length)console.log('Verified forms:',count);
 }
 assert.equal(messages.length,count*2);
 const persisted=(await db.query('select count(*)::int as n from le_leads')).rows[0].n;assert.equal(persisted,count);
 const report={forms:count,routes:new Set(inventory.leads.map(f=>f.route)).size,persisted,telegram:'synthetic only',errorRetry:true,evidence};
 await writeFile('agent-context/forms-browser-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,evidence:undefined}));
}finally{
 if(ws)ws.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('shutdown'));}pending.clear();
 if(chrome){try{process.kill(-chrome.pid,'SIGTERM');}catch{chrome.kill();}}server.kill();
 if(proxy)await new Promise(r=>proxy.close(r));await db.close();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{});
}
