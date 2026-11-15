// Standalone targeted acceptance; existing source/tests and shared outputs stay read-only.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';
const root = resolve(import.meta.dirname, '../..');
const workspace = await isolatedWorkspace(root);
const run = (args, env={}) => new Promise((resolve,reject) => {
 const child=spawn(process.execPath,args,{cwd:workspace.directory,env:{...process.env,...env},stdio:'inherit'});
 child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Acceptance exit ${code}`)));
});
try {
 await run(['--import','data:text/javascript,globalThis.fetch=()=>{throw new Error("Build network forbidden")}', 'storefront/build.mjs','--mode=preview']);
 const base=await readFile(join(root,'storefront/tests/taptop-search-routes-browser.mjs'),'utf8');
 const extra=String.raw`
 // These fixtures replace fetch inside this ephemeral document only. No order endpoint exists.
 await command('Emulation.clearDeviceMetricsOverride');
 await navigate('/tree/miranda');
 const product=await evaluate("JSON.parse(document.querySelector('[data-storefront-page-product]').textContent)");
 const before=await evaluate("document.querySelector('[data-storefront-image] img').src");
 const variantCheck=await evaluate(\`(()=>{const root=document.querySelector('[data-storefront-product]');const select=[...root.querySelectorAll('[data-storefront-option]')].find(s=>s.options.length>1);if(!select)return {changed:false};select.selectedIndex=select.options.length-1;select.dispatchEvent(new Event('change',{bubbles:true}));return {changed:true,value:select.value,price:root.querySelector('.price').textContent,image:root.querySelector('[data-storefront-image] img').src}})()\`);
 assert.equal(variantCheck.changed,true); assert.ok(variantCheck.price.includes('₽'));
 await evaluate("document.querySelector('[data-storefront-gallery-root] img').click()");
 assert.equal(await evaluate("document.querySelector('.storefront-lightbox').hidden"),false);
 const galleryCount=await evaluate("document.querySelectorAll('[data-storefront-gallery-root] img,[data-storefront-gallery] img').length");
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 assert.equal(await evaluate("document.querySelector('.storefront-lightbox').hidden"),true);
 evidence.push({actualProduct:product.id,variantCheck,galleryCount,galleryKeyboard:true});
 await navigate('/catalog');
 await evaluate("document.querySelector('.js-flt-price-min').value='99999999';document.querySelector('.js-flt-price-min').dispatchEvent(new Event('input',{bubbles:true}))");
 assert.equal(await cards(),0);
 await evaluate("document.querySelector('.js-flt-reset').click()");assert.equal(await cards(),19);
 evidence.push({filterNoMatches:true,resetCards:19});
 await evaluate("document.querySelector('.buy-btn').click();window.__alerts=[];window.alert=m=>__alerts.push(m);window.__nativeFetch=window.fetch;window.fetch=()=>new Promise(r=>window.__promoResolve=r);document.querySelector('[data-promo-input]').value='FINALQA';document.querySelector('[data-promo-apply]').click()");
 assert.match(await evaluate("document.querySelector('[data-promo-apply]').textContent"),/проверяем/);
 assert.equal(await evaluate("document.querySelector('[data-promo-input]').disabled"),true);
 await evaluate("window.__promoResolve(new Response('code,active,percent,gift\\nFINALQA,1,10,0\\n',{status:200}))");
 await until("document.querySelector('[data-promo-apply]').textContent.includes('сбросить')");
 assert.match(await evaluate("document.querySelector('[data-cart-sum-offer]').textContent"),/Промокод применён/);
 await evaluate("document.querySelector('[data-promo-apply]').click()");
 assert.match(await evaluate("document.querySelector('[data-promo-apply]').textContent"),/активировать/);
 await evaluate("document.querySelector('[data-promo-input]').value='UNKNOWN';document.querySelector('[data-promo-apply]').click();window.__promoResolve(new Response('code,active,percent\\nOTHER,1,10\\n',{status:200}))");
 await until("!document.querySelector('[data-promo-input]').disabled");
 assert.ok((await evaluate('__alerts')).includes('Промокод не подходит'));
 await evaluate("document.querySelector('[data-promo-input]').value='DOWN';window.fetch=()=>Promise.reject(new Error('Synthetic offline failure'));document.querySelector('[data-promo-apply]').click()");
 await until("!document.querySelector('[data-promo-input]').disabled");
 assert.ok((await evaluate('__alerts')).some(m=>m.includes('недоступны')));
 evidence.push({promoFixture:true,loading:true,apply:true,reset:true,invalid:true,unavailable:true});
 const originalPay=await evaluate("document.querySelector('[data-pay-now]').textContent");
 await evaluate(\`(()=>{const f=document.querySelector('[data-cart-popup] form');for(const [k,v] of Object.entries({name:'Тест',email:'qa@example.test',phone:'+79990000000',address:'Синтетический адрес'}))f.querySelector('[data-checkout-field="'+k+'"]').value=v;f.querySelector('[data-checkout-field="consent"]').checked=true;window.fetch=()=>new Promise((r,j)=>window.__feedReject=j);f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()\`);
 assert.equal(await evaluate("document.querySelector('[data-pay-now]').disabled"),true);
 assert.match(await evaluate("document.querySelector('[data-pay-now]').textContent"),/Оформляем заказ/);
 await evaluate("window.__feedReject(new Error('Synthetic feed unavailable'))");
 await until("!document.querySelector('[data-pay-now]').disabled");
 assert.equal(await evaluate("document.querySelector('[data-pay-now]').textContent"),originalPay);
 assert.match(await evaluate("document.querySelector('[data-cart-popup] [role=status]').textContent"),/Не удалось проверить/);
 evidence.push({checkoutLoading:true,restoredText:originalPay,feedFailurePreservesCart:true});
 const prior=await evaluate('performance.timeOrigin');await command('Page.reload',{ignoreCache:true});await until(\`performance.timeOrigin!==\${prior} && document.readyState==='complete'\`);
 assert.equal(await evaluate("document.querySelector('[data-checkout-field=name]').value"),'Тест');
 assert.equal(await evaluate("document.querySelector('[data-checkout-field=consent]').checked"),true);
 assert.ok(await evaluate("document.querySelector('[data-cart-items] [data-cart-index]')!==null"));
 evidence.push({actualArtifactDraftF5:true,consentAndCartRestored:true});
 const screenshotDir=process.env.LE_FINAL_QA_SCREEN_DIR;
 for(const viewport of [{width:1440,height:1000,mobile:false},{width:390,height:844,mobile:true}]){
  await command('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1});
  await navigate('/catalog');await evaluate("document.querySelectorAll('.pop-up[aria-hidden=false]').forEach(e=>e.style.display='none')");
  const layout=await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,broken:[...document.images].filter(i=>i.getBoundingClientRect().height>0 && i.complete && !i.naturalWidth).length,visibleProducts:[...document.querySelectorAll('[data-storefront-product]')].filter(e=>e.getBoundingClientRect().height>0).length})");
  assert.equal(layout.visibleProducts,19);assert.equal(layout.broken,0);assert.ok(layout.scroll<=layout.width+1,JSON.stringify(layout));
  if(screenshotDir){const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(screenshotDir,'catalog-'+viewport.width+'.png'),Buffer.from(shot.data,'base64'));}
  evidence.push({visualSanity:layout,mobile:viewport.mobile});
 }
 assert.deepEqual(await evaluate('__qaErrors'),[]);
 assert.equal(blocked.length,0);assert.ok(requests.every(r=>r.method==='GET'));
 `;
 const marker=' const report={browser:';
 if(!base.includes(marker))throw new Error('Existing harness insertion marker changed');
 const runner=join(workspace.directory,'legacy-final-browser.mjs');
 await writeFile(runner,base.replace("'./browser-interception-lifecycle-helper.mjs'","'./storefront/tests/browser-interception-lifecycle-helper.mjs'").replace(marker,extra.replaceAll('\\`','`').replaceAll('\\${','${')+'\n'+marker));
 await run([runner],{LE_ROUTES_QA_ROOT:workspace.directory,LE_ROUTES_QA_REPORT:process.env.LE_ROUTES_QA_REPORT||'/tmp/le-final-acceptance-browser.json'});
} finally {await workspace.cleanup();}
