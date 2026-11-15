import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createCapabilityStore, createCapabilityProvisioner} from '../capability-store.mjs';
import {createHttpAuth} from '../http-auth.mjs';
import {createGateway} from '../gateway.mjs';
import {createServer} from '../http-server.mjs';
import {createEnvelope} from '../../storefront/api-v2/contract.mjs';
const endpoint = 'http://localhost:9999/pay-v2';
function envelope(suffix = '12345678') {
  const customer = {name: 'Synthetic', email: 'test@example.invalid', phone: '79000000000', address: 'Synthetic', contactPref: 'phone'};
  const id = `LE-1791000000000-V2-${suffix}`;
  return createEnvelope({orderId: id, clientId: 'untrusted', paymentMethod: 'card', amount: 1,
    description: 'synthetic', email: customer.email, phone: customer.phone, address: customer.address,
    contactPref: customer.contactPref, customer, delivery: {address: customer.address},
    items: [{productId: 'fixture', variantId: 'fixture', kind: 'tree', quantity: 1, price: 1}],
    promo: null, promoCode: '', successUrl: `http://localhost:4176/spasibo?oid=${id}`,
    failUrl: `http://localhost:4176/pay-return?oid=${id}&fail=1`}, endpoint);
}
async function fixture(t) {
  const db = new PGlite();
  t.after(async () => {await stop(); await db.close();});
  let server, base, store, banks = 0;
  for (const file of ['schema-draft.sql', 'roles-draft.sql', 'capability-store-draft.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  await db.exec("INSERT INTO le_checkout_v2.budgets(key,capacity,window_ms,owner_capacity) SELECT unnest(ARRAY['create','request','ownerRequest','replay','status','callback','internal','bank','telegram']),1000,60000,1000; UPDATE le_checkout_v2.gateway_policy SET create_open=true");
  // Identity switching is privileged disposable-fixture setup, never application SQL.
  // PGlite has one physical session: serialize each role-bound query independently.
  let tail = Promise.resolve();
  const roleExecutor = role => ({query(sql, args) {
    const operation = tail.then(async () => {
      await db.exec('SET SESSION AUTHORIZATION ' + role);
      try {return await db.query(sql, args);} finally {await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');}
    });
    tail = operation.catch(() => {}); return operation;
  }});
  const executors = Object.fromEntries(['create', 'status', 'callback', 'internal'].map(role => [role, roleExecutor('le_v2_' + role)]));
  const resolverExecutor = roleExecutor('le_v2_cap_resolver');
  const sessionHashKey = Buffer.alloc(32, 11);
  const operatorExecutor = roleExecutor('le_v2_cap_provisioner');
  const provisioner = createCapabilityProvisioner({executor: operatorExecutor, sessionHashKey});
  const sessions = new Map();
  const tokens = new Set();
  // Synthetic session verifier only; capability lookup itself is exclusively real SQL.
  for (const owner of ['alice', 'bob']) sessions.set('Bearer ' + owner,
    {sessionId: 'server-session-' + owner, owner, scopes: ['create', 'status'], revoked: false, expiresMs: Date.now() + 60000});
  async function stop() {
    if (!server) return;
    const previous = server; server = undefined;
    await new Promise(resolve => {previous.close(resolve); previous.closeAllConnections();});
  }
  async function start() {
    await stop();
    store = createCapabilityStore({executor: resolverExecutor, sessionHashKey});
    const auth = createHttpAuth({verifySession: async request => sessions.get(request.headers.authorization), capabilityStore: store});
    const gateway = createGateway({executors, auth: auth.auth,
      identity: {apiVersion: '2', fingerprintVersion: 'sha256-canonical-json-v1', ownerEndpoint: endpoint},
      verifyCatalog: async () => ({verified: true, fresh: true, revision: 'fixture', amountMinor: 100}),
      recipients: ['synthetic'], paymentOrigins: ['https://mock-bank.invalid'],
      provider: {register: async ({order}) => {
        banks++;
        return {outcome: 'confirmed', paymentId: 'p-' + order.id, bankNumber: order.bank_number,
          amount: Number(order.amount), paymentURL: 'https://mock-bank.invalid/pay'};
      }}, notifier: {send: async () => ({outcome: 'confirmed'})}});
    server = createServer({gateway: input => auth.dispatch(gateway, input), timeoutMs: 5000});
    await new Promise(resolve => server.listen(0, resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  async function issue(owner = 'alice', scopes = ['create', 'status']) {
    const session = sessions.get('Bearer ' + owner);
    await provisioner.issue({sessionId: session.sessionId, owner: session.owner, expiresMs: session.expiresMs, scopes});
    const record = await store.resolve({sessionId: session.sessionId, owner: session.owner, scope: scopes[0]});
    assert.ok(record); tokens.add(record.token); return record;
  }
  async function call(route, body, authorization = 'Bearer alice') {
    const response = await fetch(base + '/v2/' + route, {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: authorization}, body: JSON.stringify(body)});
    const raw = await response.text(), headers = Object.fromEntries(response.headers);
    for (const token of tokens) {
      assert.ok(!raw.includes(token), 'private capability leaked in HTTP body');
      assert.ok(!JSON.stringify(headers).includes(token), 'private capability leaked in HTTP headers');
    }
    return {status: response.status, body: JSON.parse(raw), headers};
  }
  await start();
  return {db, operatorExecutor, provisioner, sessions, tokens, issue, call, restart: start, getStore: () => store, banks: () => banks};
}
test('real HTTP private SQL capability survives store/auth/server recreation and revoke denies HTTP plus SQL', async t => {
  const f = await fixture(t), env = envelope();
  assert.equal((await f.call('create', env)).status, 401, 'no private mapping yet');
  const record = await f.issue();
  assert.equal((await f.call('create', env)).status, 200);
  const initial = await f.call('status', {orderId: env.orderId});
  assert.equal(initial.status, 200); assert.equal(initial.body.paymentURL, 'https://mock-bank.invalid/pay');
  assert.equal(f.banks(), 1);
  const oldStore = f.getStore();
  await f.restart();
  assert.notEqual(f.getStore(), oldStore);
  const session = f.sessions.get('Bearer alice');
  assert.equal((await f.getStore().resolve({...session, scope: 'status'})).token, record.token);
  assert.deepEqual((await f.call('status', {orderId: env.orderId})).body, initial.body);
  assert.equal((await f.call('create', env)).status, 200); assert.equal(f.banks(), 1);
  await f.provisioner.revoke({sessionId: session.sessionId, owner: session.owner});
  assert.equal(session.revoked, false, 'verifier remains live: denial must come from actual SQL mapping');
  for (const route of ['create', 'status'])
    assert.equal((await f.call(route, route === 'create' ? env : {orderId: env.orderId})).status, 401);
  await assert.rejects(f.db.query("SELECT le_checkout_v2.cap_owner($1,'status')", [record.token]), /UNAUTHORIZED/);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.capabilities WHERE token=$1', [record.token])).rows[0].n, 0);
  await f.restart();
  assert.equal((await f.call('status', {orderId: env.orderId})).status, 401); assert.equal(f.banks(), 1);
  await assert.rejects(f.issue(), /SESSION_REVOKED/);
  const mapping = (await f.db.query('SELECT * FROM le_checkout_v2.session_capabilities')).rows[0];
  await assert.rejects(f.operatorExecutor.query('SELECT le_checkout_v2.cap_issue($1,$2,$3,$4,true,true)',
    [mapping.session_hash, session.owner, 'd'.repeat(64), Date.now() + 60000]), /SESSION_REVOKED/);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.orders')).rows[0].n, 1);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.effects')).rows[0].n, 1);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.bank_queue')).rows[0].n, 1);
  f.sessions.set('Bearer alice-new', {...session, sessionId: 'new-explicitly-authenticated-alice-session'});
  const newSession = f.sessions.get('Bearer alice-new');
  await f.provisioner.issue({...newSession});
  const newRecord = await f.getStore().resolve({...newSession, scope: 'status'});
  assert.ok(newRecord); f.tokens.add(newRecord.token);
  assert.deepEqual((await f.call('status', {orderId: env.orderId}, 'Bearer alice-new')).body, initial.body);
  assert.equal((await f.call('create', env, 'Bearer alice-new')).status, 200);
  assert.equal(f.banks(), 1, 'new session exact replay must not register again');
  assert.equal((await f.call('status', {orderId: env.orderId})).status, 401);
});
test('real HTTP owner and scope isolation: body credentials never select SQL capability', async t => {
  const f = await fixture(t), alice = envelope(), bob = envelope('abcdef12');
  const aliceToken = (await f.issue('alice', ['create'])).token;
  await f.issue('bob', ['status']);
  assert.equal((await f.call('create', alice)).status, 200);
  assert.equal((await f.call('status', {orderId: alice.orderId})).status, 401, 'create-only cannot read status');
  assert.equal((await f.call('create', bob, 'Bearer bob')).status, 401, 'status-only cannot create');
  const foreign = await f.call('status', {orderId: alice.orderId, owner: 'alice', sessionId: 'server-session-alice', credentials: aliceToken}, 'Bearer bob');
  assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, {error: 'NOT_FOUND'});
  assert.deepEqual((await f.call('status', {orderId: 'missing'}, 'Bearer bob')).body, foreign.body);
  f.sessions.set('Bearer mismatched', {...f.sessions.get('Bearer alice'), owner: 'bob'});
  assert.equal((await f.call('status', {orderId: alice.orderId}, 'Bearer mismatched')).status, 401);
  await f.issue('alice'); await f.issue('bob');
  assert.equal((await f.call('create', bob, 'Bearer bob')).status, 200);
  assert.equal((await f.call('status', {orderId: bob.orderId})).status, 404);
  assert.equal((await f.call('status', {orderId: alice.orderId})).status, 200);
  assert.deepEqual((await f.db.query('SELECT owner FROM le_checkout_v2.orders ORDER BY owner')).rows, [{owner: 'alice'}, {owner: 'bob'}]);
  assert.equal(f.banks(), 2);
});
test('real HTTP exact replay after capability rotation does not register twice; SQL expiry independently denies', async t => {
  const f = await fixture(t), env = envelope();
  const first = await f.issue();
  assert.equal((await f.call('create', env)).status, 200);
  const initial = await f.call('status', {orderId: env.orderId});
  const next = await f.issue(); assert.notEqual(next.token, first.token);
  await assert.rejects(f.db.query("SELECT le_checkout_v2.cap_owner($1,'create')", [first.token]), /UNAUTHORIZED/);
  const responses = await Promise.all(Array.from({length: 4}, () => f.call('create', env)));
  assert.ok(responses.every(response => response.status === 200), JSON.stringify(responses));
  assert.equal(f.banks(), 1);
  assert.deepEqual((await f.call('status', {orderId: env.orderId})).body, initial.body);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.orders')).rows[0].n, 1);
  await f.db.query('UPDATE le_checkout_v2.capabilities SET expires_ms=0 WHERE token=$1', [next.token]);
  assert.equal((await f.call('status', {orderId: env.orderId})).status, 401);
  await assert.rejects(f.db.query("SELECT le_checkout_v2.cap_owner($1,'status')", [next.token]), /UNAUTHORIZED/);
  assert.equal(f.banks(), 1);
});
