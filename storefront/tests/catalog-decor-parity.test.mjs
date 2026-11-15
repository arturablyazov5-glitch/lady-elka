import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {catalogPhotos,pinPhotos,presentProduct} from '../products/presentation.mjs';
import {csvRecords,decorProducts} from '../../supabase/functions/_shared/product-rules.mjs';
import {renderProductPage,withProductLayout} from '../products/product-page.mjs';

test('feed image ordering survives pinning without a storage-host priority',()=>{
 const urls=['https://lady-elka.ru/d/first.jpg','https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/second.webp'];
 assert.deepEqual(catalogPhotos(urls),urls);
 assert.equal(pinPhotos(urls.join('|'),url=>`/media/${urls.indexOf(url)}`),'/media/0|/media/1');
});

test('five decor layouts preserve source properties and material; controls use feed variants',async()=>{
 const root=new URL('../',import.meta.url);
 const routes=JSON.parse(await readFile(new URL('product-routes.json',root))).filter(r=>r.kind==='decor');
 const products=decorProducts(csvRecords(await readFile(new URL('catalog-snapshots/2026-10-08T04-59-43-880Z/decor.csv',root),'utf8')));
 const base=await readFile(new URL('public/catalog-tree/korzina-pod-yelku.html',root),'utf8');
 const auto={kind:'decor',path:'/catalog-tree/new',auto:true};
 const autoHtml=renderProductPage(base,presentProduct(products.get('1d'),auto),auto,'New description');
 assert.ok(!autoHtml.includes('Нижний диаметр: 84 см'));
 for(const route of routes){
  const layout=await readFile(new URL(`components/decor/${route.path.split('/').at(-1)}.html`,root),'utf8');
  const product=presentProduct(products.get(route.id),route);
  const html=renderProductPage(withProductLayout(base,layout),product,route,product.selectedVariant.description||route.liveDescription);
  if(route.richTextHtml) for(const paragraph of route.richTextHtml.match(/<p>.*?<\/p>/g))assert.ok(html.includes(paragraph),route.path+' property');
  assert.equal(html.includes('Гипоаллергенный'),layout.includes('Гипоаллергенный'));
  assert.ok(!html.includes('data-action-element'));
  if(route.id==='5d'){
   assert.match(html,/data-storefront-option="category"/);assert.match(html,/data-storefront-option="size"/);
   for(const value of ['Зеленый','Заснеженный','45 см','60 см'])assert.ok(html.includes(value));
   assert.match(html,/storefront-decor-option input__catalog/);
   assert.ok(!html.includes('div--u-imrhllprv'));
  }
  if(route.id==='4d')assert.match(html,/120х40х60/);
 }
});
