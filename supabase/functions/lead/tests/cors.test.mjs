import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadHandler } from '../handler.mjs';
import { postJson, RequestFailure } from '../../../../storefront/client/request-errors.js';

test('lead exposes Retry-After on success, errors and preflight', async () => {
  const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' };
  let row = { id: crypto.randomUUID(), delivery_status: 'delivered' }, storageDown = false;
  const handler = createLeadHandler({ env: key => env[key], fetch: async url => {
    assert.equal(url, 'https://db.example.test/rest/v1/rpc/le_accept_lead');
    return storageDown ? new Response(null, { status: 503 }) : Response.json(row);
  } });
  const payload = { id: row.id, type: 'question', phone: '+79991234567', comment: 'Test',
    consent: true, page: 'https://lady-elka.ru/' };
  for (const origin of ['https://lady-elka.ru', 'https://www.lady-elka.ru']) {
    const request = (data = payload, options = {}) => new Request('https://edge.example.test/lead', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(data), ...options,
    });
    const check = async (req, status) => {
      const response = await handler(req);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
      return response;
    };
    await check(request(null, { method: 'OPTIONS', body: undefined }), 204);
    await check(request(null, { method: 'GET', body: undefined }), 405);
    await check(request(null, { headers: { Origin: origin } }), 415);
    await check(request(null, { body: '{' }), 400);
    await check(request({ ...payload, consent: false }), 400);
    await check(request({ ...payload, comment: 'x'.repeat(13000) }), 413);
    await check(new Request('https://edge.example.test/lead?action=retry', { method: 'POST', headers: { Origin: origin } }), 401);
    row = { id: payload.id, delivery_status: 'delivered' };
    await check(request(), 200);
    await check(request({ website: 'spam' }), 200);
    row = { id: payload.id, delivery_status: 'pending' };
    await check(request(), 202);
    row = { error: 'conflict' };
    await check(request(), 409);
    row = { error: 'rate_limit' };
    const limited = await check(request(), 429);
    assert.equal(limited.headers.get('Retry-After'), '600');
    // Model the browser's CORS header filter before passing the response to the real client.
    const exposed = limited.headers.get('Access-Control-Expose-Headers').toLowerCase().split(',').map(s => s.trim());
    const visibleHeaders = new Headers([...limited.headers].filter(([name]) => exposed.includes(name)));
    await assert.rejects(postJson('https://edge.example.test/lead', payload, {
      fetchImpl: async () => new Response(await limited.text(), { status: 429, headers: visibleHeaders }),
    }), error => error instanceof RequestFailure && error.retryAfter === 600);
    storageDown = true;
    await check(request(), 503);
    storageDown = false;
  }
  const forbidden = await handler(new Request('https://edge.example.test/lead', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.test' } }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
});
