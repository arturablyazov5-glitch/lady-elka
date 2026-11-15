// Офлайн: PostgREST подменён in-memory моком, Supabase не вызывается.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseBlogStore } from '../server/blog-supabase.mjs';
import { sourcePosts } from '../server/blog.mjs';

function fakeRest() {
  const rows = [], calls = [];
  const query = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', prefer: options.headers?.Prefer });
    const [table, qs = ''] = path.split('?'), params = new URLSearchParams(qs);
    assert.equal(table, 'le_blog_posts');
    const match = r => [...params].every(([k, v]) => k === 'select' || k === 'order' || String(r[k]) === v.replace(/^eq\./, ''));
    if (!options.method) return rows.filter(match).map(r => ({ ...r }));
    const body = options.body ? JSON.parse(options.body) : null;
    if (options.method === 'POST') {
      if (rows.some(r => r.slug === body.slug)) throw Object.assign(new Error('Товар с таким артикулом уже существует'), { status: 409 });
      const now = new Date().toISOString(), row = { id: crypto.randomUUID(), revision: 1, created_at: now, updated_at: now, ...body }; rows.push(row); return [{ ...row }];
    }
    const hit = rows.filter(match);
    if (options.method === 'PATCH') { hit.forEach(r => Object.assign(r, body)); return hit.map(r => ({ ...r })); }
    if (options.method === 'DELETE') { hit.forEach(r => rows.splice(rows.indexOf(r), 1)); return hit; }
  };
  return { rows, calls, query };
}
const input = { title: 'Тест Supabase', slug: 'qa-supabase-store', excerpt: 'Анонс', text: '', cover: '', alt: '', seoTitle: '', seoDescription: '', status: 'draft',
  contentFormat: 'le-richtext-v1', content: { version: 1, blocks: [{ type: 'paragraph', runs: [{ text: 'Текст', bold: true }] }] } };

test('local cabinet blog store writes le_blog_posts with revisions, conflicts and reserved legacy slugs', async () => {
  const rest = fakeRest(), store = createSupabaseBlogStore({ query: rest.query });
  assert.equal(store.storage, 'supabase');
  const created = await store.save(input);
  assert.equal(created.revision, 1); assert.equal(created.text, 'Текст'); assert.deepEqual(created.content, input.content);
  assert.equal(rest.rows[0].payload.slug, input.slug); assert.equal(rest.rows[0].status, 'draft');
  assert.ok(rest.calls.every(c => c.prefer === 'return=representation'));
  await assert.rejects(store.save(input), { status: 409, message: 'Этот адрес уже занят' });
  const published = await store.save({ ...input, status: 'published', revision: 1 }, created.id);
  assert.equal(published.revision, 2); assert.equal(rest.rows[0].status, 'published'); assert.equal(rest.rows[0].payload.status, 'published');
  await assert.rejects(store.save({ ...input, revision: 1 }, created.id), { status: 409 });
  await assert.rejects(store.save({ ...input, revision: 1 }, '00000000-0000-4000-8000-000000000000'), { status: 404 });
  await assert.rejects(store.save({ ...input, slug: (await sourcePosts())[0].slug }), { status: 409 });
  await assert.rejects(store.save({ ...input, status: 'published', text: '', content: undefined, contentFormat: undefined }), { status: 400 });
  assert.equal((await store.list()).length, 1);
  await assert.rejects(store.remove(created.id, 1), { status: 409 });
  assert.deepEqual(await store.remove(created.id, 2), { ok: true });
  assert.deepEqual(await store.list(), []);
});
