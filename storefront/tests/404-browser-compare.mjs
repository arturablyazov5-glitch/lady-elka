// Live source/local screenshots in one Chrome renderer; freezes only the online-dot animation.
// Usage: node storefront/tests/404-browser-compare.mjs http://127.0.0.1:PORT
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const origin=process.argv[2] || 'http://127.0.0.1:4199';
const out=join(process.cwd(),'storefront/audit/404');await mkdir(out,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'le404-chrome-'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--force-color-profile=srgb','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
const endpoint=await new Promise((r,j)=>{let s='';chrome.stderr.on('data',b=>{s+=b;const m=s.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)r(m[1]);});setTimeout(()=>j(Error('timeout')),15000).unref();});
const pages=await (await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/,'/json/list'))).json();
const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let seq=0;const pending=new Map();const requests=[];const responses=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);else if(m.method==='Network.responseReceived')responses.push(m.params);};
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>(await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
try{
await command('Page.enable');await command('Runtime.enable');await command('Network.enable');
const results=[];
// Warm the source and local font/image decode caches before pixel capture.
for(const url of ['https://lady-elka.ru/qwerty-404-test',origin+'/qwerty-404-test']){
await command('Page.navigate',{url});
for(let i=0;i<200;i++){if(await evaluate("document.readyState==='complete' && !!document.querySelector('.page404')"))break;await new Promise(r=>setTimeout(r,100));}
await evaluate("Promise.all([document.fonts.ready,...[...document.images].map(i=>i.decode().catch(()=>null))])");await new Promise(r=>setTimeout(r,1000));
}

for(const width of [320,390,1280]){
await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
for(const [name,url] of [['original','https://lady-elka.ru/qwerty-404-test'],['copy',origin+'/qwerty-404-test']]){
requests.length=0;responses.length=0;await command('Page.navigate',{url});
for(let i=0;i<200;i++){if(await evaluate("document.readyState==='complete' && !!document.querySelector('.page404')"))break;await new Promise(r=>setTimeout(r,100));}
await evaluate("Promise.all([document.fonts.ready,...[...document.images].map(i=>i.decode().catch(()=>null))])");
await new Promise(r=>setTimeout(r,1000));
// Verify the exact source footer image response against its local copy before capture.
if(name==='original')for(const response of responses)if(response.response.url.includes('frame_62285_1.png')){
  const body=await command('Network.getResponseBody',{requestId:response.requestId});
  const sourceBytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');
  const localBytes=await readFile(join(process.cwd(),'storefront/public/f/404-assets/5cb34d26d26a-frame_62285_1.webp'));
  assert.deepEqual(sourceBytes,localBytes,'Source/local footer asset bytes');
}
// Settle both renderers after the same resize/repaint sequence (image resampling cache).
await command('Emulation.setDeviceMetricsOverride',{width:width+1,height:900,deviceScaleFactor:1,mobile:false});
await new Promise(r=>setTimeout(r,100));
await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
await new Promise(r=>setTimeout(r,500));
// Freeze only the two pulsing dots, preserving their unanimated source styling.
await evaluate(`(() => {for(const dot of document.querySelectorAll('.dot-online__work')){const frozen=dot.cloneNode(true);frozen.removeAttribute('style');frozen.style.setProperty('transform','none','important');frozen.style.setProperty('translate','none','important');frozen.style.setProperty('rotate','none','important');frozen.style.setProperty('scale','none','important');dot.replaceWith(frozen);}})()`);
await new Promise(r=>setTimeout(r,2000));
const data=await evaluate("({title:document.title,robots:document.querySelector('meta[name=robots]').content,width:innerWidth,height:document.documentElement.scrollHeight,up:document.querySelector('.up-button').outerHTML,broken:[...document.images].filter(i=>!i.naturalWidth).map(i=>i.src),rects:[...document.querySelectorAll('.header,.page404,.page404__content,.footer')].map(e=>({class:e.className,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))})");
const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:data.height,scale:1}});await writeFile(join(out,`${name}-${width}.png`),Buffer.from(shot.data,'base64'));
for(const scenario of ['menu','modal']) {
  if(scenario==='menu' && width===1280)continue;
  await evaluate(scenario==='menu'?"document.querySelector('.menu__burger-button').click()":"document.querySelector('[data-action-element=\"inachtynm_0\"]').click()");
  await new Promise(r=>setTimeout(r,500));
  const state=await evaluate("({menu:document.querySelector('.menu').className,fixed:getComputedStyle(document.querySelector('.menu__fixed-wrapper')).display,modal:getComputedStyle(document.querySelector('.pop-up')).display})");
  const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(out,`${name}-${scenario}-${width}.png`),Buffer.from(shot.data,'base64'));
  console.log(name,scenario,width,state);
  await evaluate(scenario==='menu'?"document.querySelector('.menu__close-button').click()":"document.querySelector('.pop-up__inside-close-button').click()");
}
results.push({name,width,...data,externalRequests:name==='copy'?requests.filter(u=>!u.startsWith(origin)):undefined});
console.log(name,width,data.height);
}
}
await writeFile(join(out,'browser-report.json'),JSON.stringify(results,null,2)+'\n');
}finally{ws.close();const closed=new Promise(r=>chrome.once('close',r));chrome.kill('SIGTERM');await closed;await rm(profile,{recursive:true,force:true});}

const {default:sharp}=await import('sharp');
const report=[];
for(const width of [320,390,1280])for(const scenario of ['', 'menu-', 'modal-']){
  if(scenario==='menu-' && width===1280)continue;
  const original=sharp(join(out,`original-${scenario}${width}.png`));
  const copy=sharp(join(out,`copy-${scenario}${width}.png`));
  const [am,bm]=await Promise.all([original.metadata(),copy.metadata()]);
  const height=Math.max(am.height,bm.height);
  const [ap,bp]=await Promise.all([original.extend({bottom:height-am.height,background:'#ff00ff'}).ensureAlpha().raw().toBuffer(),copy.extend({bottom:height-bm.height,background:'#ff00ff'}).ensureAlpha().raw().toBuffer()]);
  const diff=Buffer.alloc(ap.length);let differentPixels=0,maxChannelDifference=0;
  for(let i=0;i<ap.length;i+=4){let changed=false;for(let c=0;c<3;c++){diff[i+c]=Math.abs(ap[i+c]-bp[i+c]);maxChannelDifference=Math.max(maxChannelDifference,diff[i+c]);changed ||= diff[i+c]!==0;}diff[i+3]=255;if(changed)differentPixels++;}
  await sharp(diff,{raw:{width,height,channels:4}}).png().toFile(join(out,`diff-${scenario}${width}.png`));
  report.push({width,scenario:scenario.replace('-','')||'page',originalHeight:am.height,copyHeight:bm.height,differentPixels,totalPixels:width*height,maxChannelDifference});
}
await writeFile(join(out,'pixel-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

for(const item of report) assert.equal(item.differentPixels,0,`${item.width} ${item.scenario}: see pixel-report.json`);
