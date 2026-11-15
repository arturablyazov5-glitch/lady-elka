import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import {
  STAGED_MIGRATIONS, STAGED_SHARED_MODULES, buildLocalFunctionEnv,
  cleanupOwnedResources, createCommandRunner, functionServeArgs,
  networkCreateArgs, preflightLocalRuntime, supabaseResetArgs,
  supabaseStartArgs, validatePublishedBindings, providerCallQuery, effectFilter
} from '../supabase/local-integration/harness-core.mjs';
import { csvRecords, treeProducts } from '../supabase/functions/_shared/product-rules.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ok = stdout => ({ code: 0, stdout, stderr: '' });

function mockRuntime({ endpoint = 'unix:///synthetic/docker.sock', missing = '', context = 'local' } = {}) {
  const calls = [];
  const command = async (name, args) => {
    calls.push({ name, args });
    if (name === missing) throw Object.assign(new Error('Synthetic missing executable'), { code: 'ENOENT' });
    if (name === 'supabase' && args[0] === '--version') return ok('synthetic-version');
    if (name === 'docker' && args.join(' ') === 'context show') return ok(context);
    if (name === 'docker' && args[0] === 'context' && args[1] === 'inspect') return ok(JSON.stringify(endpoint));
    if (name === 'docker' && args[0] === 'info') return ok('synthetic-runtime');
    throw new Error('Unexpected command in offline runner');
  };
  return { calls, command };
}

for (const missing of ['supabase', 'docker']) {
  test(`missing ${missing} stops preflight before any mutation`, async () => {
    const runner = mockRuntime({ missing });
    await assert.rejects(preflightLocalRuntime({ ...runner, supabaseBin: 'supabase', dockerBin: 'docker', env: {} }), { code: 'ENOENT' });
    assert.ok(runner.calls.every(call => call.args[0] === '--version' || call.args.join(' ') === 'context show'));
    assert.equal(runner.calls.length, missing === 'supabase' ? 1 : 2);
  });
}

for (const endpoint of ['ssh://synthetic-remote', 'tcp://192.0.2.1:2376', 'http://127.0.0.1:2375']) {
  test(`context endpoint ${endpoint.split(':')[0]} is rejected before daemon contact`, async () => {
    const runner = mockRuntime({ endpoint });
    await assert.rejects(preflightLocalRuntime({ ...runner, supabaseBin: 'supabase', dockerBin: 'docker', env: {} }), /not a local socket/);
    assert.equal(runner.calls.some(call => call.args[0] === 'info'), false);
  });
}

test('DOCKER_CONTEXT cannot be masked by a local DOCKER_HOST', async () => {
  const runner = mockRuntime({ endpoint: 'ssh://synthetic-remote' });
  await assert.rejects(preflightLocalRuntime({ ...runner, supabaseBin: 'supabase', dockerBin: 'docker',
    env: { DOCKER_CONTEXT: 'remote-selected', DOCKER_HOST: 'unix:///synthetic/docker.sock' } }), /not a local socket/);
  assert.equal(runner.calls.find(call => call.args[1] === 'inspect').args[2], 'remote-selected');
  assert.equal(runner.calls.some(call => call.args[0] === 'info'), false);
});

test('local socket preflight performs only read operations', async () => {
  const runner = mockRuntime();
  await preflightLocalRuntime({ ...runner, supabaseBin: 'supabase', dockerBin: 'docker', env: {} });
  assert.deepEqual(runner.calls.map(call => call.args[0]), ['--version', 'context', 'context', 'info']);
});

test('dry command plan isolates the project, network and database reset', () => {
  const project = '/synthetic/lady-elka-supabase-contract-owned';
  const network = 'le-it-contract';
  const create = networkCreateArgs('contract');
  assert.ok(create.includes('--internal'));
  assert.ok(create.includes('com.docker.network.bridge.host_binding_ipv4=127.0.0.1'));
  assert.ok(create.includes('codex.local.integration=contract'));
  const plans = [supabaseStartArgs(project, network), supabaseResetArgs(project), functionServeArgs(`${project}/.env`, project, network)];
  for (const args of plans) {
    assert.equal(args[args.indexOf('--workdir') + 1], project);
    assert.ok(!args.some(arg => ['--linked', 'link', 'push', 'deploy', '--all'].includes(arg)));
  }
  assert.ok(plans[1].includes('--local'));
  assert.ok(plans[1].includes('--no-seed'));
  assert.equal(plans[0][plans[0].indexOf('--network-id') + 1], network);
  assert.equal(plans[2][plans[2].indexOf('--network-id') + 1], network);
});

test('staged migrations exclude historical cron and all remote SQL', async () => {
  assert.deepEqual(STAGED_MIGRATIONS.map(([name]) => name), [
    '20261001110000_payment_orders_baseline.sql', '20261001120000_order_idempotency.sql', '20261001130000_cod_delivery_retry.sql',
    '20261008160000_order_rate_limits.sql'
  ]);
  for (const [, source] of STAGED_MIGRATIONS) {
    const sql = await readFile(join(repo, source), 'utf8');
    assert.doesNotMatch(sql, /https?:\/\/|cron\.schedule|net\.http|vault\.create_secret/i);
  }
});

