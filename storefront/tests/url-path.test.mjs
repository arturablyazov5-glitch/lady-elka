import test from 'node:test';
import assert from 'node:assert/strict';
import { pagePath } from '../url-path.mjs';
import { canonicalPath, filterSitemap, noindexRoute } from '../seo.mjs';

test('Timeweb directory canonical URLs avoid 308, including dotted product slugs; files stay direct', () => {
  for (const path of ['/catalog', '/tree/miranda', '/catalog-tree/hvojnaya-girlyanda-2.8-metra']) {
    assert.equal(pagePath(path), path + '/');
    assert.equal(pagePath(path + '/'), path + '/');
    assert.equal(pagePath(path + '?x=1#part'), path + '/?x=1#part');
  }
  for (const path of ['/', '/blog/post.html', '/sitemap.xml', '/robots.txt', '/assets/hash.js', '/photo.webp']) assert.equal(pagePath(path), path);
  assert.equal(canonicalPath('/catalog-decor/'), '/catalog-tree/');
  assert.equal(canonicalPath('/main'), '/');
  assert.ok(noindexRoute('/spasibo/'));
  const xml = '<urlset><url><loc>https://lady-elka.ru/catalog</loc></url></urlset>';
  assert.equal(filterSitemap(filterSitemap(xml)), filterSitemap(xml));
});
