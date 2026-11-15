// Isolated native Chromium proof: real owned form + current client modules, no live requests.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {annotateLeadForms} from '../../storefront/client/lead-schema.js';
const raw=await readFile('storefront/components/question-form-section.html','utf8');
const form=annotateLeadForms(raw.match(/<form\b[^]*?<\/form>/)[0]);
const requests=[],posts=[];let fail=true;
const server=createServer(async(req,res)=>{requests.push({method:req.method,url:req.url});
 if(req.url==='/lead'){let body='';for await(const b of req)body+=b;posts.push(JSON.parse(body));res.writeHead(fail?502:200,{'Content-Type':fail?'text/html':'application/json'});res.end(fail?'<html>gateway</html>':'{"ok":true}');return;}
 if(/^\/client\/[a-z-]+\.js$/.test(req.url)){res.setHeader('Content-Type','text/javascript');res.end(await readFile('storefront'+req.url));return;}
 res.setHeader('Content-Type','text/html');res.end(`<html><body>${form}<script>window.__LE_STOREFRONT_CONFIG__={lead:'/lead'};</script><script type="module">import {initForms} from '/client/forms.js';initForms();window.mounted=true;</script></body></html>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const profile=await mkdtemp('/private/tmp/le-review-chrome-');let ws;const pending=new Map();
const child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
try{
 const endpoint=await new Promise((ok,fail)=>{let s='';const timer=setTimeout(()=>fail(Error('Chrome timeout')),15000);child.stderr.on('data',b=>{s+=b;const m=/DevTools listening on (ws:\/\/\S+)/.exec(s);if(m){clearTimeout(timer);ok(m[1]);}});child.once('error',fail);});
 const pages=await(await fetch(endpoint.replace('ws://','http://').replace(/\/devtools\/browser\/.*/,'/json/list'))).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 let seq=0;const cmd=(method,params={})=>new Promise((ok,fail)=>{const id=++seq,timer=setTimeout(()=>fail(Error('CDP timeout '+method)),15000);pending.set(id,{ok,fail,timer});ws.send(JSON.stringify({id,method,params}));});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.fail(Error(m.error.message)):p.ok(m.result);}}};
 const evaluate=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
 const wait=async expression=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,20));}throw Error('Browser wait timeout');};
 await cmd('Page.enable');await cmd('Emulation.setScriptExecutionDisabled',{value:true});await cmd('Page.navigate',{url:origin+'/no-js'});await wait("document.readyState==='complete' && location.pathname==='/no-js'");
 const nojs=await evaluate(`(()=>{const f=document.querySelector('form'),b=f.querySelector('[type=submit]');f.querySelector('[type=tel]').value='+79990000000';f.querySelector('[data-lead-field=comment]').value='QA';f.querySelector('[type=checkbox]').checked=true;f.querySelector('[type=tel]').focus();return {method:f.method,disabled:b.disabled,mounted:!!window.mounted}})()`);assert.deepEqual(nojs,{method:'post',disabled:true,mounted:false});
 const before=requests.length;await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await new Promise(r=>setTimeout(r,100));assert.equal(requests.length,before);assert.equal(posts.length,0);
 await cmd('Emulation.setScriptExecutionDisabled',{value:false});await cmd('Page.addScriptToEvaluateOnNewDocument',{source:"AbortSignal.timeout=undefined;crypto.randomUUID=undefined;"});await cmd('Page.navigate',{url:origin+'/old-browser'});await wait('window.mounted===true');
 await evaluate(`(()=>{const f=document.querySelector('form');f.querySelector('[data-lead-field=comment]').value='QA';f.querySelector('[type=tel]').value='+79990000000';f.querySelector('[type=checkbox]').checked=true;f.requestSubmit();})()`);await wait("document.querySelector('[data-form-submit-notice]')?.textContent.includes('временно')");assert.equal(posts.length,1);assert.match(posts[0].id,/^[a-f0-9-]{36}$/);
 fail=false;await evaluate("document.querySelector('form').requestSubmit()");await wait("document.querySelector('[data-form-submit-notice]')?.textContent.includes('Заявка принята')");assert.equal(posts.length,2);assert.equal(posts[0].id,posts[1].id);assert.ok(requests.every(r=>!r.url.includes('?')));
 await writeFile('agent-context/review-autosync-forms-browser.json',JSON.stringify({nojs,enterDidNotSubmit:true,legacyAPIsRemoved:true,gateway502HumanMessage:true,retrySameId:true,posts:posts.length,externalRequests:0},null,2)+'\n');console.log('Browser proof passed: no-JS Enter, legacy API submit, HTML 502, same-ID retry.');
}finally{ws?.close();for(const p of pending.values())clearTimeout(p.timer);const closed=new Promise(r=>child.once('close',r));try{process.kill(-child.pid,'SIGTERM');}catch{}await closed;await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