test('every current pay shared-module import is staged', async () => {
  const source = await readFile(join(repo, 'supabase/functions/pay/index.ts'), 'utf8');
  const imports = [...source.matchAll(/from ['"]\.\.\/_shared\/([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(imports.includes('product-rules.mjs'));
  for (const name of imports) assert.ok(STAGED_SHARED_MODULES.includes(name), `Missing staged dependency: ${name}`);
});

test('mock call filters use the fields actually recorded by each provider', () => {
  const bank = providerCallQuery('alfa', 'register', 'LE-synthetic');
  assert.equal(bank.get('details->>orderNumber'), 'eq.LE-synthetic');
  assert.equal(bank.has('details->>orderId'), false);
  assert.equal(providerCallQuery('telegram', 'sendMessage', 'LE-synthetic').get('details->>orderId'), 'eq.LE-synthetic');
  assert.equal(decodeURIComponent(effectFilter('LE-synthetic', 'telegram')), 'effect_key=like.telegram:*:LE-synthetic:*');
  assert.equal(decodeURIComponent(effectFilter('LE-synthetic', 'bank')), 'effect_key=eq.bank:LE-synthetic');
});

test('synthetic Storage feed resolves through current shared product rules', async () => {
  const source = await readFile(join(repo, 'scripts/supabase-local-integration.mjs'), 'utf8');
  const escapedCsv = source.match(/'trees.csv': '([^']+)'/)?.[1];
  assert.ok(escapedCsv);
  const products = treeProducts(csvRecords(escapedCsv.replaceAll('\\n', '\n')));
  const variant = products.get('local-tree-1')?.variants.find(value => value.id === 'local-tree-1:Зелёная:180');
  assert.equal(variant?.price, 1250);
});

test('published ports reject wildcard and non-loopback host bindings', () => {
  assert.equal(validatePublishedBindings({ '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '55421' }], '9000/tcp': null }), 1);
  for (const HostIp of ['0.0.0.0', '::', '192.0.2.1', '']) {
    assert.throws(() => validatePublishedBindings({ '8000/tcp': [{ HostIp }] }), /not bound/);
  }
});

test('function config keeps actual provider, Storage and database URLs on Kong', () => {
  const env = buildLocalFunctionEnv({ localApiUrl: 'http://127.0.0.1:55421', localServiceKey: 'synthetic-key', pollToken: 'synthetic-poll', codToken: 'synthetic-cod' });
  for (const name of ['SUPABASE_URL', 'ALFA_API_BASE', 'TELEGRAM_API_BASE', 'LE_CATALOG_FEEDS_BASE']) {
    assert.equal(new URL(env[name]).origin, 'http://kong:8000');
  }
  assert.equal(env.LOCAL_INTEGRATION_NETWORK_GUARD, '1');
  assert.equal(env.TG_BOT_TOKEN, 'local-mock-token');
});

test('actual pay guard rejects external URLs before the injected fetch adapter', async () => {
  const source = await readFile(join(repo, 'supabase/functions/pay/index.ts'), 'utf8');
  const start = source.indexOf('const LOCAL_INTEGRATION_BLOCKED');
  const end = source.indexOf('async function fetchAlfa', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transform(source.slice(start, end), { loader: 'ts' });
  let calls = 0;
  const fetch = runInNewContext(`${code}\ncheckedFetch`, {
    Deno: { env: { get: () => '1' } }, URL, Request,
    fetch: () => { calls += 1; return Promise.resolve(new Response('{}')); }
  });
  for (const url of ['https://unexpected.invalid', 'http://127.0.0.1:55421', 'http://kong:8001', 'invalid']) {
    assert.throws(() => fetch(url, {}), /LOCAL_INTEGRATION_NETWORK_BLOCKED/);
  }
  assert.equal(calls, 0);
  await fetch('http://kong:8000/rest/v1/le_orders', {});
  assert.equal(calls, 1);
});

test('actual Deno mock rejects remote config and wrong bank auth before fetch', async () => {
  const source = await readFile(join(repo, 'supabase/local-integration/mock-provider/index.ts'), 'utf8');
  const { code } = await transform(source, { loader: 'ts' });
  for (const patch of [
    { LOCAL_INTEGRATION_PUBLIC_API_URL: 'http://127.0.0.1:55421@unexpected.invalid' },
    { SUPABASE_URL: 'https://unexpected.invalid' },
    { ALFA_API_PASS: 'different-synthetic-pass' }
  ]) {
    const env = { SUPABASE_URL: 'http://kong:8000', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key',
      TG_BOT_TOKEN: 'synthetic-bot', LOCAL_INTEGRATION_PUBLIC_API_URL: 'http://127.0.0.1:55421',
      LOCAL_INTEGRATION_NETWORK_GUARD: '1', ALFA_API_USER: 'synthetic-user', ALFA_API_PASS: 'synthetic-pass', ...patch };
    let handler; let calls = 0;
    runInNewContext(code, { Deno: { env: { get: key => env[key] }, serve: value => { handler = value; } },
      URL, URLSearchParams, Response, crypto, setTimeout,
      fetch: () => { calls += 1; throw new Error('Offline test must not reach fetch'); }
    });
    const response = await handler(new Request('http://kong:8000/functions/v1/local-mock-provider/alfa/register.do', {
      method: 'POST', body: new URLSearchParams({ userName: 'synthetic-user', password: 'synthetic-pass' })
    }));
    assert.ok(response.status >= 400);
    assert.equal(calls, 0);
  }
});

function fakeChild({ ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    if (!(ignoreTerm && signal === 'SIGTERM')) {
      queueMicrotask(() => { child.signalCode = signal; child.emit('close', null); });
    }
    return true;
  };
  return child;
}

test('command timeout terminates an unresponsive child and escalates', async () => {
  const child = fakeChild({ ignoreTerm: true });
  const command = createCommandRunner({ spawnProcess: () => child, defaultTimeoutMs: 5, terminateGraceMs: 5 });
  const result = await command('synthetic-cli', []);
  assert.equal(result.timedOut, true);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(command.activeChildren.size, 0);
});

test('signal abort terminates in-flight command and prevents subsequent spawns', async () => {
  const controller = new AbortController(); const child = fakeChild(); let spawns = 0;
  const command = createCommandRunner({ spawnProcess: () => { spawns += 1; return child; }, defaultSignal: controller.signal, terminateGraceMs: 5 });
  const pending = command('synthetic-cli', []);
  controller.abort(new Error('Synthetic SIGTERM'));
  assert.equal((await pending).aborted, true);
  assert.equal((await command('synthetic-cli', [])).aborted, true);
  assert.equal(spawns, 1);
});

function cleanupFixture({ stopCode = 0, label = 'contract', projectMayBeRunning = true } = {}) {
  const calls = [], removals = [];
  return {
    runId: 'contract', projectDir: '/synthetic/lady-elka-supabase-contract-owned', tempDirectory: '/synthetic',
    projectMayBeRunning, networkName: 'le-it-contract', networkCreated: true,
    supabaseBin: 'supabase', dockerBin: 'docker', childGraceMs: 5,
    calls, removals,
    command: async (name, args, options) => {
      calls.push({ name, args, options });
      if (args[0] === 'stop') return { ...ok(''), code: stopCode };
      if (args[1] === 'inspect') return ok(JSON.stringify({ Labels: { 'codex.local.integration': label } }));
      if (args[1] === 'rm') return ok('');
      throw new Error('Unexpected cleanup command');
    },
    removeDirectory: async (path, options) => removals.push({ path, options })
  };
}

test('cleanup stops only own project, verifies network label and removes own directory', async () => {
  const fixture = cleanupFixture(); fixture.functionProcess = fakeChild({ ignoreTerm: true });
  const result = await cleanupOwnedResources(fixture);
  assert.deepEqual(fixture.functionProcess.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(fixture.calls.map(call => call.args.slice(0, 2)), [['stop', '--no-backup'], ['network', 'inspect'], ['network', 'rm']]);
  assert.ok(fixture.calls.every(call => call.options.signal === null));
  assert.equal(fixture.calls[0].args.at(-1), fixture.projectDir);
  assert.deepEqual(fixture.removals, [{ path: fixture.projectDir, options: { recursive: true, force: true } }]);
  assert.deepEqual(result.warnings, []);
});

test('failed stop retains recovery files and never removes the network', async () => {
  const fixture = cleanupFixture({ stopCode: 1 });
  const result = await cleanupOwnedResources(fixture);
  assert.equal(result.projectStopped, false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.removals.length, 0);
});

test('a timed-out stop cannot count as completed cleanup even with exit code zero', async () => {
  const fixture = cleanupFixture();
  fixture.command = async () => ({ ...ok(''), timedOut: true });
  const result = await cleanupOwnedResources(fixture);
  assert.equal(result.projectStopped, false);
  assert.equal(result.networkRemoved, false);
  assert.equal(fixture.removals.length, 0);
});

test('wrong network ownership or project path refuses destructive cleanup', async () => {
  const fixture = cleanupFixture({ label: 'another-run' });
  const result = await cleanupOwnedResources(fixture);
  assert.equal(result.networkRemoved, false);
  assert.equal(fixture.calls.some(call => call.args[1] === 'rm'), false);
  assert.equal(fixture.removals.length, 0);
  const foreign = cleanupFixture(); foreign.projectDir = '/synthetic/user-project';
  await cleanupOwnedResources(foreign);
  assert.equal(foreign.calls.some(call => call.args[0] === 'stop'), false);
  assert.equal(foreign.removals.length, 0);
});

test('failure before project start cleans staging without invoking Supabase stop', async () => {
  const fixture = cleanupFixture({ projectMayBeRunning: false });
  await cleanupOwnedResources(fixture);
  assert.equal(fixture.calls.some(call => call.name === 'supabase'), false);
  assert.equal(fixture.removals.length, 1);
});
