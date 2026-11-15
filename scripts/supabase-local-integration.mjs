import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGED_MIGRATIONS,
  STAGED_SHARED_MODULES,
  buildLocalFunctionEnv,
  cleanupOwnedResources,
  createCommandRunner,
  effectFilter,
  functionServeArgs,
  networkCreateArgs,
  networkInspectArgs,
  preflightLocalRuntime,
  providerCallQuery,
  supabaseResetArgs,
  supabaseStartArgs,
  validatePublishedBindings
} from '../supabase/local-integration/harness-core.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supabaseBin = process.env.SUPABASE_BIN || 'supabase';
const dockerBin = process.env.DOCKER_BIN || 'docker';
const testRunId = randomUUID().replaceAll('-', '').slice(0, 12);
const projectId = `lady-elka-it-${testRunId}`;
const networkName = `le-it-${testRunId}`;
const runAbortController = new AbortController();

let projectDir = '';
let envPath = '';
let functionProcess = null;
let functionProcessError = null;
let networkCreated = false;
let projectMayBeRunning = false;
let localApiUrl = '';
let localServiceKey = '';
let localAnonKey = '';
let localJwtSecret = '';
let cronCleanupNeeded = false;
const report = { postgresPostgrest: [], edge: [], background: [], extensions: {} };

const command = createCommandRunner({ spawnProcess: spawn, defaultSignal: runAbortController.signal });

function shortToken() { return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''); }
function sqlQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function b64url(value) { return Buffer.from(value).toString('base64url'); }

async function requireSuccess(commandName, args, options = {}) {
  const result = await command(commandName, args, options);
  if (result.timedOut) throw new Error(`${commandName} timed out; cleanup will run for this test project.`);
  if (result.aborted) throw new Error(`${commandName} was interrupted; cleanup will run for this test project.`);
  if (result.code !== 0) throw new Error(`${commandName} exited with status ${result.code}`);
  return result.stdout;
}

function parseEnvOutput(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function isPortAvailable(port) {
  const server = createServer();
  return new Promise(resolvePort => {
    server.once('error', () => resolvePort(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)));
  });
}

async function choosePorts() {
  for (let base = Number(process.env.LE_LOCAL_SUPABASE_PORT_BASE || 55421); base < 64000; base += 11) {
    const values = Array.from({ length: 8 }, (_, index) => base + index);
    const checks = await Promise.all(values.map(isPortAvailable));
    if (checks.every(Boolean)) {
      return { api: base, db: base + 1, shadow: base + 2, studio: base + 3,
        mailpit: base + 4, analytics: base + 5, inspector: base + 6, pooler: base + 7 };
    }
  }
  throw new Error('Could not find a free local port block for the isolated Supabase project.');
}

async function fetchLocal(url, options = {}, timeoutMs = 10000) {
  if (runAbortController.signal.aborted) throw new Error('Local integration run was interrupted.');
  const target = new URL(url);
  const expected = new URL(localApiUrl);
  if (target.origin !== expected.origin || target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
      || target.username || target.password) throw new Error('Local harness rejected a non-local request before fetch.');
  const controller = new AbortController();
  const abortRun = () => controller.abort(runAbortController.signal.reason);
  runAbortController.signal.addEventListener('abort', abortRun, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Local request timed out.')), timeoutMs);
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timer);
    runAbortController.signal.removeEventListener('abort', abortRun);
  }
}

function configToml(ports) {
  return `project_id = "${projectId}"

[api]
enabled = true
port = ${ports.api}
schemas = ["public", "storage", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = ${ports.db}
shadow_port = ${ports.shadow}
major_version = 15

[db.seed]
enabled = false
sql_paths = []

[studio]
enabled = false
port = ${ports.studio}

[auth]
enabled = true
site_url = "http://127.0.0.1:${ports.api}"
jwt_expiry = 3600
enable_signup = true

[auth.email]
enable_signup = true
enable_confirmations = false

[storage]
enabled = true
file_size_limit = "10MiB"

[edge_runtime]
enabled = true
policy = "per_worker"
inspector_port = ${ports.inspector}

[functions.pay]
verify_jwt = false

[functions.pay-instance-a]
verify_jwt = false

[functions.pay-instance-b]
verify_jwt = false

[functions.local-mock-provider]
verify_jwt = false
`;
}

async function stageProject(ports) {
  projectDir = await mkdtemp(join(tmpdir(), `lady-elka-supabase-${testRunId}-`));
  const supabaseDir = join(projectDir, 'supabase');
  const migrationsDir = join(supabaseDir, 'migrations');
  const functionsDir = join(supabaseDir, 'functions');
  await mkdir(migrationsDir, { recursive: true });
  await mkdir(join(functionsDir, '_shared'), { recursive: true });
  await writeFile(join(supabaseDir, 'config.toml'), configToml(ports), { mode: 0o600 });

  // Deliberately stage only the synthetic payment_orders baseline and the two
  // requested migrations. Historical cron SQL with remote targets is excluded.
  const stagedFiles = STAGED_MIGRATIONS;
  for (const [name, source] of stagedFiles) {
    await cp(join(repo, source), join(migrationsDir, name));
  }
  const names = (await readdir(migrationsDir)).sort();
  assert.deepEqual(names, stagedFiles.map(([name]) => name).sort(), 'only the safe baseline and the target migrations are staged');

  const paySource = join(repo, 'supabase/functions/pay/index.ts');
  for (const name of ['pay', 'pay-instance-a', 'pay-instance-b']) {
    const functionDir = join(functionsDir, name);
    await mkdir(functionDir, { recursive: true });
    await cp(paySource, join(functionDir, 'index.ts'));
  }
  for (const name of STAGED_SHARED_MODULES) {
    await cp(join(repo, 'supabase/functions/_shared', name), join(functionsDir, '_shared', name));
  }
  await cp(join(repo, 'supabase/local-integration/mock-provider'), join(functionsDir, 'local-mock-provider'), { recursive: true });
  return { ports, supabaseDir, functionsDir };
}

async function assertPublishedPortsLoopback() {
  const inspect = await requireSuccess(dockerBin, [
    'network', 'inspect', networkName, '--format', '{{json .}}'
  ]);
  const networkInfo = JSON.parse(inspect);
  assert.equal(networkInfo.Internal, true, 'container network blocks external egress');
  assert.equal(networkInfo.Options?.['com.docker.network.bridge.host_binding_ipv4'], '127.0.0.1',
    'Docker network publishes ports only on IPv4 loopback');
  const containerIds = Object.keys(networkInfo.Containers || {});
  assert.ok(containerIds.length > 0, 'the isolated project attached containers to its private network');
  let publishedBindings = 0;
  for (const containerId of containerIds) {
    const output = await requireSuccess(dockerBin, [
      'inspect', '--format', '{{json .NetworkSettings.Ports}}', containerId
    ]);
    const bindings = JSON.parse(output || '{}');
    publishedBindings += validatePublishedBindings(bindings);
  }
  assert.ok(publishedBindings > 0, 'the local API exposes at least one verified loopback port');
}

