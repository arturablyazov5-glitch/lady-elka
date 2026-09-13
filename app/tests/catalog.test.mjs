import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {importCSV,exportCSV,validateProduct} from '../server/catalog.mjs';
import {parseCSV} from '../../src/catalog/utils.js';
import {loadDict,loadDecorDict} from '../../src/catalog/sheets.js';
import {SHEET_CSV_URL,DECOR_SHEET_CSV_URL} from '../../src/catalog/config.js';
const sources=Object.fromEntries(['trees','decor'].map(k=>[k,fs.readFileSync(new URL(`../data/source-${k}.csv`,import.meta.url),'utf8')]));
const products=['trees','decor'].flatMap(k=>importCSV(sources[k],k).products);
test('import preserves all real products, variants and inactive rows',()=>{
 assert.equal(products.length,40);assert.equal(products.reduce((n,p)=>n+p.variants.length,0),242);products.forEach(validateProduct);
 assert.ok(products.some(p=>p.variants.every(v=>!v.active)));
});
test('export produces exactly the same dictionaries for the existing Taptop loaders',async()=>{
 const originalFetch=globalThis.fetch;
 try{
  globalThis.fetch=async url=>new Response(url===SHEET_CSV_URL?sources.trees:sources.decor);
  const expected=[await loadDict(),await loadDecorDict()];
  globalThis.fetch=async url=>new Response(exportCSV(products,url===SHEET_CSV_URL?'trees':'decor'));
  const actual=[await loadDict(),await loadDecorDict()];
  assert.deepEqual(actual,expected);
 }finally{globalThis.fetch=originalFetch;}
});
test('decor CSV preserves types and exposes them as selectable variants',async()=>{
 const product={kind:'decor',sku:'typed-decor',title:'Венок',variants:[
  {category:'Зелёная',price:1000,variants:'-',photos:['https://example.com/green.webp'],active:true,description:'Зелёный'},
  {category:'Заснеженная',price:1200,variants:'-',photos:['https://example.com/snow.webp'],active:true,description:'Заснеженный'}
 ]};
 const originalFetch=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response(exportCSV([product],'decor'));
  const entry=(await loadDecorDict()).byId.get('typed-decor');
  assert.deepEqual(entry.variants.map(v=>v.category),['Зелёная','Заснеженная']);
  assert.deepEqual(entry.variants.map(v=>v.variantText),['Зелёная','Заснеженная']);
 }finally{globalThis.fetch=originalFetch;}
});
test('CSV correctly round trips quotes, commas and multiline descriptions',()=>{
 const p=structuredClone(products[0]);p.title='Ёлка "Снежная", большая';p.variants[0].description='Первая строка\nВторая, "цитата"';
 const csv=exportCSV([p],'trees'),rows=parseCSV(csv),head=rows.shift();assert.equal(rows[0][head.indexOf('title')],p.title);assert.equal(rows[0][head.indexOf('description')],p.variants[0].description);
});
test('rejects invalid prices, photo schemes, missing categories and 100% discount',()=>{
 for(const mutate of [p=>p.variants[0].price=-10,p=>p.variants[0].photos=['javascript:alert(1)'],p=>p.variants[0].category='',p=>p.variants[0].discount_pct=100,p=>p.variants.push({...p.variants[0]})]) {const p=structuredClone(products[0]);mutate(p);assert.throws(()=>validateProduct(p));}
});
