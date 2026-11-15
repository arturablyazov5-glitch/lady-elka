import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {productImageHtml} from '../products/card-renderer.mjs';
import {setProductImage} from '../client/product-image.js';
import {legacyArticleBody} from '../build-search.mjs';
test('shared image renderer avoids empty src and escapes real image metadata',()=>{
 assert.equal(productImageHtml('', 'Веста'),'<span data-storefront-photo-placeholder>Нет фото</span>');
 const markup=productImageHtml('/media/test.jpg','A"<B');assert.match(markup,/src="\/media\/test.jpg"/);assert.match(markup,/&quot;&lt;/);assert.match(markup,/placeholder hidden/);
});
test('variant transitions remove empty images and restore real image with one placeholder',()=>{
 const children=[];
 const container={querySelector(selector){return children.find(n=>selector==='img'?n.tag==='img':n.placeholder)||null;},append(n){children.push(n);},prepend(n){children.unshift(n);}};
 const root={querySelector:()=>container};
 const previous=globalThis.document;
 // Element stub with the attribute API: setProductImage now writes src/srcset/sizes via attributes (thumbnails).
 globalThis.document={createElement:tag=>({tag,hidden:false,attributes:{},
  setAttribute(k,v){this.attributes[k]=String(v);if(k==='src')this.src=String(v);if(k==='data-storefront-photo-placeholder')this.placeholder=true;},
  getAttribute(k){return this.attributes[k]??null;},removeAttribute(k){delete this.attributes[k];if(k==='src')delete this.src;},
  remove(){children.splice(children.indexOf(this),1);}})};
 try {
  setProductImage(root,'','Веста');assert.equal(children.length,1);assert.equal(children[0].hidden,false);
  setProductImage(root,'/real.jpg','Веста');assert.equal(children.length,2);assert.equal(children[0].src,'/real.jpg');assert.equal(children[1].hidden,true);
  setProductImage(root,'','Веста');assert.equal(children.length,1);assert.equal(children[0].hidden,false);assert.ok(!children.some(n=>n.tag==='img'));
  setProductImage(root,'/next.jpg','Веста');assert.equal(children.length,2);assert.equal(children[0].src,'/next.jpg');
 } finally {globalThis.document=previous;}
});
test('legacy article body extraction excludes surrounding navigation/footer and scripts',async()=>{
 assert.equal(legacyArticleBody('<nav>MENU</nav><div class="tt-rich-text"><div><p>BODY</p></div><script>BAD</script></div><footer>FOOTER</footer>'),'<div><p>BODY</p></div>');
 for(const file of ['iskusstvennaya-yelka-cena-i-chto-na-nee-vliyaet','novogodnie-iskusstvennye-yelki-kak-vybrat-idealnuyu-yelku-dlya-doma-na-dolgie-gody']) {
  const text=legacyArticleBody(await readFile(new URL('../public/blog/'+file+'.html',import.meta.url),'utf8'));
  assert.ok(text.length>1000);assert.doesNotMatch(text,/main-content__footer|Политика конфиденциальности|<script/);
 }
});
