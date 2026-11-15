import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderProductPage } from '../products/product-page.mjs';
import { presentProduct } from '../products/presentation.mjs';
import { matchingVariants } from '../client/filter.js';
const root = new URL('../', import.meta.url);
const variants = [
 {id:'green180',category:'Зелёная',height:180,price:1000,oldPrice:1200,diameter:80,branches:0,photos:['/a.png'],description:'Первый'},
 {id:'snow210',category:'Заснеженная',height:210,price:2000,oldPrice:0,diameter:100,branches:200,photos:['/b.png','/c.png'],description:'Второй'},
];
const product = presentProduct({id:'synthetic',title:'Тест',variants}, {kind:'tree',path:'/tree/test'});
test('product HTML removes DOM copies while preserving variant state and unavailable routes', async () => {
 const template = await readFile(new URL('public/tree/miranda.html', root), 'utf8');
 for (const view of [product, presentProduct({id:'empty',title:'Нет',variants:[]},{kind:'tree',path:'/tree/empty'})]) {
  const html = renderProductPage(template, view, {}, 'Описание');
  const scope = html.slice(html.indexOf('data-storefront-gallery-root'), html.indexOf('data-storefront-page-product'));
  assert.doesNotMatch(scope, /data-product-id(?:-decor)?\b|data-prop-height\b|data-variant-id\b|data-storefront-kind\b|data-prop-title\b/);
  assert.match(html, /data-storefront-page-product/);
  assert.match(scope, /data-cart-open/);
  assert.doesNotMatch(html.match(/<div[^>]*class="button standart__button-4 buy-btn"[^>]*>/)[0], /data-action-element/);
  if (view.variants.length) assert.match(html, /snow210/);
  else assert.match(html, /aria-disabled="true"[^>]*>[\s\S]*?нет в наличии/);
 }
});
test('filter matches category height and price against the same variant', () => {
 assert.deepEqual(matchingVariants(product,{category:'заснеженная',height:210,min:1500,max:2200}).map(v=>v.id), ['snow210']);
 assert.equal(matchingVariants(product,{category:'Зелёная',height:210}).length,0);
 assert.equal(matchingVariants(product,{height:180,min:1500}).length,0);
});
