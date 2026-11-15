import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';
import { initCheckout } from '../client/checkout.js';
const run = promisify(execFile);
const names = ['name','email','phone','address','contactPref','comment','paymentMethod','consent'];
test('checkout rejects missing and duplicate semantic controls before attaching handlers', () => {
  for (const count of [0, 2]) {
    let listeners = 0;
    const form = { querySelectorAll(selector) { return Array.from({length: selector.includes('email') ? count : 1}, () => ({value:''})); },
      addEventListener() { listeners++; } };
    assert.throws(() => initCheckout(form, () => null), /Checkout field email: expected exactly one/);
    assert.equal(listeners, 0);
  }
});
test('all offline pages have exactly eight owned checkout controls; malformed template fails closed', async () => {
  const workspace = await isolatedWorkspace(resolve(import.meta.dirname, '../..'));
  try {
    const args = ['--import','data:text/javascript,globalThis.fetch=()=>{throw new Error("Build network forbidden")}',join(workspace.directory,'storefront/build.mjs'),'--mode=preview'];
    await run(process.execPath, args, { cwd: workspace.directory });
    const target = join(workspace.directory,'storefront/dist');
    let pages = 0;
    for (const path of await readdir(target, {recursive:true})) {
      if (!path.endsWith('.html')) continue;
      // 404.html is a standalone copy of the live Taptop 404 (owner requirement, see agent-context/progress-404.md): own /f/404.js, no cart/checkout; covered by 404-*.test.mjs.
      if (path === '404.html') continue;
      const html = await readFile(join(target,path),'utf8');
      const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].filter(match => /data-pay-now/.test(match[0]));
      assert.equal(forms.length,1,path);
      const form = forms[0][0];
      for (const name of names) assert.equal([...form.matchAll(new RegExp(`data-checkout-field="${name}"`,'g'))].length,1,`${path}: ${name}`);
      assert.equal([...form.matchAll(/data-checkout-field=/g)].length,8,path);
      assert.match(form,/placeholder=['"]Иван Иванов['"]/);
      assert.match(form,/placeholder=['"]Адрес доставки['"]/);
      assert.match(form,/value="card"/); assert.match(form,/value="cash_on_delivery"/);
      assert.match(form,/<textarea hidden data-checkout-field="comment"><\/textarea>/);
      pages++;
    }
    assert.ok(pages >= 85);
    const source = join(workspace.directory,'storefront/public/index.html');
    const original = await readFile(source,'utf8');
    await writeFile(source,original.replace('data-checkout-field="email"', 'data-checkout-field="missing-email"'));
    await assert.rejects(run(process.execPath,args,{cwd:workspace.directory}), /Checkout template hook email: expected exactly one/);
    await writeFile(source, original.replace('data-checkout-field="name"', 'data-checkout-field="email"'));
    await assert.rejects(run(process.execPath,args,{cwd:workspace.directory}), /Checkout template hook name: expected exactly one/);
    await writeFile(source, original.replace('value="card"', 'value="Оплата картой"'));
    await assert.rejects(run(process.execPath,args,{cwd:workspace.directory}), /Checkout template paymentMethod: expected owned values/);
  } finally { await workspace.cleanup(); }
});
test('persisted v1 method migrates without consulting labels or placeholders', () => {
  const previous = {document:globalThis.document,sessionStorage:globalThis.sessionStorage};
  try {
    globalThis.document = {createElement:()=>({style:{},setAttribute(){}})};
    for (const [old, expected] of [['Оплата картой онлайн','card'],['Оплата картой','card'],['Оплата при получении','cash_on_delivery']]) {
      globalThis.sessionStorage = {getItem:key=>key.includes('draft')?JSON.stringify({method:old,name:'Сохранённое имя',consent:true}):null};
      const controls = Object.fromEntries(names.map(name=>[name,{value:'',checked:false,addEventListener(){},removeEventListener(){}}]));
      const form = {querySelectorAll:selector=>[controls[/"([^\"]+)"/.exec(selector)[1]]],querySelector:selector=>{assert.equal(selector,'[data-pay-now]');return {querySelector:()=>null,after(){}};},addEventListener(){}};
      initCheckout(form,()=>null);
      assert.equal(controls.paymentMethod.value,expected);assert.equal(controls.name.value,'Сохранённое имя');assert.equal(controls.consent.checked,true);
    }
  } finally {Object.assign(globalThis,previous);}
});