async function rest(path, { role = 'service', method = 'GET', body, headers = {}, prefer } = {}) {
  const key = role === 'anon' || role === 'authenticated' ? localAnonKey : localServiceKey;
  const bearer = role === 'authenticated' ? authenticatedJwt : role === 'anon' ? localAnonKey : localServiceKey;
  const requestHeaders = { apikey: key, Authorization: `Bearer ${bearer}`, ...headers };
  if (body !== undefined && !Object.keys(requestHeaders).some(name => name.toLowerCase() === 'content-type')) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  if (prefer) requestHeaders.Prefer = prefer;
  return fetchLocal(`${localApiUrl}/rest/v1/${path}`, {
    method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

let authenticatedJwt = '';
function makeJwt(role) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: 'supabase', aud: role, role, sub: randomUUID(), iat: now, exp: now + 600 }));
  const signature = createHmac('sha256', localJwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function functionCall(name, action, body = {}, headers = {}) {
  const url = new URL(`${localApiUrl}/functions/v1/${name}`);
  if (action) url.searchParams.set('action', action);
  const response = await fetchLocal(url, {
    method: 'POST',
    headers: { apikey: localAnonKey, Authorization: `Bearer ${localAnonKey}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  return { status: response.status, body: payload };
}

async function providerConfig(patch) {
  const currentResponse = await rest('local_provider_state?id=eq.1&select=config');
  assert.equal(currentResponse.status, 200, 'mock provider config can be read by service_role');
  const current = (await currentResponse.json())[0].config;
  const response = await rest('local_provider_state?id=eq.1', {
    method: 'PATCH', body: { config: { ...current, ...patch } }, prefer: 'return=representation'
  });
  assert.equal(response.status, 200, 'mock provider config can be changed through PostgREST');
  return (await response.json())[0].config;
}

async function providerCalls(provider, operation, orderId) {
  const query = providerCallQuery(provider, operation, orderId);
  const response = await rest(`local_provider_calls?${query}`);
  assert.equal(response.status, 200, 'mock provider counts are readable by service_role');
  return response.json();
}

async function getOrder(orderId) {
  const response = await rest(`le_orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`);
  assert.equal(response.status, 200, 'order row is readable over PostgREST with service_role');
  return (await response.json())[0];
}

async function getEffects(orderId, prefix) {
  const filter = effectFilter(orderId, prefix);
  const response = await rest(`le_order_effects?${filter}&select=effect_key,state,attempt_count,next_attempt_at,result&order=effect_key.asc`);
  assert.equal(response.status, 200, 'effects are readable over PostgREST with service_role');
  return response.json();
}

function newOrderId() {
  return `LE-${Date.now()}-180-${randomUUID().slice(0, 8)}`;
}

function orderPayload(orderId, paymentMethod = 'cash_on_delivery') {
  const customer = { name: 'Локальный тест', email: `test-${randomUUID().slice(0, 8)}@example.test`,
    phone: '+79990000000', address: 'Тестовый адрес', contactPref: 'Telegram', comment: 'synthetic integration data' };
  return {
    orderId, paymentMethod, amount: 1250, description: 'Локальная тестовая ель — 1250 ₽',
    email: customer.email, phone: customer.phone, clientId: customer.name,
    customer, delivery: { address: customer.address },
    items: [{ productId: 'local-tree-1', variantId: 'local-tree-1:Зелёная:180', kind: 'tree', quantity: 1, price: 1250 }],
    promo: null, promoCode: '', address: customer.address, contactPref: customer.contactPref,
    successUrl: `${localApiUrl}/spasibo?oid=${encodeURIComponent(orderId)}`,
    failUrl: `${localApiUrl}/pay-return?fail=1&oid=${encodeURIComponent(orderId)}`
  };
}

function assertJson(response, message) {
  assert.ok(response.ok, `${message} (HTTP ${response.status})`);
  return response.json();
}

async function seedCatalog(apiPort) {
  const headers = { apikey: localServiceKey, Authorization: `Bearer ${localServiceKey}` };
  const bucket = await fetchLocal(`${localApiUrl}/storage/v1/bucket`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'le-catalog-feeds', name: 'le-catalog-feeds', public: true })
  });
  assert.ok(bucket.ok, `local public CSV bucket created (HTTP ${bucket.status})`);
  const csv = {
    'trees.csv': 'id,title,active,category,height_cm,price\nlocal-tree-1,Тестовая ель,1,Зелёная,180,1250\n',
    'decor.csv': 'id,title,active,category,variants,price\n',
    'promos.csv': 'promocode,ruble-offer,percent-offer,gift-offer\nLOCAL,100,0,\n'
  };
  for (const [name, contents] of Object.entries(csv)) {
    const response = await fetchLocal(`${localApiUrl}/storage/v1/object/le-catalog-feeds/${name}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'text/csv', 'x-upsert': 'true' }, body: contents
    });
    assert.ok(response.ok, `synthetic ${name} uploaded to local Storage (HTTP ${response.status})`);
  }
  const publicCsv = await fetchLocal(`${localApiUrl}/storage/v1/object/public/le-catalog-feeds/trees.csv`);
  assert.equal(publicCsv.status, 200, 'public local catalog feed is served by Supabase Storage');
  assert.match(await publicCsv.text(), /local-tree-1/);
  return apiPort;
}

