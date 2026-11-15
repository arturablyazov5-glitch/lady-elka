import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createHmac} from 'node:crypto';
import {forwardSitePublish} from '../server/site-publish.mjs';
async function controller(request){
 const elements=new Map(),events=new Map(),timers=[];
 function element(id){if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},hidden:true,disabled:false,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){this.focused=true;},removeAttribute(name){delete this[name];}});return elements.get(id);}
 let now=1000;
 const root={querySelector:s=>element(s.slice(1))},listen={addEventListener:(n,fn)=>events.set(n,fn)};
 const source=await fs.readFile('app/public/js/app.js','utf8');
 const block=source.slice(source.indexOf('// BEGIN SITE PUBLISH CONTROLLER'),source.indexOf('// END SITE PUBLISH CONTROLLER'));
 const context={Date,Promise};vm.createContext(context);vm.runInContext(block,context);
 const result=context.initSitePublishing({request,root,listen,clock:()=>now,schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{}});
 return {element,events,timers,result,advance:ms=>{now+=ms;}};
}
test('publish button confirms before POST, prevents duplicates and displays accepted separately from completed',async()=>{
 let release;const calls=[];const c=await controller((route,init)=>{calls.push({route,init});return route.endsWith('publish-site')?new Promise(r=>release=r):Promise.resolve({lastRun:{date:'2026-10-10T08:00:00Z',status:'queued',url:'https://github.com/arturablyazov5-glitch/lady-elka-cloud-preview/actions/runs/23'}});});
 c.element('publish-site').handlers.click();assert.equal(c.element('publish-confirm').open,true);assert.equal(calls.length,0);
 c.element('publish-cancel').handlers.click();assert.equal(c.element('publish-confirm').open,false);assert.equal(calls.length,0);
 c.element('publish-site').handlers.click();const pending=c.element('publish-confirm-submit').handlers.click();
 assert.equal(c.element('publish-site').disabled,true);assert.equal(c.element('publish-feedback').dataset.state,'pending');
 await c.element('publish-confirm-submit').handlers.click();assert.equal(calls.length,1);
 release({message:'Запрос принят, ожидайте'});await pending;
 assert.equal(c.element('publish-feedback').dataset.state,'accepted');assert.match(c.element('publish-status').textContent,/В очереди/);assert.equal(c.element('publish-run-link').hidden,false);
 assert.equal(c.element('publish-site').focused,true);assert.equal(c.element('publish-site').disabled,true);
 c.advance(60000);c.timers.find(t=>t.ms===60000).fn();assert.equal(c.element('publish-site').disabled,false);
});
test('publish UI: throttle, missing token, network failure, skipped workflow and unsafe URLs',async()=>{
 for(const [http,state,wait] of [[429,'limited',37],[503,'error',0],[502,'error',60]]){
  const c=await controller(async()=>{throw Object.assign(new Error('Понятная ошибка'),{status:http,retryAfter:37});});
  c.element('publish-site').handlers.click();await c.element('publish-confirm-submit').handlers.click();
  assert.equal(c.element('publish-feedback').textContent,'Понятная ошибка');assert.equal(c.element('publish-feedback').dataset.state,state);assert.equal(c.element('publish-site').disabled,wait>0);
  if(wait)assert.ok(c.timers.some(t=>t.ms===wait*1000));
 }
 const c=await controller(async()=>({lastRun:{date:'2026-10-10T08:00:00Z',status:'success',conclusion:'skipped',url:'javascript:alert(1)'}}));await c.result.check();
 assert.match(c.element('publish-status').textContent,/Пропущена/);assert.equal(c.element('publish-run-link').hidden,true);assert.equal(c.element('publish-run-link').href,undefined);
});
test('publish status polling starts after authenticated catalog, uses 30-second timer, auth failure stops reads',async()=>{
 let count=0;const c=await controller(async()=>{count++;throw Object.assign(new Error('Войдите'),{status:401});});
 assert.equal(count,0);c.events.get('catalog-loaded')();await new Promise(r=>setImmediate(r));assert.equal(count,1);await c.timers.find(t=>t.ms===30000).fn();assert.equal(count,1);
});
test('publish dialog markup provides accessible description, cancel and status regions',async()=>{
 const html=await fs.readFile('app/public/index.html','utf8');
 assert.match(html,/<dialog id="publish-confirm" aria-labelledby="publish-confirm-title" aria-describedby="publish-confirm-description"/);
 assert.match(html,/Сайт пересоберётся за 5–10 минут, цены и данные каталога обновятся/);
 assert.match(html,/id="publish-cancel" autofocus/);assert.match(html,/id="publish-feedback" role="status" aria-live="polite"/);
});
test('local relay carries only catalog session and preserves throttling; no GitHub credential',async()=>{
 let called=0;const env={CATALOG_SESSION_SECRET:'synthetic-session',GITHUB_DISPATCH_TOKEN:'must-never-forward'};
 const r=await forwardSitePublish('/api/publish-site',{env,request:async(url,init)=>{
  called++;assert.equal(url,'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/catalog/api/publish-site');assert.equal(init.method,'POST');assert.equal(init.headers['X-Catalog-Request'],'1');
  const [payload,signature]=init.headers.Authorization.slice(7).split('.');assert.equal(signature,createHmac('sha256',env.CATALOG_SESSION_SECRET).update(payload).digest('base64url'));assert.ok(!JSON.stringify(init).includes(env.GITHUB_DISPATCH_TOKEN));
  return Response.json({error:'Слишком часто'},{status:429,headers:{'Retry-After':'42'}});
 }});assert.equal(r.status,429);assert.equal(r.headers['Retry-After'],'42');assert.equal(called,1);
 assert.equal((await forwardSitePublish('/api/publish-site',{env:{}})).status,503);
 assert.equal((await forwardSitePublish('/api/publish-status',{env,request:async()=>{throw new Error(env.GITHUB_DISPATCH_TOKEN);}})).status,502);
});
