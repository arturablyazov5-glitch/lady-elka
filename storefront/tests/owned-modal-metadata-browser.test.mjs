import test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isolatedWorkspace} from '../../scripts/offline-suite-isolated-workspace.mjs';
const run=promisify(execFile);
test('offline artifact modal keyboard, cookie, backdrop, defaultPrevented and inquiry native validation',async()=>{
 const root=resolve(import.meta.dirname,'../..');const workspace=await isolatedWorkspace(root);
 try{
  await run(process.execPath,['--import','data:text/javascript,globalThis.fetch=()=>{throw new Error("Offline")}', 'storefront/build.mjs','--mode=preview'],{cwd:workspace.directory});
  const base=await readFile(join(root,'storefront/tests/taptop-search-routes-browser.mjs'),'utf8');
  const extra=String.raw`
 await navigate('/');
 await evaluate("localStorage.removeItem('lady-elka-cookie-consent')");await navigate('/main');
 const cookie=await evaluate("document.querySelector('[data-cookie-consent=accept]').dataset.modalClose");
 assert.equal(await evaluate('document.getElementById('+JSON.stringify(cookie)+').getAttribute("aria-hidden")'),'false');
 await evaluate("document.querySelector('[data-cookie-consent=accept]').focus()");
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
 assert.equal(await evaluate("localStorage.getItem('lady-elka-cookie-consent')"),'accepted');
 assert.equal(await evaluate('document.getElementById('+JSON.stringify(cookie)+').getAttribute("aria-hidden")'),'true');
 for(const mobile of [false,true]){
  await command('Emulation.setDeviceMetricsOverride',{width:mobile?390:1440,height:844,deviceScaleFactor:1,mobile});
  await navigate('/');
  const ids=await evaluate("[...document.querySelectorAll('[data-modal-open]')].map(e=>e.dataset.modalOpen)");
  for(const id of ids){
   const hook='[data-modal-open="'+id+'"]';const modal='document.getElementById('+JSON.stringify(id)+')';
   await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(hook)+');e.addEventListener("click",e=>e.preventDefault(),{once:true});e.click()})()');
   assert.notEqual(await evaluate(modal+'.getAttribute("aria-hidden")'),'false');
   await evaluate('document.querySelector('+JSON.stringify(hook)+').focus()');
   await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   assert.equal(await evaluate(modal+'.getAttribute("aria-hidden")'),'false');
   const validation=await evaluate('(()=>{const f='+modal+'.querySelector("form");if(!f)return null;const input=f.querySelector("input[type=email]");if(input){input.value="invalid";return input.checkValidity()}return null})()');
   if(validation!==null)assert.equal(validation,false);
   // Lead forms (client/forms.js) set noValidate and own validation: an invalid email is marked aria-invalid and nothing is sent
   // (the page-level blocked/GET-only assertions below prove no request). Other forms keep native constraint validation.
   // Intentional lazy forms: the first requestSubmit awaits binding, then validates.
   const submission=await evaluate('(async()=>{const f='+modal+'.querySelector("form");if(!f)return null;const input=f.querySelector("input[type=email]");'
     +'if(f.noValidate){if(!input)return null;input.value="invalid";f.requestSubmit();for(let n=0;n<100&&!input.hasAttribute("aria-invalid");n++)await new Promise(r=>setTimeout(r,20));return {owned:true,invalidMarked:input.getAttribute("aria-invalid")==="true"}}'
     +'let submits=0;f.addEventListener("submit",e=>{e.preventDefault();submits++});if(input){f.requestSubmit();if(submits)return {invalidBlocked:false};input.value="qa@example.test"}f.requestSubmit();return {invalidBlocked:true,submits}})()');
   if(submission?.owned)assert.equal(submission.invalidMarked,true);
   else if(submission){assert.equal(submission.invalidBlocked,true);assert.equal(submission.submits,1);}

   // Cancel before site dispatch: neither modal close nor pseudo-link navigation may occur.
   await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(hook)+');e.addEventListener("click",e=>e.preventDefault(),{once:true});e.click()})()');
   assert.equal(await evaluate(modal+'.getAttribute("aria-hidden")'),'false');
   await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
   assert.equal(await evaluate(modal+'.getAttribute("aria-hidden")'),'true');
   await evaluate('document.querySelector('+JSON.stringify(hook)+').click();'+modal+'.querySelector(".pop-up__overlay").click()');
   assert.equal(await evaluate(modal+'.getAttribute("aria-hidden")'),'true');
   await evaluate('document.querySelector('+JSON.stringify(hook)+').click();'+modal+'.querySelector(".pop-up__inside-close-button, .pop-up__outside-close-button").click()');
   assert.equal(await evaluate(modal+'.getAttribute("aria-hidden")'),'true');
  }
  evidence.push({ownedModalTargets:ids,mobile,keyboard:true,escape:true,backdrop:true,close:true,nativeEmailValidation:true,defaultPrevented:true});
 }
 evidence.push({cookieKeyboard:true,persisted:true});
 assert.equal(blocked.length,0);assert.ok(requests.every(r=>r.method==='GET'));
 `;
  const marker=' const report={browser:';if(!base.includes(marker))throw new Error('Harness marker changed');
  const runner=join(workspace.directory,'storefront/tests/owned-modal-browser.mjs');await writeFile(runner,base.replace(marker,extra+'\n'+marker));
  const result=await run(process.execPath,[runner],{cwd:workspace.directory,env:{...process.env,LE_ROUTES_QA_ROOT:workspace.directory,LE_ROUTES_QA_REPORT:join(workspace.directory,'owned-modal-browser.json')},maxBuffer:4*1024*1024});
  console.log(result.stdout);
 }finally{await workspace.cleanup();}
});