async function sqlResult(sql) {
  const stdout = await requireSuccess(supabaseBin, [
    'db', 'query', '--local', '--workdir', projectDir, '--output-format', 'json', sql
  ]);
  const start = stdout.search(/^\s*[\[{]/m);
  if (start < 0) throw new Error('Supabase SQL query returned no structured result.');
  let value;
  try { value = JSON.parse(stdout.slice(start)); }
  catch { throw new Error('Supabase SQL query returned an unreadable structured result.'); }
  if (Array.isArray(value)) return value[0] || {};
  if (Array.isArray(value.rows)) return value.rows[0] || {};
  return value;
}

async function sqlFile(sql, name, options = {}) {
  const file = join(projectDir, 'supabase', name);
  await writeFile(file, sql, { mode: 0o600 });
  await requireSuccess(supabaseBin, ['db', 'query', '--local', '--workdir', projectDir, '--file', file], options);
  return file;
}

async function checkMigrationSet() {
  const result = await sqlResult(`select json_build_object(
    'versions', (select array_agg(version order by version) from supabase_migrations.schema_migrations)
  ) as diagnostics`);
  const diagnostics = result.diagnostics || result;
  assert.deepEqual(diagnostics.versions, ['20261001110000', '20261001120000', '20261001130000', '20261008160000']);
  report.postgresPostgrest.push('Migration history contains only the synthetic payment_orders baseline and the three target migrations.');
}

async function checkGrantsAndRpc() {
  const result = await sqlResult(`select json_build_object(
    'orders_rls', (select relrowsecurity from pg_class where oid = 'public.le_orders'::regclass),
    'effects_rls', (select relrowsecurity from pg_class where oid = 'public.le_order_effects'::regclass),
    'orders_anon_select', has_table_privilege('anon', 'public.le_orders', 'SELECT'),
    'orders_anon_insert', has_table_privilege('anon', 'public.le_orders', 'INSERT'),
    'effects_auth_select', has_table_privilege('authenticated', 'public.le_order_effects', 'SELECT'),
    'effects_auth_update', has_table_privilege('authenticated', 'public.le_order_effects', 'UPDATE'),
    'orders_public_acl', exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      where c.oid = 'public.le_orders'::regclass and x.grantee = 0 and x.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')),
    'orders_service_select', has_table_privilege('service_role', 'public.le_orders', 'SELECT'),
    'orders_service_insert', has_table_privilege('service_role', 'public.le_orders', 'INSERT'),
    'orders_service_update', has_table_privilege('service_role', 'public.le_orders', 'UPDATE'),
    'rpc_anon', has_function_privilege('anon', 'public.le_recover_bank_order(text,text,integer,bigint,text,text)', 'EXECUTE'),
    'rpc_authenticated', has_function_privilege('authenticated', 'public.le_recover_bank_order(text,text,integer,bigint,text,text)', 'EXECUTE'),
    'rpc_service', has_function_privilege('service_role', 'public.le_recover_bank_order(text,text,integer,bigint,text,text)', 'EXECUTE')
  ) as diagnostics`);
  const d = result.diagnostics || result;
  assert.equal(d.orders_rls, true);
  assert.equal(d.effects_rls, true);
  assert.equal(d.orders_anon_select, false);
  assert.equal(d.orders_anon_insert, false);
  assert.equal(d.effects_auth_select, false);
  assert.equal(d.effects_auth_update, false);
  assert.equal(d.orders_public_acl, false);
  assert.equal(d.orders_service_select, true);
  assert.equal(d.orders_service_insert, true);
  assert.equal(d.orders_service_update, true);
  assert.equal(d.rpc_anon, false);
  assert.equal(d.rpc_authenticated, false);
  assert.equal(d.rpc_service, true);
  report.postgresPostgrest.push('RLS, table grants, public ACLs, and RPC execute grants verified by PostgreSQL catalogs.');
}

async function checkRestRolesAndProtocol() {
  const id = newOrderId();
  const order = { order_id: id, fingerprint: 'a'.repeat(64), payment_method: 'card', status: 'received',
    payload: { source: 'local-it', nested: { value: 7 } }, total: '1500.50', created_at: new Date(Date.now() - 120000).toISOString() };
  const inserted = await rest('le_orders?on_conflict=order_id', {
    method: 'POST', body: order, prefer: 'resolution=ignore-duplicates,return=representation'
  });
  const insertedRows = await assertJson(inserted, 'PostgREST insert with on_conflict and return=representation');
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].payload.nested.value, 7);
  assert.equal(Number(insertedRows[0].total), 1500.5);

  const duplicate = await rest('le_orders?on_conflict=order_id', {
    method: 'POST', body: { ...order, total: 9999 },
    prefer: 'resolution=ignore-duplicates,return=representation'
  });
  assert.ok(duplicate.ok);
  assert.deepEqual(await duplicate.json(), [], 'ON CONFLICT ignore returns no duplicate representation');
  assert.equal(Number((await getOrder(id)).total), 1500.5);

  const secondId = newOrderId();
  const second = await rest('le_orders', { method: 'POST', body: {
    order_id: secondId, fingerprint: 'b'.repeat(64), payment_method: 'card', status: 'awaiting_payment',
    payload: { source: 'local-it', note: 'numeric/date filters' }, total: '1750.25', payment_id: `unique-${testRunId}`,
    created_at: new Date(Date.now() - 60000).toISOString(), notification_checked_at: new Date().toISOString()
  }, prefer: 'return=representation' });
  assert.equal((await assertJson(second, 'PostgREST unique payment_id insert')).length, 1);
  const duplicatePayment = await rest('le_orders', { method: 'POST', body: {
    order_id: newOrderId(), fingerprint: 'c'.repeat(64), payment_method: 'card', status: 'received',
    payload: {}, total: '1.00', payment_id: `unique-${testRunId}`
  }, prefer: 'return=representation' });
  assert.ok(duplicatePayment.status >= 400, 'unique payment_id constraint is enforced by PostgreSQL');

  const minDate = encodeURIComponent(new Date(Date.now() - 300000).toISOString());
  const filtered = await rest(`le_orders?select=order_id,payload,total,created_at&total=gte.1500&total=lt.1600&created_at=gte.${minDate}&payload->>source=eq.local-it&order=notification_checked_at.asc.nullsfirst,created_at.asc&limit=10`);
  const filteredRows = await assertJson(filtered, 'PostgREST numeric/JSON/date filters, null sorting and limit');
  assert.equal(filteredRows[0].order_id, id, 'null notification_checked_at sorts before the later timestamp');
  assert.equal(Number(filteredRows[0].total), 1500.5);

  const effectKey = `it:${testRunId}`;
  const effect = await rest('le_order_effects?on_conflict=effect_key', {
    method: 'POST', body: { effect_key: effectKey, state: 'failed', token: randomUUID(), attempt_count: 1,
      next_attempt_at: new Date(Date.now() + 60000).toISOString() },
    prefer: 'resolution=ignore-duplicates,return=representation'
  });
  assert.equal((await assertJson(effect, 'PostgREST effect insert')).length, 1);
  const future = encodeURIComponent(new Date(Date.now()).toISOString());
  const earlyClaim = await rest(`le_order_effects?effect_key=eq.${encodeURIComponent(effectKey)}&state=eq.failed&attempt_count=eq.1&next_attempt_at=lte.${future}`, {
    method: 'PATCH', body: { state: 'running', token: randomUUID() }, prefer: 'return=representation'
  });
  assert.deepEqual(await earlyClaim.json(), [], 'conditional PATCH refuses a future retry');
  const moveDue = await rest(`le_order_effects?effect_key=eq.${encodeURIComponent(effectKey)}`, {
    method: 'PATCH', body: { next_attempt_at: new Date(Date.now() - 60000).toISOString() }, prefer: 'return=representation'
  });
  assert.equal((await assertJson(moveDue, 'PostgREST date PATCH')).length, 1);
  const due = encodeURIComponent(new Date().toISOString());
  const claim = await rest(`le_order_effects?effect_key=eq.${encodeURIComponent(effectKey)}&state=eq.failed&attempt_count=eq.1&next_attempt_at=lte.${due}`, {
    method: 'PATCH', body: { state: 'running', token: randomUUID() }, prefer: 'return=representation'
  });
  assert.equal((await assertJson(claim, 'PostgREST state/count/due-time claim')).length, 1);

  const privacy = await rest(`le_orders?order_id=eq.${encodeURIComponent(id)}&select=order_id`, { role: 'anon' });
  if (privacy.ok) assert.deepEqual(await privacy.json(), [], 'anon cannot read synthetic order rows');
  else assert.ok(privacy.status >= 400, 'anon table read is denied');
  const authenticatedRead = await rest(`le_orders?order_id=eq.${encodeURIComponent(id)}&select=order_id`, { role: 'authenticated' });
  if (authenticatedRead.ok) assert.deepEqual(await authenticatedRead.json(), [], 'authenticated cannot read synthetic order rows');
  else assert.ok(authenticatedRead.status >= 400, 'authenticated table read is denied');
  const anonWrite = await rest('le_orders', { role: 'anon', method: 'POST', body: {
    ...order, order_id: newOrderId(), fingerprint: 'd'.repeat(64)
  }, prefer: 'return=representation' });
  assert.ok(anonWrite.status >= 400, 'anon write is denied');
  const authenticatedWrite = await rest('le_orders', { role: 'authenticated', method: 'POST', body: {
    ...order, order_id: newOrderId(), fingerprint: 'e'.repeat(64)
  }, prefer: 'return=representation' });
  assert.ok(authenticatedWrite.status >= 400, 'authenticated write is denied');
  const anonRpc = await rest('rpc/le_recover_bank_order', { role: 'anon', method: 'POST', body: {
    p_order_id: id, p_payment_id: 'local-anon', p_bank_status: 2, p_bank_amount_kopecks: 150050,
    p_payment_url: '', p_description: ''
  } });
  assert.ok(anonRpc.status >= 400, 'anon RPC call is denied');
  const authenticatedRpc = await rest('rpc/le_recover_bank_order', { role: 'authenticated', method: 'POST', body: {
    p_order_id: id, p_payment_id: 'local-auth', p_bank_status: 2, p_bank_amount_kopecks: 150050,
    p_payment_url: '', p_description: ''
  } });
  assert.ok(authenticatedRpc.status >= 400, 'authenticated RPC call is denied');
  report.postgresPostgrest.push('Real PostgREST insert/upsert/filter/sort/date/numeric/JSON/PATCH and anon/authenticated denials verified.');
}

