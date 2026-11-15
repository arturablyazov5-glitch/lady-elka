// Офлайн: Supabase-ответы и картинки — синтетические (fetchImpl), сеть не используется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareBlog, activateBlog, fetchPublished, downloadCover } from '../blog/sync.mjs';
import { loadSnapshot, checksum } from '../blog/snapshot.mjs';
import { buildBlog, extendSitemap } from '../blog/build.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-cover')]);
const post = (n, patch = {}) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, revision: 1, title: `Тестовая статья ${n}`, slug: `qa-sync-${n}`, excerpt: 'Анонс', text: 'Текст', cover: '', alt: '', seoTitle: '', seoDescription: '', status: 'published', createdAt: `2026-10-0${n}T08:00:00.000Z`, updatedAt: `2026-10-0${n}T09:00:00.000Z`, ...patch });
const published = posts => JSON.stringify({ version: 1, format: 'plain-text', posts });
function fakeFetch(routes, calls = []) {
  return async url => { calls.push(String(url)); const r = routes[String(url)] ?? routes.published; if (!r) return new Response('nope', { status: 404 }); return typeof r === 'function' ? r() : new Response(r.body, { status: r.status || 200, headers: r.headers || { 'Content-Type': 'application/json' } }); };
}
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'le-blog-sync-')), root = join(dir, 'public');
  await mkdir(join(root, 'blog'), { recursive: true }); await writeFile(join(root, 'blog', 'legacy-post.html'), '<title>Legacy</title>');
  return { dir, root };
}

