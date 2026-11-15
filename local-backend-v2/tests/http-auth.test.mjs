import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpAuth} from '../http-auth.mjs';
const fixture = (overrides = {}) => {
  let clock = 100;
  const session = {sessionId: 'session-a', owner: 'owner-a', expiresMs: 200, revoked: false, scopes: ['create', 'status']};
  const capability = {...session, token: 'synthetic-private-capability'};
  const options = {now: () => clock, verifySession: async () => session,
    capabilityStore: {resolve: async query => {assert.equal(query.sessionId, session.sessionId); return capability;}}, ...overrides};
  return {api: createHttpAuth(options), session, capability, setTime: t => {clock = t;}};
};
test('trusted session selects private capability and HTTP response contains no credentials', async () => {
  const {api, capability} = fixture();
  const result = await api.dispatch(async input => {
    assert.equal(input.credentials, capability.token);
    return {status: 200, body: {orderId: 'order-a'}};
  }, {deadline: Date.now()+5000, route: 'create', request: {capability: 'attacker', owner: 'other'}, body: {owner: 'other'}});
  assert.deepEqual(result, {status: 200, body: {orderId: 'order-a'}});
});
test('expiry and explicit revocation fail closed for session and capability', async () => {
  for (const target of ['session', 'capability']) for (const property of ['expiresMs', 'revoked']) {
    const f = fixture(); f[target][property] = property === 'revoked' ? true : 100;
    await assert.rejects(f.api.resolve({route: 'status'}), /UNAUTHORIZED/);
  }
  const f = fixture(); f.setTime(200);
  await assert.rejects(f.api.resolve({route: 'create'}), /UNAUTHORIZED/);
});
test('foreign session, owner and wrong scopes are rejected', async () => {
  for (const [key, value] of [['sessionId', 'foreign'], ['owner', 'foreign'], ['scopes', ['callback']]]) {
    const f = fixture(); f.capability[key] = value;
    await assert.rejects(f.api.resolve({route: 'create'}), /UNAUTHORIZED/);
  }
  const f = fixture(); f.session.scopes = ['status'];
  await assert.rejects(f.api.resolve({route: 'create'}), /UNAUTHORIZED/);
});
test('missing session verifier/store and callback/internal verifiers fail closed', async () => {
  for (const options of [{verifySession: null}, {capabilityStore: null}, {capabilityStore: {}}]) {
    const {api} = fixture(options);
    await assert.rejects(api.resolve({route: 'create'}), /AUTH_UNAVAILABLE/);
  }
  for (const route of ['callback', 'internal-poll', 'internal-retry'])
    await assert.rejects(createHttpAuth().resolve({route}), /AUTH_UNAVAILABLE/);
});
test('callback proof is body-bound, scoped, expiring and single-use', async () => {
  const grant = {expiresMs: 200, revoked: false, scopes: ['callback']};
  const f = fixture({verifyCallback: async () => grant});
  const body = {paymentId: 'synthetic'};
  const proof = await f.api.resolve({route: 'callback', body});
  assert.equal(await f.api.auth.internal(proof), false);
  assert.equal(await f.api.auth.callback(proof, {...body}), false);
  assert.equal(await f.api.auth.callback(proof, body), true);
  assert.equal(await f.api.auth.callback(proof, body), false);
  const second = await f.api.resolve({route: 'callback', body});
  f.setTime(200);
  assert.equal(await f.api.auth.callback(second, body), false);
});
test('internal grants reject callback scope, revoked and expired grants', async () => {
  for (const grant of [{scopes: ['callback'], expiresMs: 200, revoked: false},
    {scopes: ['internal'], expiresMs: 100, revoked: false}, {scopes: ['internal'], expiresMs: 200, revoked: true}]) {
    const f = fixture({verifyInternal: async () => grant});
    await assert.rejects(f.api.resolve({route: 'internal-poll'}), /UNAUTHORIZED/);
  }
  const f = fixture({verifyInternal: async () => ({scopes: ['internal'], expiresMs: 200, revoked: false})});
  const proof = await f.api.resolve({route: 'internal-retry'});
  assert.equal(await f.api.auth.internal(proof), true);
  assert.equal(await f.api.auth.internal(proof), false);
});
test('fresh store lookup observes revocation; expiry during lookup fails', async () => {
  const f = fixture();
  await f.api.resolve({route: 'status'});
  f.capability.revoked = true;
  await assert.rejects(f.api.resolve({route: 'status'}), /UNAUTHORIZED/);
  const g = fixture({capabilityStore: {resolve: async () => {g.setTime(200); return g.capability;}}});
  await assert.rejects(g.api.resolve({route: 'create'}), /UNAUTHORIZED/);
});
test('verifier exceptions and gateway capability leaks produce sanitized errors', async () => {
  const f = fixture();
  for (const gateway of [async () => {throw new Error(f.capability.token);},
    async x => ({status: 200, body: {nested: [x.credentials]}}),
    async x => ({status: 200, headers: {secret: 'prefix-' + x.credentials}})]) {
    const result = await f.api.dispatch(gateway, {deadline: Date.now()+5000, route: 'status'});
    assert.deepEqual(result, {status: 503, body: {error: 'AUTH_UNAVAILABLE'}});
    assert.ok(!JSON.stringify(result).includes(f.capability.token));
  }
  const g = fixture({verifySession: async () => {throw new Error('secret');}});
  assert.deepEqual(await g.api.dispatch(() => assert.fail('must not call'), {route: 'create'}),
    {status: 401, body: {error: 'UNAUTHORIZED'}});
});
test('dispatch checks cancellation after deferred auth and never calls gateway',async()=>{
 for(const kind of ['abort','deadline']){
  let release;const pending=new Promise(r=>release=r);const f=fixture({verifySession:async()=>{await pending;return f.session;}});const controller=new AbortController();let called=0;
  const result=f.api.dispatch(async()=>{called++;return {status:200,body:{}};},{route:'status',signal:controller.signal,deadline:kind==='deadline'?Date.now()-1:Date.now()+5000});
  if(kind==='abort')controller.abort();release();assert.deepEqual(await result,{status:504,body:{error:'REQUEST_CANCELLED'}});assert.equal(called,0);
 }
});