async function insertRecoveryFixture(orderId, total, state = 'unknown') {
  const orderResponse = await rest('le_orders', { method: 'POST', body: {
    order_id: orderId, fingerprint: 'f'.repeat(64), payment_method: 'card', status: 'received',
    payload: { amount: total, description: 'Synthetic recovery fixture' }, total,
    created_at: new Date(Date.now() - 1000).toISOString()
  }, prefer: 'return=representation' });
  assert.equal((await assertJson(orderResponse, 'recovery order fixture insert')).length, 1);
  const effectResponse = await rest('le_order_effects', { method: 'POST', body: {
    effect_key: `bank:${orderId}`, state, token: randomUUID(), attempt_count: 1
  }, prefer: 'return=representation' });
  assert.equal((await assertJson(effectResponse, 'recovery effect fixture insert')).length, 1);
}

async function rpcRecovery(args) {
  const response = await rest('rpc/le_recover_bank_order', { method: 'POST', body: args });
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, body };
}

function recoveryArgs(orderId, paymentId, status, amount, paymentUrl = '') {
  return { p_order_id: orderId, p_payment_id: paymentId, p_bank_status: status,
    p_bank_amount_kopecks: amount, p_payment_url: paymentUrl, p_description: 'Synthetic local recovery' };
}

async function checkRecoveryRpc() {
  const rejectedId = newOrderId();
  await insertRecoveryFixture(rejectedId, 1250);
  const wrongAmount = await rpcRecovery(recoveryArgs(rejectedId, `bad-amount-${testRunId}`, 2, 125001));
  assert.ok(wrongAmount.status >= 400, 'RPC rejects amount mismatch');
  assert.equal((await getOrder(rejectedId)).payment_id, null, 'amount failure leaves order untouched');
  assert.equal((await getEffects(rejectedId, 'bank'))[0].state, 'unknown', 'amount failure leaves effect untouched');
  const invalidStatus = await rpcRecovery(recoveryArgs(rejectedId, `bad-status-${testRunId}`, 1, 125000));
  assert.ok(invalidStatus.status >= 400, 'RPC rejects an unsupported bank status');
  const missingUrl = await rpcRecovery(recoveryArgs(rejectedId, `no-url-${testRunId}`, 0, 125000));
  assert.ok(missingUrl.status >= 400, 'RPC rejects unpaid recovery without a verified form URL');

  const conflictOrderId = newOrderId();
  await insertRecoveryFixture(conflictOrderId, 1750);
  const collisionId = `collision-${testRunId}`;
  const occupied = await rest('payment_orders', { method: 'POST', body: {
    md_order: collisionId, order_number: 'LE-OTHER-LOCAL', amount: 1750, description: 'preserve this row', status: 'paid'
  }, prefer: 'return=representation' });
  assert.equal((await assertJson(occupied, 'payment queue collision seed')).length, 1);
  const collision = await rpcRecovery(recoveryArgs(conflictOrderId, collisionId, 2, 175000));
  assert.ok(collision.status >= 400, 'RPC rejects a payment ID already linked to another order');
  assert.equal((await getOrder(conflictOrderId)).payment_id, null, 'queue collision rolled back order update');
  assert.equal((await getEffects(conflictOrderId, 'bank'))[0].state, 'unknown', 'queue collision rolled back effect update');

  const paidOrderId = newOrderId();
  await insertRecoveryFixture(paidOrderId, 1599);
  const paymentId = `local-paid-${testRunId}`;
  const paidQueue = await rest('payment_orders', { method: 'POST', body: {
    md_order: paymentId, order_number: paidOrderId, amount: 1599, description: 'existing payment', status: 'paid',
    created_at: '2026-01-01T00:00:00Z', notified_at: '2026-01-02T00:00:00Z'
  }, prefer: 'return=representation' });
  assert.equal((await assertJson(paidQueue, 'paid queue preservation seed')).length, 1);
  const recovered = await rpcRecovery(recoveryArgs(paidOrderId, paymentId, 2, 159900));
  assert.equal(recovered.status, 200, 'verified paid status recovers over real PostgREST RPC');
  assert.equal(recovered.body.paid, true);
  assert.equal(recovered.body.paymentId, paymentId);
  assert.equal(recovered.body.orderId, paidOrderId);
  const order = await getOrder(paidOrderId);
  assert.equal(order.status, 'paid');
  assert.equal(order.payment_id, paymentId);
  assert.equal((await getEffects(paidOrderId, 'bank'))[0].state, 'done');
  const queueResponse = await rest(`payment_orders?md_order=eq.${encodeURIComponent(paymentId)}&select=status,notified_at`);
  const queue = (await assertJson(queueResponse, 'payment queue state after RPC'))[0];
  assert.equal(queue.status, 'paid');
  assert.equal(queue.notified_at, '2026-01-02T00:00:00+00:00', 'RPC preserves prior notified_at');
  const replay = await rpcRecovery(recoveryArgs(paidOrderId, paymentId, 2, 159900));
  assert.ok(replay.status >= 400, 'RPC requires bank effect to be unknown and cannot replay a recovery write');
  report.postgresPostgrest.push('Recovery RPC permissions, exact amount/status, unique-ID collision, atomic rollback, paid recovery and queue preservation verified.');
}