test('published blog → candidate snapshot with localized cover; bad posts skipped; repeat is unchanged; removal is a change', async () => {
  const { dir, root } = await workspace();
  try {
    const cover = 'https://cdn.example.org/covers/a.png';
    const posts = [post(1, { cover, alt: 'Обложка' }), post(2, { slug: 'legacy-post' }), post(3, { cover: 'https://cdn.example.org/page.html', alt: 'x' }), post(4, { status: 'draft' }), post(5, { cover: '/images/missing.jpg', alt: 'x' })];
    const routes = { published: { body: published(posts) }, [cover]: { body: PNG, headers: { 'Content-Type': 'image/png' } }, 'https://cdn.example.org/page.html': { body: '<html>', headers: { 'Content-Type': 'text/html' } } };
    const output = join(dir, 'candidate.json'), current = join(dir, 'snapshot.json');
    const result = await prepareBlog({ output, current, root, fetchImpl: fakeFetch(routes) });
    assert.equal(result.status, 'changed'); assert.equal(result.posts, 1);
    assert.equal(result.warnings.length, 3, JSON.stringify(result.warnings));
    const snap = await loadSnapshot({ file: output, root });
    assert.deepEqual(snap.posts.map(p => p.slug), ['qa-sync-1']);
    assert.equal(snap.posts[0].url, '/blog/qa-sync-1.html');
    const local = snap.assets[cover].url;
    assert.equal(local, `/media/blog/${checksum(PNG)}.png`);
    assert.deepEqual(await readFile(join(root, local)), PNG);
    assert.deepEqual((await readdir(join(root, 'media/blog'))).filter(n => n.startsWith('.tmp')), []);
    await activateBlog(output, { target: current, root });
    const again = await prepareBlog({ output: join(dir, 'again.json'), current, root, fetchImpl: fakeFetch(routes) });
    assert.equal(again.status, 'unchanged');
    const removed = await prepareBlog({ output: join(dir, 'removed.json'), current, root, fetchImpl: fakeFetch({ published: { body: published([]) } }) });
    assert.equal(removed.status, 'changed'); assert.equal(removed.posts, 0); assert.equal(removed.previousPosts, 1);
    // Cover temporarily unavailable: previously localized copy is kept, article stays.
    const flaky = await prepareBlog({ output: join(dir, 'flaky.json'), current, root, fetchImpl: fakeFetch({ ...routes, [cover]: { body: 'down', status: 503 } }) });
    assert.equal(flaky.status, 'unchanged'); assert.match(flaky.warnings.join(' '), /ранее сохранённая обложка/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('no published posts and no snapshot stays legacy-only (unchanged); unstable or malformed reads fail closed', async () => {
  const { dir, root } = await workspace();
  try {
    assert.equal((await prepareBlog({ output: join(dir, 'c.json'), current: join(dir, 'none.json'), root, fetchImpl: fakeFetch({ published: { body: published([]) } }) })).status, 'unchanged');
    let n = 0;
    await assert.rejects(fetchPublished({ fetchImpl: async () => new Response(published([post(n++ % 2 + 1)]), { status: 200 }) }), /изменился во время чтения/);
    await assert.rejects(fetchPublished({ fetchImpl: async () => new Response('{}', { status: 200 }) }), /формат/);
    await assert.rejects(fetchPublished({ fetchImpl: async () => new Response('', { status: 500 }) }), /HTTP 500/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cover download refuses non-public or unsafe sources and non-images', async () => {
  const { dir, root } = await workspace();
  try {
    const ok = async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    for (const bad of ['http://example.org/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://u:p@example.org/a.png', 'https://example.org:8443/a.png', 'javascript:alert(1)'])
      await assert.rejects(downloadCover(bad, { fetchImpl: ok, root }), /https|адрес/, bad);
    await assert.rejects(downloadCover('https://example.org/a.png', { fetchImpl: async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }), root }), /не изображение/);
    await assert.rejects(downloadCover('https://example.org/a.png', { fetchImpl: async () => new Response(Buffer.alloc(9 * 1024 * 1024), { status: 200, headers: { 'Content-Type': 'image/png' } }), root }), /размер/);
    assert.match(await downloadCover('https://example.org/a.png', { fetchImpl: ok, root }), /^\/media\/blog\/[a-f0-9]{64}\.png$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('built article has SEO head (canonical/og/twitter/JSON-LD), list puts new posts first, sitemap gets lastmod', async () => {
  const source = resolve(import.meta.dirname, '../public'), dir = await mkdtemp(join(tmpdir(), 'le-blog-build-'));
  try {
    await mkdir(join(dir, 'blog')); await cp(join(source, 'blog.html'), join(dir, 'blog.html'));
    const a = { ...post(1, { title: 'Статья </script><b>', seoTitle: 'SEO «A»', seoDescription: 'Описание "A"', cover: 'https://cdn.example.org/a.png', alt: 'Обложка' }), url: '/blog/qa-sync-1.html' };
    const b = { ...post(2), url: '/blog/qa-sync-2.html' };
    const snapshot = { posts: [a, b], assets: { [a.cover]: { url: '/media/blog/abc.png', sha256: '0'.repeat(64) } } };
    const records = await buildBlog(snapshot, { source, target: dir });
    const html = await readFile(join(dir, 'blog/qa-sync-1.html'), 'utf8');
    assert.match(html, /<title>SEO «A»<\/title>/);
    assert.match(html, /<meta name="description" content="Описание &quot;A&quot;">/);
    assert.equal(html.match(/rel="canonical"/g).length, 1);
    assert.match(html, /<link rel="canonical" href="https:\/\/lady-elka.ru\/blog\/qa-sync-1.html">/);
    assert.match(html, /<meta property="og:type" content="article">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/lady-elka.ru\/media\/blog\/abc.png">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.equal(html.match(/property="og:url"/g).length, 1); assert.doesNotMatch(html, /content="website"/);
    assert.doesNotMatch(html, /<\/script><b>/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(ld['@type'], 'BlogPosting'); assert.equal(ld.headline, a.title); assert.equal(ld.mainEntityOfPage['@id'], 'https://lady-elka.ru/blog/qa-sync-1.html');
    assert.deepEqual(ld.image, ['https://lady-elka.ru/media/blog/abc.png']); assert.equal(ld.dateModified, a.updatedAt);
    assert.match(html, /<img src="\/media\/blog\/abc.png" alt="Обложка"/);
    const list = await readFile(join(dir, 'blog.html'), 'utf8');
    const order = ['/blog/qa-sync-2.html', '/blog/qa-sync-1.html', '/blog/iskusstvennaya-yelka-cena-i-chto-na-nee-vliyaet'].map(u => list.indexOf(`href="${u}"`) >= 0 ? list.indexOf(`href="${u}"`) : list.indexOf(`href='${u}'`));
    assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
    assert.match(list, /02\.10\.2026/);
    const xml = extendSitemap('<urlset>\n</urlset>', records);
    assert.match(xml, /<loc>https:\/\/lady-elka.ru\/blog\/qa-sync-1.html<\/loc><lastmod>2026-10-01<\/lastmod>/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
