import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConfig } from '../config/runtime.mjs';
const data = new Map();
globalThis.localStorage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
const cart = await import('../client/cart-store.js');
const promo = await import('../client/promo.js');
const { initCart } = await import('../client/cart-ui.js');
const product = { id:'tree', kind:'tree', title:'Миранда' };
const variant = { id:'tree:180', price:1000, options:{height:'180',category:'Зелёная'} };
function seed() { cart.clear(); cart.add(product, variant); }

test('cart UI derives total/items from state, never reads serialized compatibility fields, mounts once', () => {
  seed();
  let clicks = 0, inserted = 0, removed = 0;
  const list = { dataset:{}, addEventListener(){clicks++;} };
  const total = {}, offer = { style: {} }, form = { querySelector(){throw new Error('Must not scrape hidden form fields');} };
  const popup = {
    querySelectorAll: () => [{ remove(){removed++;} }],
    querySelector(s) {
      if(s === '.itogo-wrapper') return { before(){inserted++;} };
      if(s === 'form') return form;
      if(s.includes('data-cart-title')) return total;
      if(s.includes('data-cart-sum-offer')) return offer;
    }
  };
  globalThis.document = { querySelector:() => popup, createElement:() => list };
  let active = { rub:200 };
  const first = initCart(() => active);
  assert.equal(initCart(() => active), first);
  assert.equal(clicks,1); assert.equal(inserted,1); assert.equal(removed,1);
  assert.match(total.textContent,/800/); assert.match(list.innerHTML,/Миранда/);
  active=null; first.render(); assert.match(total.textContent,/1\s?000/);
  cart.clear(); assert.match(list.innerHTML,/Корзина пуста/);
});

test('quantity remains finite and inside server limit when same variant is merged', () => {
  seed(); cart.setQuantity(product.id,variant.id,99); cart.add(product,variant);
  cart.setQuantity(product.id,variant.id,NaN);
  assert.equal(cart.getItems()[0].quantity,99);
});

test('promo valid/invalid/unavailable/reset, loading and duplicate mount use own state', async () => {
  seed(); globalThis.__LE_STOREFRONT_CONFIG__=runtimeConfig('fixture');
  const messages=[]; globalThis.alert=m => messages.push(m);
  const label={}, input={value:'NOPE'}, handlers=[];
  const button={querySelector:()=>label, addEventListener:(_n,f)=>handlers.push(f)};
  globalThis.document={querySelector:s => s === '[data-promo-apply]' ? button : input};
  let changes=0; promo.initPromo(()=>changes++); promo.initPromo(()=>changes++);
  assert.equal(handlers.length,1); assert.equal(label.textContent,'активировать');
  let requests=0, release;
  globalThis.fetch=async url => {
    assert.match(url,/promos/); requests++;
    return new Promise(r => {release=r;});
  };
  const click=()=>handlers[0]({preventDefault(){}});
  const invalid=click(); assert.equal(button.disabled,true); assert.equal(input.disabled,true);
  assert.equal(label.textContent,'проверяем…'); await click(); assert.equal(requests,1);
  release({ok:true,text:async()=> 'code,rub\nVALID,200\n'}); await invalid;
  assert.equal(promo.getPromo(),null); assert.match(messages.at(-1),/не подходит/);
  assert.equal(button.disabled,false);
  input.value='VALID'; const valid=click(); release({ok:true,text:async()=> 'code,rub\nVALID,200\n'}); await valid;
  assert.equal(promo.getPromo().rub,200); assert.equal(changes,1); assert.equal(label.textContent,'сбросить');
  const snapshot=promo.getPromo(); snapshot.rub=999; assert.equal(promo.getPromo().rub,200);
  await click(); assert.equal(promo.getPromo(),null); assert.equal(data.has('lady_promo_state'),false);
  input.value='VALID'; const unavailable=click(); release({ok:false,status:503}); await unavailable;
  assert.equal(promo.getPromo(),null); assert.match(messages.at(-1),/недоступны/);
  assert.equal(button.disabled,false); assert.equal(label.textContent,'активировать');
});

test('checkout remount keeps one set of handlers and preserves loading/error button states', async () => {
  const { initCheckout }=await import('../client/checkout.js');
  seed(); globalThis.__LE_STOREFRONT_CONFIG__=runtimeConfig('fixture');
  globalThis.sessionStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  globalThis.location={origin:'http://localhost:4176',assign(){throw new Error('Unexpected redirect');}};
  const handlers=new Map(), label={textContent:'купить'}, notice={style:{},setAttribute(){},remove(){}};
  const button={querySelector:()=>label,after(){},disabled:false};
  globalThis.document={createElement:()=>notice};
  const values=new Map(Object.entries({
    '[data-checkout-field="name"]':{value:'Иван'},'[data-checkout-field="email"]':{value:'ivan@example.org'},
    '[data-checkout-field="phone"]':{value:'+79991234567',addEventListener(){},removeEventListener(){}},'[data-checkout-field="address"]':{value:'Москва'},
    '[data-checkout-field="contactPref"]':{value:'Telegram'},'[data-checkout-field="paymentMethod"]':{value:'card'},
    '[data-checkout-field="consent"]':{checked:true},'[data-checkout-field="comment"]':{value:'Комментарий'}
  }));
  const form={querySelectorAll(s){const c=this.querySelector(s);return c?[c]:[];},querySelector:s=>s==='[data-pay-now]'?button:values.get(s),
    addEventListener(n,f){if(!handlers.has(n))handlers.set(n,new Set());handlers.get(n).add(f);},
    removeEventListener(n,f){handlers.get(n)?.delete(f);}, reset(){throw new Error('Error must not reset form');}};
  // One mount may own several handlers per event (input: draft save + aria-invalid reset); a remount must not add any.
  initCheckout(form,()=>null);
  const mountedOnce=new Map([...handlers].map(([name,set])=>[name,[...set]]));
  initCheckout(form,()=>null);
  assert.equal(handlers.get('submit').size,1);
  for(const [name,set] of handlers) assert.equal(set.size,mountedOnce.get(name)?.length??0,name);
  let release, posts=0;
  globalThis.fetch=async(url,options)=>{
    if(options?.method==='POST'){posts++;return new Promise(r=>{release=r;});}
    if(url.endsWith('/trees.csv'))return {ok:true,text:async()=> 'id,title,active,category,height_cm,price\ntree,Миранда,1,Зелёная,180,1000\n'};
    if(url.endsWith('/decor.csv'))return {ok:true,text:async()=> 'id,title,active,category,variants,price\n'};
    throw new Error('Unexpected request');
  };
  // Use the canonical variant ID from the synthetic catalog.
  cart.clear();cart.add(product,{...variant,id:'tree:Зелёная:180'});
  const submit=[...handlers.get('submit')][0];
  const event={preventDefault(){},stopImmediatePropagation(){}};
  const first=submit(event);await new Promise(r=>setImmediate(r));
  assert.equal(button.disabled,true);assert.equal(label.textContent,'Оформляем заказ…');
  initCheckout(form,()=>null);assert.equal([...handlers.get('submit')][0],submit);
  await submit(event);assert.equal(posts,1);
  release({ok:false,json:async()=>({message:'Синтетический отказ'})});await first;
  assert.equal(button.disabled,false);assert.equal(label.textContent,'купить');
  assert.match(notice.textContent,/Сервис временно недоступен/);// status-less failure = unavailable (client/request-errors.js)
  assert.equal(cart.getItems().length,1);
  assert.ok(data.has('lady_elka_checkout_draft_v1'));assert.ok(data.has('lady_elka_pending_order_v1'));
});