async function startFunctionsServer(envPath, networkName, apiUrl) {
  if (runAbortController.signal.aborted) throw new Error('Local integration run was interrupted.');
  const args = functionServeArgs(envPath, projectDir, networkName);
  functionProcess = spawn(supabaseBin, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  functionProcess.once('error', error => { functionProcessError = error; });
  // Runtime logs can contain test order payloads; retain none of them.
  functionProcess.stdout?.resume();
  functionProcess.stderr?.resume();
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (runAbortController.signal.aborted) throw new Error('Local integration run was interrupted.');
    if (functionProcessError) throw new Error('The local Edge Runtime process could not be started.');
    if (functionProcess.exitCode !== null) throw new Error(`Local Edge Runtime exited with status ${functionProcess.exitCode}.`);
    try {
      const response = await fetchLocal(`${apiUrl}/rest/v1/le_orders?select=order_id&limit=1`, {
        headers: { apikey: localAnonKey, Authorization: `Bearer ${localAnonKey}` }
      }, 2000);
      if ([200, 401, 403].includes(response.status)) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error('Local Supabase API did not become ready for Edge Functions.');
}

async function checkNetworkGuard() {
  const result = await functionCall('pay', 'local-integration-network-probe');
  assert.equal(result.status, 200, 'local-only network guard probe is available in isolated test mode');
  assert.equal(result.body.blockedBeforeNetwork, true, 'unexpected external provider URL is rejected before fetch');
  report.edge.push('Unexpected external URL rejected before fetch; provider requests are confined to local Kong.');
}

async function checkConcurrentPaymentCreation() {
  await providerConfig({ alfa_register: 'success', alfa_status: 0, telegram: 'success' });
  const orderId = newOrderId();
  const payload = orderPayload(orderId, 'card');
  const [first, second] = await Promise.all([
    functionCall('pay', '', payload),
    functionCall('pay-instance-a', '', payload)
  ]);
  assert.ok([200, 409].includes(first.status), 'primary request completes or sees the running claim');
  assert.ok([200, 409].includes(second.status), 'second request completes or sees the running claim');
  const winner = [first, second].find(result => result.status === 200);
  assert.ok(winner?.body.paymentId, 'one concurrent request creates the payment');
  for (const response of [first, second].filter(result => result.status === 200)) {
    assert.equal(response.body.paymentId, winner.body.paymentId);
  }
  assert.equal((await providerCalls('alfa', 'register', orderId)).length, 1, 'only one bank registration reached local mock');
  const order = await getOrder(orderId);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.payment_id, winner.body.paymentId);
  const queue = await rest(`payment_orders?md_order=eq.${encodeURIComponent(winner.body.paymentId)}&select=md_order,status,amount`);
  const queueRows = await assertJson(queue, 'payment polling queue written through local PostgREST');
  assert.equal(queueRows[0].status, 'pending');
  assert.equal(Number(queueRows[0].amount), 1250);
  const replay = await functionCall('pay-instance-b', '', payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.paymentId, winner.body.paymentId);
  assert.equal((await providerCalls('alfa', 'register', orderId)).length, 1, 'replay does not register another payment');
  report.edge.push('Two Deno Edge Function routes raced; PostgREST effects allowed one Alfa mock registration and stable replay.');
  return { orderId, paymentId: winner.body.paymentId, payload };
}

async function checkCardCallbackAndPolling() {
  const created = await checkConcurrentPaymentCreation();
  const status = await rest(`local_provider_payments?payment_id=eq.${encodeURIComponent(created.paymentId)}`, {
    method: 'PATCH', body: { order_status: 2 }, prefer: 'return=representation'
  });
  assert.equal((await assertJson(status, 'mock bank deposited status update')).length, 1);
  const callbackBody = { mdOrder: created.paymentId, operation: 'deposited', status: '1' };
  const hookHeaders = { 'X-Hook-Secret': process.env.LE_TEST_HOOK_SECRET };
  const callback = await functionCall('pay', 'hook', callbackBody, hookHeaders);
  assert.equal(callback.status, 200);
  assert.equal(callback.body.paid, true);
  assert.equal((await providerCalls('telegram', 'sendMessage', created.orderId)).length, 2);
  const duplicateCallback = await functionCall('pay', 'hook', callbackBody, hookHeaders);
  assert.equal(duplicateCallback.status, 200);
  assert.equal((await providerCalls('telegram', 'sendMessage', created.orderId)).length, 2, 'callback replay skips sent recipients');
  const paidReplay = await functionCall('pay-instance-b', '', created.payload);
  assert.equal(paidReplay.status, 200);
  assert.equal(paidReplay.body.paid, true, 'checkout replay exposes the paid state');
  assert.equal((await providerCalls('alfa', 'register', created.orderId)).length, 1);

  await providerConfig({ alfa_status: 2 });
  const pollOrder = newOrderId();
  const pollPayload = orderPayload(pollOrder, 'card');
  const newPayment = await functionCall('pay', '', pollPayload);
  assert.equal(newPayment.status, 200);
  const polled = await functionCall('pay', 'poll-payments', {}, { 'X-Poll-Token': process.env.LE_TEST_POLL_TOKEN });
  assert.equal(polled.status, 200);
  const paid = await getOrder(pollOrder);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.telegram_sent, true);
  assert.equal((await providerCalls('telegram', 'sendMessage', pollOrder)).length, 2);
  report.edge.push('Real callback, duplicate callback, paid replay and polling use mock bank/Telegram endpoints and persisted effects.');
}

