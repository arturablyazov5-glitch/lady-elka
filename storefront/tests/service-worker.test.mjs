import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { buildServiceWorker } from '../client/build-service-worker.mjs';
const source = await readFile(new URL('../client/service-worker.js', import.meta.url), 'utf8');
const registration = await readFile(new URL('../client/register-service-worker.js', import.meta.url), 'utf8');
const digest = body => createHash('sha256').update(body).digest('hex');
const body = 'immutable css';
const path = '/assets/' + digest(body) + '.css';
const origin = 'https://shop.example';
const response = (text = body, options = {}) => {
  const r = new Response(text, { status: options.status || 200, headers: { 'Content-Type': options.mime || 'text/css', ...options.headers } });
  Object.defineProperty(r, 'type', { value: options.type || 'basic' });
  const nativeClone = r.clone.bind(r);
  r.clone = () => { const clone = nativeClone(); Object.defineProperty(clone, 'type', { value: options.type || 'basic' }); if (options.redirected) Object.defineProperty(clone, 'redirected', { value: true }); return clone; };
  if (options.redirected) Object.defineProperty(r, 'redirected', { value: true });
  return r;
};
function harness({ kill = false, release = 'a', fetchImpl = () => response(), broken = false, storage = new Map(), assets = { [path]: Buffer.byteLength(body) }, putImpl } = {}) {
  const handlers = {}, calls = [], lifecycle = [];
  const caches = {
    async keys() { return [...storage.keys()]; },
    async delete(name) { storage.delete(name); return true; },
    async open(name) {
      if (broken) throw Error('Storage disabled');
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name), key = r => typeof r === 'string' ? r : r.url;
      return { async match(r) { return entries.get(key(r))?.clone(); }, async put(r,v) { if (putImpl) await putImpl(); entries.set(key(r),v.clone()); },
        async keys() { return [...entries.keys()].map(url => new Request(url)); }, async delete(r) { return entries.delete(key(r)); } };
    }
  };
  vm.runInNewContext(source, { LE_SW_CONFIG: { kill, release, assets },
    self: { location: { origin }, addEventListener: (type,fn) => handlers[type] = fn,
      skipWaiting: async () => lifecycle.push('skip'), clients: { claim: async () => lifecycle.push('claim') },
      registration: { unregister: async () => lifecycle.push('unregister') } },
    caches, crypto: webcrypto, Headers, Request, Response, URL, Uint8Array,
    fetch: async r => { calls.push(r); return fetchImpl(r); } });
  async function lifecycleEvent(name) { const tasks = []; handlers[name]({ waitUntil: p => tasks.push(p) }); await Promise.all(tasks); }
  async function get(url = path, init = {}, mode, drain = true) {
    const request = new Request(new URL(url, origin), init);
    if (mode) Object.defineProperty(request, 'mode', { value: mode });
    let output; const tasks = [];
    handlers.fetch?.({ request, respondWith: p => output = p, waitUntil: p => tasks.push(p) });
    const result = await output; if (drain) await Promise.all(tasks); return drain ? result : { result, done: Promise.all(tasks) };
  }
  return { storage, calls, lifecycle, lifecycleEvent, get };
}
test('immutable cache first: first fetch saves hash, second performs no network including no-store policy', async () => {
  const h = harness({ fetchImpl: () => response(body, { headers: { 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', 'Content-Length': '9' } }) });
  await h.lifecycleEvent('activate');
  assert.equal(await (await h.get()).text(), body);
  assert.equal(await (await h.get()).text(), body);
  assert.equal(h.calls.length, 1);
  const cached = await h.get();
  assert.equal(cached.headers.get('Content-Encoding'), null);
  assert.equal(cached.headers.get('Content-Length'), null);
  assert.deepEqual(await (await h.get()).headers.get('X-LE-SW-Bytes'), String(body.length));
});
for (const [label,url,init,mode] of [
  ['Supabase feed','https://project.supabase.co/feed'], ['Supabase pay','https://project.supabase.co/pay',{method:'POST'}],
  ['POST',path,{method:'POST'}], ['PUT',path,{method:'PUT'}], ['HEAD',path,{method:'HEAD'}],
  ['Range',path,{headers:{Range:'bytes=0-10'}}], ['Authorization',path,{headers:{Authorization:'Bearer fixture'}}],
  ['sw.js','/sw.js'], ['mutable image','/photo.jpg'], ['JSON','/assets/'+digest(body)+'.json'],
  ['query',path+'?v=1'], ['video','/assets/'+digest(body)+'.mp4'], ['external','https://example.org'+path]
]) test('bypass ' + label, async () => { const h = harness(); assert.equal(await h.get(url,init,mode),undefined); assert.equal(h.calls.length,0); });
test('navigation always network only, no HTTP cache, no offline stale HTML or stored errors', async () => {
  const h = harness({fetchImpl:()=>response('fresh HTML',{mime:'text/html',status:404})});
  assert.equal((await h.get('/', {}, 'navigate')).status,404);
  assert.equal((await h.get('/', {}, 'navigate')).status,404);
  assert.equal(h.calls.length,2); assert.equal(h.calls[0].cache,'no-store'); assert.equal(h.storage.size,0);
});
for (const [label,opts,text] of [ ['404',{status:404}], ['503',{status:503}], ['206',{status:206}],
  ['opaque',{type:'opaque'}], ['redirect',{redirected:true}], ['HTML',{mime:'text/html'}],
  ['private',{headers:{'Cache-Control':'private'}}], ['Vary star',{headers:{Vary:'*'}}], ['wrong hash',{},'changed'],
  ['oversized',{},'x'.repeat(4*1024*1024+1)] ]) {
  test('never store ' + label, async () => { const h=harness({fetchImpl:()=>response(text,opts)}); await h.get(); await h.get(); assert.equal(h.calls.length,2); assert.equal(h.storage.get('le-static-v1').size,0); });
}
test('activation migrates legacy entries and prunes only URLs absent from manifest', async () => {
  const h=harness({release:'b'});
  h.storage.set('le-static-old-release',new Map([[origin+path,response()], [origin+'/obsolete',response()]]));
  h.storage.set('other-app',new Map());
  await h.lifecycleEvent('install'); assert.deepEqual(h.lifecycle,[]);
  await h.lifecycleEvent('activate'); assert.deepEqual([...h.storage.keys()],['other-app','le-static-v1']);
  assert.equal(await (await h.get()).text(),body); assert.equal(h.calls.length,0); assert.deepEqual(h.lifecycle,['claim']);
});
test('HTML-only rebuild preserves unchanged assets with zero downloads', async () => {
  const old=harness(); await old.get();
  const next=harness({release:'price-change', storage:old.storage}); await next.lifecycleEvent('activate');
  await next.get(); assert.equal(next.calls.length,0);
});
test('changed hash downloads only new file, keeps shared asset and removes obsolete file', async () => {
  const old=harness(); await old.get();
  const nextBody='new css', nextPath='/assets/'+digest(nextBody)+'.css';
  old.storage.get('le-static-v1').set(origin+'/assets/'+digest('obsolete')+'.css',response('obsolete'));
  const next=harness({storage:old.storage,assets:{[path]:body.length,[nextPath]:nextBody.length},fetchImpl:()=>response(nextBody)});
  await next.lifecycleEvent('activate'); await next.get(); await next.get(nextPath); await next.get(nextPath);
  assert.equal(next.calls.length,1); assert.deepEqual([...next.storage.get('le-static-v1').keys()],[origin+path,origin+nextPath]);
});
test('network response streams before cache write completes; event lifetime retains write', async () => {
  let release; const held=new Promise(resolve=>release=resolve);
  const h=harness({putImpl:()=>held});
  const {result,done}=await h.get(path,{},undefined,false);
  assert.equal(await result.text(),body);
  let finished=false; done.then(()=>finished=true); await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(finished,false); release(); await done; assert.equal((await h.get()).status,200);assert.equal(h.calls.length,1);
});
test('kill forces activation, clears all caches, unregisters and has no fetch handler', async () => {
  const h=harness({kill:true}); h.storage.set('le-static-v1',new Map()); h.storage.set('other-app',new Map());
  await h.lifecycleEvent('install'); await h.lifecycleEvent('activate');
  assert.equal(h.storage.size,0); assert.deepEqual(h.lifecycle,['skip','unregister']); assert.equal(await h.get(),undefined);
});
test('CacheStorage disabled still returns network response',async()=>{ const h=harness({broken:true}); assert.equal(await (await h.get()).text(),body); });
test('failed fetch is not stored; retry works',async()=>{let n=0;const h=harness({fetchImpl:()=>{if(!n++)throw Error('offline'); return response();}});await assert.rejects(h.get(),/offline/);assert.equal(await (await h.get()).text(),body);});
test('simultaneous requests coalesce to one fetch and independent responses',async()=>{const h=harness();const [a,b]=await Promise.all([h.get(),h.get()]);assert.equal(await a.text(),body);assert.equal(await b.text(),body);assert.equal(h.calls.length,1);});
test('entry and total byte budgets evict oldest',async()=>{
  const h=harness(); await h.lifecycleEvent('activate');
  const entries=h.storage.get('le-static-v1');
  for(let i=0;i<513;i++)entries.set(origin+'/assets/old-'+i,response('x',{headers:{'X-LE-SW-Bytes':'1'}}));
  await h.get();assert.equal(entries.size,512);assert.ok(!entries.has(origin+'/assets/old-0'));
  entries.clear(); for(let i=0;i<20;i++)entries.set(origin+'/assets/old-'+i,response('x',{headers:{'X-LE-SW-Bytes':String(4*1024*1024)}}));
  const restarted=harness({storage:h.storage}); await restarted.get();assert.ok(entries.size<=16);assert.ok(!entries.has(origin+'/assets/old-0'));
});
test('waiting worker supports future hash assets and verifies bytes without trusting a filename',async()=>{
  const next='new immutable';const h=harness({fetchImpl:()=>response(next)});const url='/assets/'+digest(next)+'.css';await h.get(url);await h.get(url);assert.equal(h.calls.length,1);
});
test('build release deterministic; changes with HTML, worker code inventory; emergency artifact generated; invalid hash fails',async()=>{
  const root=await mkdtemp(join(tmpdir(),'le-sw-unit-'));
  try{
    await mkdir(join(root,'assets'));await writeFile(join(root,path),body);await writeFile(join(root,'index.html'),'one');
    const a=await buildServiceWorker(root);assert.equal(await buildServiceWorker(root),a);
    assert.match(await readFile(join(root,'sw-kill.js'),'utf8'),/"kill":true/);
    await writeFile(join(root,'index.html'),'two');assert.notEqual(await buildServiceWorker(root),a);
    await writeFile(join(root,path),'invalid');await assert.rejects(buildServiceWorker(root),/checksum mismatch/);
  }finally{await rm(root,{recursive:true,force:true});}
});
function runRegistration({local=false,flag=false,mode='production',protocol='https:',supported=true,loaded=false}={}){
  const events={}, registrations=[], timers=[];
  const window={isSecureContext:true,__LE_SW_TEST__:flag,__LE_STOREFRONT_CONFIG__:{mode},addEventListener:(name,fn)=>events[name]=fn};
  const navigator=supported?{serviceWorker:{register:(url,options)=>{registrations.push({url,options});return Promise.resolve();}}}:{};
  vm.runInNewContext(registration,{window,navigator,location:{hostname:local?'localhost':'shop.example',protocol},document:{readyState:loaded?'complete':'loading'},setTimeout:fn=>timers.push(fn)});
  return {events,registrations,timers};
}
test('registration gated by production/HTTPS/capability and load/idle, local test requires flag',()=>{
  for(const options of [{mode:'preview'},{supported:false},{protocol:'http:'},{local:true}]) assert.equal(runRegistration(options).events.load,undefined);
  for(const options of [{},{local:true,flag:true,mode:'preview',protocol:'http:'}]){const h=runRegistration(options);assert.equal(h.registrations.length,0);h.events.load();assert.equal(h.registrations.length,0);h.timers[0]();assert.equal(h.registrations[0].url,'/sw.js');assert.equal(h.registrations[0].options.scope,'/');assert.equal(h.registrations[0].options.updateViaCache,'none');}
  const h=runRegistration({loaded:true});h.timers[0]();assert.equal(h.registrations.length,1);
});

test('HTTP cache seeding uses only-if-cached; a miss does not populate cache',async()=>{
  // Seeding is exercised separately because it uses an ExtendableMessageEvent.
  const handlers={}, calls=[];
  vm.runInNewContext(source,{LE_SW_CONFIG:{kill:false,release:'seed',assets:{}},self:{location:{origin},addEventListener:(name,fn)=>handlers[name]=fn},
    caches:{open:async()=>({match:async()=>undefined})},crypto:webcrypto,Headers,Request,Response,URL,Uint8Array,
    fetch:async r=>{calls.push(r);assert.equal(r.cache,'only-if-cached');assert.equal(r.mode,'same-origin');return response('',{status:504});}});
  let task;handlers.message({data:{type:'seed-http-cache',urls:[origin+path,origin+path,'https://project.supabase.co'+path,origin+'/sw.js',origin+'/plain.jpg']},waitUntil:p=>task=p});
  await task;assert.equal(calls.length,1);
});

test('optional previous artifact retains lazy old chunks, limits inherited history and verifies content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'le-sw-retain-'));
 try{
  for(const name of ['a','b','c'])await mkdir(join(root,name,'assets'),{recursive:true});
  const put=async(name,text)=>{const url='/assets/'+digest(text)+'.js';await writeFile(join(root,name,url),text);return url;};
  const a=await put('a','old lazy chunk');await buildServiceWorker(join(root,'a'));
  await rm(join(root,'a','immutable-manifest.json')); // pre-SW artifact fallback
  const b=await put('b','new lazy chunk');await buildServiceWorker(join(root,'b'),{previous:join(root,'a')});
  assert.equal(await readFile(join(root,'b',a),'utf8'),'old lazy chunk');
  const c=await put('c','third lazy chunk');await buildServiceWorker(join(root,'c'),{previous:join(root,'b')});
  const m=JSON.parse(await readFile(join(root,'c','immutable-manifest.json')));
  assert.ok(m.assets[b]);assert.ok(m.assets[c]);assert.ok(!m.assets[a]);
  await writeFile(join(root,'b',b),'broken');await assert.rejects(buildServiceWorker(join(root,'c'),{previous:join(root,'b')}),/checksum mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});
