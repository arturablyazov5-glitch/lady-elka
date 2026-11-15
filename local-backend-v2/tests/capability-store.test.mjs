import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createCapabilityStore, createCapabilityProvisioner} from '../capability-store.mjs';
const key = Buffer.alloc(32, 7);
const session = {sessionId: 'opaque-server-session-id', owner: 'alice'};
const issuance = () => ({...session, expiresMs: Date.now() + 60000, scopes: ['create', 'status']});
async function fixture() {
  const db = new PGlite();
  for (const file of ['schema-draft.sql', 'roles-draft.sql', 'capability-store-draft.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  let tail = Promise.resolve();
  // Single PGlite physical session: serialize identity switching ONLY in fixture.
  const executor = role => ({query(sql, args) {
    const task = tail.then(async () => {
      await db.exec('SET SESSION AUTHORIZATION ' + role);
      try {return await db.query(sql, args);} finally {await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');}
    });
    tail = task.catch(() => {}); return task;
  }});
  const runtime = executor('le_v2_cap_resolver'), operator = executor('le_v2_cap_provisioner');
  const options = {executor: runtime, sessionHashKey: key};
  return {db, runtime, operator, options, store: createCapabilityStore(options),
    provisioner: createCapabilityProvisioner({executor: operator, sessionHashKey: key})};
}
test('persistent lookup after object recreation; no plaintext session or issue token response', async () => {
  const f = await fixture(); try {
    const response = await f.provisioner.issue(issuance());
    assert.deepEqual(Object.keys(response).sort(), ['expiresMs', 'scopes']);
    const record = await createCapabilityStore(f.options).resolve({...session, scope: 'create'});
    assert.equal(record.sessionId, session.sessionId); assert.equal(record.owner, 'alice');
    assert.match(record.token, /^[a-f0-9]{64}$/); assert.deepEqual(record.scopes, ['create', 'status']);
    const persisted = (await f.db.query('SELECT * FROM le_checkout_v2.session_capabilities')).rows;
    assert.equal(persisted.length, 1); assert.ok(!JSON.stringify(persisted).includes(session.sessionId));
    assert.equal((await f.db.query("SELECT le_checkout_v2.cap_owner($1,'create') AS owner", [record.token])).rows[0].owner, 'alice');
  } finally {await f.db.close();}
});
test('owner/session/scope isolation in module and SQL, immutable session owner', async () => {
  const f = await fixture(); try {
    await f.provisioner.issue({...issuance(), scopes: ['status']});
    for (const query of [{...session, owner: 'bob', scope: 'status'}, {...session, sessionId: 'other', scope: 'status'}, {...session, scope: 'create'}])
      assert.equal(await f.store.resolve(query), null);
    await assert.rejects(f.store.resolve({...session, scope: 'internal'}), /UNAUTHORIZED/);
    const record = await f.store.resolve({...session, scope: 'status'});
    await assert.rejects(f.db.query("SELECT le_checkout_v2.cap_owner($1,'create')", [record.token]), /UNAUTHORIZED/);
    await assert.rejects(f.provisioner.issue({...issuance(), owner: 'bob'}), /CAPABILITY_UNAVAILABLE/);
    await assert.rejects(f.provisioner.revoke({...session, owner: 'bob'}), /CAPABILITY_UNAVAILABLE/);
    assert.equal((await f.store.resolve({...session, scope: 'status'})).token, record.token);
  } finally {await f.db.close();}
});
test('expiry enforced independently by module and SQL; revocation removes SQL authority', async () => {
  const f = await fixture(); try {
    const grant = issuance(); await f.provisioner.issue(grant);
    const record = await f.store.resolve({...session, scope: 'status'});
    const future = createCapabilityStore({...f.options, now: () => grant.expiresMs});
    assert.equal(await future.resolve({...session, scope: 'status'}), null);
    await f.db.query('UPDATE le_checkout_v2.capabilities SET expires_ms=0 WHERE token=$1', [record.token]);
    assert.equal(await f.store.resolve({...session, scope: 'status'}), null);
    await assert.rejects(f.db.query("SELECT le_checkout_v2.cap_owner($1,'status')", [record.token]), /UNAUTHORIZED/);
    await f.provisioner.issue(issuance());
    const active = await f.store.resolve({...session, scope: 'create'});
    assert.deepEqual(await f.provisioner.revoke(session), {revoked: true});
    await f.provisioner.revoke(session);
    assert.equal(await f.store.resolve({...session, scope: 'create'}), null);
    await assert.rejects(f.db.query("SELECT le_checkout_v2.cap_owner($1,'create')", [active.token]), /UNAUTHORIZED/);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.capabilities')).rows[0].n, 0);
  } finally {await f.db.close();}
});
test('concurrent issuance leaves one binding and one valid authority; rotation invalidates old token', async () => {
  const f = await fixture(); try {
    await f.provisioner.issue(issuance());
    const old = await f.store.resolve({...session, scope: 'status'});
    await Promise.all(Array.from({length: 12}, () => f.provisioner.issue(issuance())));
    const active = await f.store.resolve({...session, scope: 'status'});
    assert.notEqual(old.token, active.token);
    for (const table of ['capabilities', 'session_capabilities'])
      assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM le_checkout_v2.${table}`)).rows[0].n, 1);
    await assert.rejects(f.db.query("SELECT le_checkout_v2.cap_owner($1,'status')", [old.token]), /UNAUTHORIZED/);
    const results = await Promise.allSettled([f.provisioner.issue(issuance()), f.provisioner.revoke(session)]);
    assert.equal(results[1].status, 'fulfilled');
    if (results[0].status === 'rejected') assert.equal(results[0].reason.message, 'SESSION_REVOKED');
    assert.equal(await f.store.resolve({...session, scope: 'status'}), null);
    await assert.rejects(f.provisioner.issue(issuance()), /SESSION_REVOKED/);
    const mapping = (await f.db.query('SELECT * FROM le_checkout_v2.session_capabilities')).rows[0];
    await assert.rejects(f.operator.query('SELECT le_checkout_v2.cap_issue($1,$2,$3,$4,true,true)',
      [mapping.session_hash, session.owner, 'c'.repeat(64), Date.now() + 60000]), /SESSION_REVOKED/);
    assert.equal(mapping.revoked, true); assert.equal(mapping.token, null);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.capabilities')).rows[0].n, 0);
    // Reverse arrival order also stays closed: issue must not lift the tombstone.
    const reverse = await Promise.allSettled([f.provisioner.revoke(session), f.provisioner.issue(issuance())]);
    assert.equal(reverse[0].status, 'fulfilled'); assert.equal(reverse[1].status, 'rejected');
    assert.equal(reverse[1].reason.message, 'SESSION_REVOKED');
    assert.equal(await f.store.resolve({...session, scope: 'status'}), null);
    const newSession = {...issuance(), sessionId: 'new-authenticated-session'};
    await f.provisioner.issue(newSession);
    assert.ok(await f.store.resolve({...newSession, scope: 'status'}));
    assert.equal(await f.store.resolve({...session, scope: 'status'}), null);
  } finally {await f.db.close();}
});
test('partial insert failure rolls rotation back, including mapping and previous capability', async () => {
  const f = await fixture(); try {
    await f.provisioner.issue(issuance());
    const old = await f.store.resolve({...session, scope: 'status'});
    await f.db.exec("CREATE FUNCTION public.reject_cap_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insert failure'; END $$; CREATE TRIGGER reject_cap BEFORE INSERT ON le_checkout_v2.capabilities FOR EACH ROW EXECUTE FUNCTION public.reject_cap_insert()");
    await assert.rejects(f.provisioner.issue(issuance()), /CAPABILITY_UNAVAILABLE/);
    assert.equal((await f.store.resolve({...session, scope: 'status'})).token, old.token);
    assert.equal((await f.db.query("SELECT le_checkout_v2.cap_owner($1,'status') AS owner", [old.token])).rows[0].owner, 'alice');
    await assert.rejects(f.provisioner.issue({...issuance(), sessionId: 'new-session'}), /CAPABILITY_UNAVAILABLE/);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM le_checkout_v2.session_capabilities')).rows[0].n, 1);
  } finally {await f.db.close();}
});
test('real runtime ACL rejects provisioning/table access/escalation and privileged executors', async () => {
  const f = await fixture(); try {
    const h = 'a'.repeat(64), token = 'b'.repeat(64);
    for (const sql of ["SELECT le_checkout_v2.cap_issue($1,'alice',$2,9999999999999,true,true)", "SELECT le_checkout_v2.cap_revoke($1,'alice')"])
      await assert.rejects(f.runtime.query(sql, sql.includes('cap_issue') ? [h, token] : [h]), e => e.code === '42501');
    for (const table of ['session_capabilities', 'capabilities']) {
      for (const action of ['SELECT * FROM', 'DELETE FROM', 'INSERT INTO']) {
        const sql = action === 'INSERT INTO' ? `INSERT INTO le_checkout_v2.${table} DEFAULT VALUES` : `${action} le_checkout_v2.${table}`;
        await assert.rejects(f.runtime.query(sql), e => e.code === '42501');
      }
    }
    await assert.rejects(f.runtime.query('SET ROLE le_v2_cap_provisioner'), e => e.code === '42501');
    await assert.rejects(f.operator.query("SELECT * FROM le_checkout_v2.cap_resolve($1,'alice','status')", [h]), e => e.code === '42501');
    const bad = createCapabilityProvisioner({executor: f.runtime, sessionHashKey: key});
    await assert.rejects(bad.issue(issuance()), /CAPABILITY_UNAVAILABLE/);
    await assert.rejects(createCapabilityStore({executor: f.db, sessionHashKey: key}).resolve({...session, scope: 'status'}), /CAPABILITY_UNAVAILABLE/);
  } finally {await f.db.close();}
});
test('fail closed configuration/input and independent SQL input checks', async () => {
  assert.throws(() => createCapabilityStore(), /CAPABILITY_UNAVAILABLE/);
  const f = await fixture(); try {
    for (const patch of [{expiresMs: 0}, {scopes: ['internal']}, {scopes: []}, {scopes: ['status', 'status']}])
      await assert.rejects(f.provisioner.issue({...issuance(), ...patch}), /INVALID_CAPABILITY/);
    for (const [expiry, create, status] of [[0, true, true], [9999999999999, false, false]])
      await assert.rejects(f.operator.query('SELECT le_checkout_v2.cap_issue($1,$2,$3,$4,$5,$6)', ['a'.repeat(64), 'alice', 'b'.repeat(64), expiry, create, status]), /INVALID_CAPABILITY/);
    const changedKey = createCapabilityStore({...f.options, sessionHashKey: Buffer.alloc(32, 8)});
    await f.provisioner.issue(issuance());
    assert.equal(await changedKey.resolve({...session, scope: 'status'}), null);
  } finally {await f.db.close();}
});