async function checkCodRetry() {
  const dueToken = process.env.LE_TEST_COD_TOKEN;
  const retryHeaders = token => ({ 'X-Cod-Retry-Token': token || '' });
  const unauthorized = await functionCall('pay', 'retry-cod-delivery', {}, retryHeaders('wrong-local-token'));
  assert.equal(unauthorized.status, 401);

  await providerConfig({ telegram: 'partial', alfa_register: 'success', alfa_status: 0 });
  const orderId = newOrderId();
  const payload = orderPayload(orderId);
  const created = await functionCall('pay', 'create-cod-order', payload);
  assert.equal(created.status, 502);
  assert.equal(created.body.accepted, true);
  assert.equal((await getOrder(orderId)).status, 'accepted');
  const effects = await getEffects(orderId, 'telegram');
  assert.equal(effects.length, 2);
  assert.equal(effects.filter(effect => effect.state === 'done').length, 1);
  const failed = effects.find(effect => effect.state === 'failed');
  assert.ok(new Date(failed.next_attempt_at).getTime() > Date.now(), 'backoff time is persisted after explicit mock rejection');
  const before = (await providerCalls('telegram', 'sendMessage', orderId)).length;
  const early = await functionCall('pay-instance-a', 'retry-cod-delivery', {}, retryHeaders(dueToken));
  assert.equal(early.status, 200);
  assert.equal((await providerCalls('telegram', 'sendMessage', orderId)).length, before, 'not-due retry does not send');

  const movedDue = await rest(`le_order_effects?effect_key=eq.${encodeURIComponent(failed.effect_key)}`, {
    method: 'PATCH', body: { next_attempt_at: new Date(Date.now() - 60000).toISOString() }, prefer: 'return=representation'
  });
  assert.equal((await assertJson(movedDue, 'advance only the synthetic mock effect due time')).length, 1);
  await providerConfig({ telegram: 'success' });
  const retries = await Promise.all([
    functionCall('pay-instance-a', 'retry-cod-delivery', {}, retryHeaders(dueToken)),
    functionCall('pay-instance-b', 'retry-cod-delivery', {}, retryHeaders(dueToken)),
    functionCall('pay', 'create-cod-order', payload)
  ]);
  assert.equal(retries[0].status, 200);
  assert.equal(retries[1].status, 200);
  assert.ok([200, 409, 502].includes(retries[2].status), 'buyer retry may observe the running recipient claim');
  assert.equal((await providerCalls('telegram', 'sendMessage', orderId)).length, before + 1, 'retry reaches only failed recipient');
  assert.equal((await getEffects(orderId, 'telegram')).filter(effect => effect.state === 'done').length, 2);
  assert.equal((await getOrder(orderId)).telegram_sent, true);

  await providerConfig({ telegram: 'partial' });
  const exhaustedId = newOrderId();
  const exhausted = await functionCall('pay', 'create-cod-order', orderPayload(exhaustedId));
  assert.equal(exhausted.status, 502);
  const exhaustedEffects = await getEffects(exhaustedId, 'telegram');
  const failedEffect = exhaustedEffects.find(effect => effect.state === 'failed');
  await rest(`le_order_effects?effect_key=eq.${encodeURIComponent(failedEffect.effect_key)}`, {
    method: 'PATCH', body: { attempt_count: 5, next_attempt_at: new Date(Date.now() - 60000).toISOString() }, prefer: 'return=representation'
  });
  const countBeforeLimit = (await providerCalls('telegram', 'sendMessage', exhaustedId)).length;
  const bounded = await functionCall('pay', 'retry-cod-delivery', {}, retryHeaders(dueToken));
  assert.equal(bounded.status, 200);
  assert.equal((await providerCalls('telegram', 'sendMessage', exhaustedId)).length, countBeforeLimit, 'automatic retry stops at five attempts');

  await providerConfig({ telegram: 'unknown' });
  const unknownId = newOrderId();
  const unknownPayload = orderPayload(unknownId);
  const unknown = await functionCall('pay', 'create-cod-order', unknownPayload);
  assert.equal(unknown.status, 502);
  const unknownCalls = (await providerCalls('telegram', 'sendMessage', unknownId)).length;
  assert.equal(unknownCalls, 2);
  await providerConfig({ telegram: 'success' });
  const unknownReplay = await functionCall('pay-instance-a', 'create-cod-order', unknownPayload);
  assert.equal(unknownReplay.status, 409);
  const backgroundUnknown = await functionCall('pay-instance-b', 'retry-cod-delivery', {}, retryHeaders(dueToken));
  assert.equal(backgroundUnknown.status, 200);
  assert.equal((await providerCalls('telegram', 'sendMessage', unknownId)).length, unknownCalls, 'unknown outcomes are never resent');

  const firstDispatchId = newOrderId();
  const firstDispatch = await rest('le_orders', { method: 'POST', body: {
    order_id: firstDispatchId, fingerprint: '9'.repeat(64), payment_method: 'cash_on_delivery', status: 'accepted',
    payload: {}, total: 1250, notification: `<b>Новый заказ № ${firstDispatchId}</b> Синтетическое тестовое сообщение`,
    notification_chat_ids: ['mock-chat-1', 'mock-chat-2'], telegram_sent: false
  }, prefer: 'return=representation' });
  assert.equal((await assertJson(firstDispatch, 'accepted-order pre-effect crash fixture')).length, 1);
  const beforeDispatch = (await providerCalls('telegram', 'sendMessage', firstDispatchId)).length;
  const recoveredDispatch = await functionCall('pay', 'retry-cod-delivery', {}, retryHeaders(dueToken));
  assert.equal(recoveredDispatch.status, 200);
  assert.equal((await providerCalls('telegram', 'sendMessage', firstDispatchId)).length, beforeDispatch + 2,
    'missing effects permit the first dispatch from the saved recipient snapshot');
  assert.equal((await getOrder(firstDispatchId)).telegram_sent, true);
  report.edge.push('COD authorization, due-time backoff, bounded attempts, unknown blocking, concurrent background/buyer partial retry, first dispatch recovery and recipient snapshots verified.');
}

async function checkConcurrentCodCreation() {
  await providerConfig({ telegram: 'success', delay_ms: 100 });
  try {
    const orderId = newOrderId();
    const payload = orderPayload(orderId);
    const results = await Promise.all([
      functionCall('pay', 'create-cod-order', payload),
      functionCall('pay-instance-a', 'create-cod-order', payload)
    ]);
    assert.ok(results.every(result => [200, 409, 502].includes(result.status)),
      'concurrent COD requests either complete or observe an in-flight effect');
    assert.equal((await providerCalls('telegram', 'sendMessage', orderId)).length, 2,
      'two concurrent COD instances send exactly once to each mock recipient');
    const effects = await getEffects(orderId, 'telegram');
    assert.equal(effects.length, 2);
    assert.ok(effects.every(effect => effect.state === 'done'));
    const replay = await functionCall('pay-instance-b', 'create-cod-order', payload);
    assert.equal(replay.status, 200);
    assert.equal((await getOrder(orderId)).telegram_sent, true);
    assert.equal((await providerCalls('telegram', 'sendMessage', orderId)).length, 2);
    report.edge.push('Concurrent COD creation across two Deno routes sends once per recipient, then replays without another send.');
  } finally {
    await providerConfig({ delay_ms: 0 });
  }
}

async function checkAmbiguousBankRecovery() {
  await providerConfig({ alfa_register: 'unknown', alfa_status: 2, telegram: 'success' });
  const orderId = newOrderId();
  const payload = orderPayload(orderId, 'card');
  const ambiguous = await functionCall('pay', '', payload);
  assert.equal(ambiguous.status, 503);
  assert.equal((await getEffects(orderId, 'bank'))[0].state, 'unknown');
  assert.equal((await providerCalls('alfa', 'register', orderId)).length, 1);
  await providerConfig({ alfa_register: 'success', alfa_status: 2 });
  const replay = await functionCall('pay-instance-a', '', payload);
  assert.equal(replay.status, 409);
  assert.equal((await providerCalls('alfa', 'register', orderId)).length, 1, 'ambiguous bank create does not retry registration');
  const providerResponse = await rest(`local_provider_payments?order_number=eq.${encodeURIComponent(orderId)}&select=payment_id,amount_kopecks,order_status`);
  const evidence = (await assertJson(providerResponse, 'synthetic mock bank evidence'))[0];
  const recovery = await rpcRecovery(recoveryArgs(orderId, evidence.payment_id, 2, Number(evidence.amount_kopecks)));
  assert.equal(recovery.status, 200);
  assert.equal(recovery.body.paid, true);
  assert.equal((await getOrder(orderId)).status, 'paid');
  const paidReplay = await functionCall('pay-instance-b', '', payload);
  assert.equal(paidReplay.status, 200);
  assert.equal(paidReplay.body.paid, true);
  assert.equal((await providerCalls('alfa', 'register', orderId)).length, 1);
  report.edge.push('Ambiguous registration was not repeated; exact synthetic status/amount/ID evidence recovered atomically through the real RPC.');
}

async function checkExtensionsAndCron() {
  const extensionCommands = [
    ['pg_cron', 'create extension if not exists pg_cron with schema extensions;', "to_regclass('cron.job')"],
    ['pg_net', 'create extension if not exists pg_net with schema extensions;', "to_regclass('net._http_response')"],
    ['vault', 'create extension if not exists supabase_vault with schema vault;', "to_regclass('vault.decrypted_secrets')"]
  ];
  await requireSuccess(supabaseBin, ['db', 'query', '--local', '--workdir', projectDir,
    'create schema if not exists extensions; create schema if not exists vault;']);
  for (const [name, installSql] of extensionCommands) {
    const before = await sqlResult(`select ${name === 'vault' ? "to_regclass('vault.decrypted_secrets')" : name === 'pg_cron' ? "to_regclass('cron.job')" : "to_regclass('net._http_response')"} as present`);
    if (before.present) { report.extensions[name] = 'available'; continue; }
    const result = await command(supabaseBin, ['db', 'query', '--local', '--workdir', projectDir, installSql]);
    if (result.code !== 0) { report.extensions[name] = 'not available in the local database image'; continue; }
    const after = await sqlResult(`select ${extensionCommands.find(row => row[0] === name)[2]} as present`);
    report.extensions[name] = after.present ? 'available' : 'extension installed but expected object is absent';
  }

  if (Object.values(report.extensions).some(value => value !== 'available')) {
    report.background.push(`Cron not exercised: local extension availability: ${JSON.stringify(report.extensions)}.`);
    return;
  }

  const existingJobs = await sqlResult('select count(*) as jobs from cron.job');
  assert.equal(Number(existingJobs.jobs), 0, 'the disposable database has no pre-existing cron jobs');
  const watermark = await sqlResult('select coalesce(max(id), 0)::text as response_watermark from net._http_response');
  const responseWatermark = String(watermark.response_watermark);
  assert.match(responseWatermark, /^\d+$/, 'pg_net response watermark is a safe integer literal');

  // Mark cleanup before the first write: a timeout may happen after the SQL
  // has committed but before the CLI reports success.
  cronCleanupNeeded = true;
  const projectUrlSecret = 'http://kong:8000';
  const token = process.env.LE_TEST_COD_TOKEN;
  const secretsSql = `select vault.create_secret(${sqlQuote(projectUrlSecret)}, 'lady_elka_project_url', 'local integration only');\n` +
    `select vault.create_secret(${sqlQuote(token)}, 'lady_elka_cod_retry_token', 'local integration only');\n`;
  await sqlFile(secretsSql, 'local-vault-test-seed.sql');
  const orderId = newOrderId();
  const dueOrder = await rest('le_orders', { method: 'POST', body: {
    order_id: orderId, fingerprint: '8'.repeat(64), payment_method: 'cash_on_delivery', status: 'accepted',
    payload: {}, total: 1250, notification: `<b>Новый заказ № ${orderId}</b> Синтетическое сообщение из локального cron`,
    notification_chat_ids: ['cron-chat-1', 'cron-chat-2'], telegram_sent: false
  }, prefer: 'return=representation' });
  assert.equal((await assertJson(dueOrder, 'pg_cron delivery fixture')).length, 1);
  await providerConfig({ telegram: 'success' });

  const sourceSql = await readFile(join(repo, 'supabase/sql/cod-delivery-cron.sql'), 'utf8');
  assert.doesNotMatch(sourceSql, /https?:\/\//i, 'cron SQL must resolve only the synthetic local Vault URL');
  assert.equal((sourceSql.match(/'\*\/5 \* \* \* \*'/g) || []).length, 1, 'opt-in cron schedule remains recognizable');
  // Keep the job body and Vault lookups byte-for-byte from the opt-in SQL;
  // only accelerate the local-only schedule to once per minute for a bounded test.
  const minuteSql = sourceSql.replace("'*/5 * * * *'", "'* * * * *'");
  await sqlFile(minuteSql, 'local-cod-cron-accelerated.sql');
  const jobResult = await sqlResult("select json_build_object('jobid', jobid, 'schedule', schedule, 'command', command) as job from cron.job where jobname = 'lady-elka-cod-delivery'");
  const job = jobResult.job || jobResult;
  assert.equal(job.schedule, '* * * * *');
  assert.match(job.command, /net\.http_post/);

  const deadline = Date.now() + 100000;
  let cronRan = false;
  while (Date.now() < deadline) {
    const runResult = await sqlResult(`select exists(select 1 from cron.job_run_details where jobid = ${Number(job.jobid)} and status = 'succeeded' and start_time > now() - interval '2 minutes') as ran`);
    if (runResult.ran) { cronRan = true; break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 1500));
  }
  assert.ok(cronRan, 'actual local pg_cron job invoked the pg_net command');

  let httpResponse = null;
  const responseDeadline = Date.now() + 30000;
  while (Date.now() < responseDeadline) {
    const latest = await sqlResult(`select json_build_object('status_code', status_code, 'content', content, 'error_msg', error_msg) as result from net._http_response where id > ${responseWatermark} order by id asc limit 1`);
    const value = latest.result || latest;
    if (value.status_code !== null && value.status_code !== undefined) { httpResponse = value; break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  assert.ok(httpResponse, 'pg_net recorded an HTTP response');
  assert.equal(Number(httpResponse.status_code), 200, 'cron HTTP endpoint accepted the local retry token');
  const content = typeof httpResponse.content === 'string' ? JSON.parse(httpResponse.content) : httpResponse.content;
  assert.equal(content.delivered, 1, 'cron delivered one locally accepted order');
  assert.equal((await getOrder(orderId)).telegram_sent, true);
  assert.equal((await providerCalls('telegram', 'sendMessage', orderId)).length, 2);
  report.background.push('Local pg_cron → pg_net → pay Edge Function → mock Telegram delivery verified; accelerated schedule retained the opt-in SQL body.');
}

async function initializeSecretsAndServe(ports) {
  const status = parseEnvOutput(await requireSuccess(supabaseBin, ['status', '--workdir', projectDir, '--output', 'env']));
  localServiceKey = status.SERVICE_ROLE_KEY || status.SECRET_KEY || '';
  localAnonKey = status.ANON_KEY || status.PUBLISHABLE_KEY || '';
  localJwtSecret = status.JWT_SECRET || '';
  if (!localServiceKey || !localAnonKey || !localJwtSecret) {
    throw new Error('The local Supabase CLI did not provide expected local-only API/JWT values.');
  }
  localApiUrl = `http://127.0.0.1:${ports.api}`;
  authenticatedJwt = makeJwt('authenticated');
  const pollToken = shortToken();
  const codToken = shortToken();
  const hookSecret = shortToken();
  const env = buildLocalFunctionEnv({ localApiUrl, localServiceKey, pollToken, codToken, hookSecret });
  process.env.LE_TEST_HOOK_SECRET = hookSecret;
  process.env.LE_TEST_POLL_TOKEN = pollToken;
  process.env.LE_TEST_COD_TOKEN = codToken;
  envPath = join(projectDir, '.local-integration.env');
  await writeFile(envPath, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  await startFunctionsServer(envPath, networkName, localApiUrl);
  await seedCatalog(ports.api);
}

async function cleanup() {
  if (projectDir && cronCleanupNeeded) {
    const cleanupSql = `select cron.unschedule('lady-elka-cod-delivery');\n` +
      `delete from vault.secrets where name in ('lady_elka_project_url', 'lady_elka_cod_retry_token');\n`;
    try { await sqlFile(cleanupSql, 'local-integration-cleanup.sql', { signal: null, timeoutMs: 15000 }); }
    catch { console.error('CLEANUP: local cron/Vault cleanup query did not complete; the isolated project will be stopped.'); }
  }
  const result = await cleanupOwnedResources({
    runId: testRunId,
    projectDir,
    projectMayBeRunning,
    networkName,
    networkCreated,
    functionProcess,
    supabaseBin,
    dockerBin,
    command,
    removeDirectory: rm
  });
  for (const warning of result.warnings) console.error(`CLEANUP: ${warning}`);
  if (result.warnings.length && projectDir) {
    console.error(`CLEANUP recovery project: ${projectDir}`);
    console.error(`CLEANUP recovery network: ${networkName}`);
  }
  if (result.functionStopped) functionProcess = null;
  if (result.networkRemoved) networkCreated = false;
  if (result.projectDirectoryRemoved) projectDir = '';
  return result;
}

let receivedSignal = null;
async function main() {
  try {
    await preflightLocalRuntime({ supabaseBin, dockerBin, env: process.env, command });
  } catch (error) {
    const detail = error?.code === 'ENOENT'
      ? `The ${error.path || 'Supabase CLI or Docker'} executable is not installed or is not on PATH.`
      : error?.message || 'No local Docker-compatible runtime is available.';
    if (receivedSignal) return;
    console.error(`BLOCKED: ${detail}`);
    console.error('The integration test stopped before staging files, selecting ports, creating a network, or starting a project.');
    console.error('After a local container runtime is available, rerun: npm run test:supabase:local');
    process.exitCode = 2;
    return;
  }

  let failure = null;
  try {
    const ports = await choosePorts();
    if (runAbortController.signal.aborted) throw new Error('Local integration run was interrupted.');
    await stageProject(ports);
    if (runAbortController.signal.aborted) throw new Error('Local integration run was interrupted.');
    networkCreated = true;
    const network = await requireSuccess(dockerBin, networkCreateArgs(testRunId));
    const inspect = await requireSuccess(dockerBin, networkInspectArgs(networkName));
    const networkInfo = JSON.parse(inspect);
    assert.equal(networkInfo.Internal, true, 'container network blocks external egress');
    assert.equal(networkInfo.Options?.['com.docker.network.bridge.host_binding_ipv4'], '127.0.0.1',
      'published services are bound to loopback');
    assert.match(network.trim(), /^[0-9a-f]+$/i, 'a unique test network was created');

    console.log('Starting disposable, loopback-only Supabase project…');
    projectMayBeRunning = true;
    await requireSuccess(supabaseBin, supabaseStartArgs(projectDir, networkName), { timeoutMs: 15 * 60 * 1000 });
    await assertPublishedPortsLoopback();
    await requireSuccess(supabaseBin, supabaseResetArgs(projectDir));
    await checkMigrationSet();
    await checkGrantsAndRpc();
    await initializeSecretsAndServe(ports);
    await checkRestRolesAndProtocol();
    await checkRecoveryRpc();
    await checkNetworkGuard();
    await checkCardCallbackAndPolling();
    await checkConcurrentCodCreation();
    await checkCodRetry();
    await checkAmbiguousBankRecovery();
    await checkExtensionsAndCron();
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    const result = await cleanup();
    if (result.warnings.length && !failure) failure = new Error('Integration assertions completed, but local cleanup was incomplete.');
  }
  if (!failure && !receivedSignal) {
    console.log('Local Supabase integration checks passed:');
    for (const item of [...report.postgresPostgrest, ...report.edge, ...report.background]) console.log(`- ${item}`);
    console.log(`Local extensions: ${JSON.stringify(report.extensions)}`);
  }
  if (failure && !receivedSignal) {
    console.error(`Local Supabase integration check failed: ${failure.message}`);
    process.exitCode = 1;
  }
  if (receivedSignal) process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', () => {
    receivedSignal = 'SIGINT';
    process.exitCode = 130;
    runAbortController.abort(new Error('SIGINT'));
  });
  process.on('SIGTERM', () => {
    receivedSignal = 'SIGTERM';
    process.exitCode = 143;
    runAbortController.abort(new Error('SIGTERM'));
  });
  await main();
}
