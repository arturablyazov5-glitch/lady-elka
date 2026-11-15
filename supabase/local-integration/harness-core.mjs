import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const STAGED_MIGRATIONS = Object.freeze([
  Object.freeze(['20261001110000_payment_orders_baseline.sql', 'supabase/local-integration/payment-orders-baseline.sql']),
  Object.freeze(['20261001120000_order_idempotency.sql', 'supabase/migrations/20261001120000_order_idempotency.sql']),
  Object.freeze(['20261001130000_cod_delivery_retry.sql', 'supabase/migrations/20261001130000_cod_delivery_retry.sql']),
  Object.freeze(['20261008160000_order_rate_limits.sql', 'supabase/migrations/20261008160000_order_rate_limits.sql'])
]);
export const STAGED_SHARED_MODULES = Object.freeze(['order-store.mjs', 'product-rules.mjs']);

export function providerCallQuery(provider, operation, orderId) {
  const query = new URLSearchParams({ select: 'id,provider,operation,details,created_at',
    provider: `eq.${provider}`, operation: `eq.${operation}`, order: 'id.asc' });
  if (orderId) query.set(provider === 'alfa' && operation === 'register' ? 'details->>orderNumber' : 'details->>orderId', `eq.${orderId}`);
  return query;
}

export function effectFilter(orderId, prefix) {
  if (prefix === 'bank') return `effect_key=eq.${encodeURIComponent(`bank:${orderId}`)}`;
  return `effect_key=like.${encodeURIComponent(`${prefix}:*:${orderId}:*`)}`;
}

export function validatePublishedBindings(bindings) {
  let count = 0;
  for (const rows of Object.values(bindings || {})) {
    if (rows === null) continue;
    if (!Array.isArray(rows) || !rows.length) throw new Error('Unreadable published-port bindings.');
    for (const row of rows) {
      if (row.HostIp !== '127.0.0.1') throw new Error('A published container port is not bound to IPv4 loopback.');
      count += 1;
    }
  }
  return count;
}

export function parseDockerHost(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try { return JSON.parse(text); }
  catch { return text.replace(/^"|"$/g, ''); }
}

async function requireCommandSuccess(command, name, args, options = {}) {
  const result = await command(name, args, options);
  if (result.aborted) throw new Error(`${name} was interrupted`);
  if (result.timedOut) throw new Error(`${name} timed out`);
  if (result.code !== 0) throw new Error(`${name} exited with status ${result.code}`);
  return result.stdout;
}

export async function checkDockerLocalOnly({ dockerBin, env = process.env, command }) {
  // Docker gives DOCKER_CONTEXT precedence over DOCKER_HOST. Resolve the
  // selected context first so a local DOCKER_HOST cannot mask a remote one.
  const contextOverride = String(env.DOCKER_CONTEXT || '').trim();
  const contextName = contextOverride || (await requireCommandSuccess(command, dockerBin, ['context', 'show'], { env })).trim();
  if (!contextName) throw new Error('The selected container context could not be identified.');
  const endpointText = await requireCommandSuccess(command, dockerBin, [
    'context', 'inspect', contextName, '--format', '{{json .Endpoints.docker.Host}}'
  ], { env });
  const endpoint = parseDockerHost(endpointText);
  const activeEndpoint = contextOverride ? String(endpoint || '') : String(env.DOCKER_HOST || endpoint || '');
  if (!/^(unix|npipe):\/\//.test(activeEndpoint)) {
    throw new Error('The selected container context is not a local socket; no container commands were run.');
  }
  await requireCommandSuccess(command, dockerBin, ['info', '--format', '{{.ServerVersion}}'], { env });
}

export async function preflightLocalRuntime({ supabaseBin, dockerBin, env = process.env, command }) {
  await requireCommandSuccess(command, supabaseBin, ['--version'], { env });
  await checkDockerLocalOnly({ dockerBin, env, command });
}

export function createCommandRunner({
  spawnProcess,
  defaultSignal,
  defaultTimeoutMs = 120_000,
  terminateGraceMs = 3_000
}) {
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function');
  const activeChildren = new Set();

  function command(name, args, options = {}) {
    const cwd = options.cwd || process.cwd();
    const env = options.env || process.env;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const signal = Object.hasOwn(options, 'signal') ? options.signal : defaultSignal;
    if (signal?.aborted) return Promise.resolve({ code: 1, stdout: '', stderr: '', aborted: true, timedOut: false });
    return new Promise((resolveCommand, rejectCommand) => {
      let child;
      try {
        child = spawnProcess(name, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        rejectCommand(error);
        return;
      }
      activeChildren.add(child);
      const stdout = [], stderr = [];
      child.stdout?.on('data', chunk => stdout.push(chunk));
      child.stderr?.on('data', chunk => stderr.push(chunk));
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let stopping = false;
      let stopTimer;
      let forceTimer;
      let timeoutTimer;
      const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
      const finish = code => {
        if (settled) return;
        settled = true;
        clearTimeout(stopTimer);
        clearTimeout(forceTimer);
        clearTimeout(timeoutTimer);
        removeAbortListener();
        activeChildren.delete(child);
        resolveCommand({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          aborted
        });
      };
      const stop = () => {
        if (settled || stopping) return;
        stopping = true;
        try { child.kill('SIGTERM'); } catch {}
        stopTimer = setTimeout(() => {
          if (!settled) { try { child.kill('SIGKILL'); } catch {} }
        }, terminateGraceMs);
        forceTimer = setTimeout(() => finish(1), terminateGraceMs * 2);
      };
      const onAbort = () => { aborted = true; stop(); };
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(stopTimer);
        clearTimeout(forceTimer);
        clearTimeout(timeoutTimer);
        removeAbortListener();
        activeChildren.delete(child);
        rejectCommand(error);
      });
      child.once('close', finish);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      }
    });
  }
  command.activeChildren = activeChildren;
  return command;
}

export function networkCreateArgs(runId) {
  return [
    'network', 'create', '--driver', 'bridge', '--internal',
    '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
    '--label', `codex.local.integration=${runId}`, `le-it-${runId}`
  ];
}

export function networkInspectArgs(networkName) {
  return ['network', 'inspect', networkName, '--format', '{{json .}}'];
}

export function networkRemoveArgs(networkName) {
  return ['network', 'rm', networkName];
}

export function supabaseStartArgs(projectDir, networkName) {
  return [
    'start', '--yes', '--network-id', networkName,
    '--exclude', 'studio,logflare,vector,supavisor,mailpit', '--workdir', projectDir
  ];
}

export function supabaseResetArgs(projectDir) {
  return ['db', 'reset', '--local', '--no-seed', '--workdir', projectDir];
}

export function supabaseStopArgs(projectDir) {
  return ['stop', '--no-backup', '--workdir', projectDir];
}

export function functionServeArgs(envPath, projectDir, networkName) {
  return ['functions', 'serve', '--no-verify-jwt', '--env-file', envPath,
    '--workdir', projectDir, '--network-id', networkName];
}

export function buildLocalFunctionEnv({ localApiUrl, localServiceKey, pollToken, codToken, hookSecret }) {
  return {
    SUPABASE_URL: 'http://kong:8000',
    SUPABASE_SERVICE_ROLE_KEY: localServiceKey,
    LOCAL_INTEGRATION_NETWORK_GUARD: '1',
    LOCAL_INTEGRATION_PUBLIC_API_URL: localApiUrl,
    LE_CATALOG_FEEDS_BASE: 'http://kong:8000/storage/v1/object/public/le-catalog-feeds',
    ALFA_API_BASE: 'http://kong:8000/functions/v1/local-mock-provider/alfa',
    ALFA_API_USER: 'local-fixture-user',
    ALFA_API_PASS: 'local-fixture-pass',
    ALFA_CALLBACK_TOKEN: pollToken,
    ALFA_DASHBOARD_URL: `${localApiUrl}/functions/v1/local-mock-provider/dashboard`,
    TELEGRAM_API_BASE: 'http://kong:8000/functions/v1/local-mock-provider/telegram',
    TG_BOT_TOKEN: 'local-mock-token',
    TG_CHAT_IDS: 'mock-chat-1,mock-chat-2',
    COD_DELIVERY_RETRY_TOKEN: codToken,
    HOOK_SECRET: hookSecret,
    // Exercise the real limiter RPC; the scenario run itself must not hit the production-sized budgets.
    ORDER_RATE_LIMIT_IP: '1000/600',
    ORDER_RATE_LIMIT_CONTACT: '1000/600',
    REPLAY_RATE_LIMIT_IP: '1000/600',
    EXTERNAL_RATE_LIMIT_GLOBAL: '10000/3600',
    CORS_ORIGIN: localApiUrl,
    LOG_LEVEL: 'error'
  };
}

function hasExited(child) {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function waitForChild(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise(resolveWait => {
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolveWait(result);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('close', onClose);
  });
}

function ownsProjectDirectory(projectDir, runId, tempDirectory = tmpdir()) {
  if (!projectDir || !runId) return false;
  const absolute = resolve(projectDir);
  return dirname(absolute) === resolve(tempDirectory)
    && basename(absolute).startsWith(`lady-elka-supabase-${runId}-`);
}

export async function cleanupOwnedResources({
  runId,
  projectDir,
  projectMayBeRunning,
  networkName,
  networkCreated,
  functionProcess,
  supabaseBin,
  dockerBin,
  command,
  removeDirectory = rm,
  tempDirectory = tmpdir(),
  stopTimeoutMs = 30_000,
  cleanupTimeoutMs = 15_000,
  childGraceMs = 3_000
}) {
  const warnings = [];
  let functionStopped = true;
  if (functionProcess && !hasExited(functionProcess)) {
    try { functionProcess.kill('SIGTERM'); } catch {}
    functionStopped = await waitForChild(functionProcess, childGraceMs);
    if (!functionStopped) {
      try { functionProcess.kill('SIGKILL'); } catch {}
      functionStopped = await waitForChild(functionProcess, childGraceMs);
    }
    if (!functionStopped) warnings.push('The local function process did not exit after termination signals.');
  }

  const projectIsOwned = ownsProjectDirectory(projectDir, runId, tempDirectory);
  if (projectDir && !projectIsOwned) warnings.push('The temporary project path did not match this run; it was left untouched.');
  let projectStopped = !projectMayBeRunning;
  if (projectIsOwned && projectMayBeRunning) {
    try {
      const result = await command(supabaseBin, supabaseStopArgs(projectDir), {
        timeoutMs: stopTimeoutMs, signal: null
      });
      projectStopped = result.code === 0 && !result.timedOut && !result.aborted;
    } catch {
      projectStopped = false;
    }
    if (!projectStopped) warnings.push('The isolated Supabase project could not be confirmed stopped; its directory and network were retained.');
  }

  const resourcesStopped = projectStopped && functionStopped;
  let networkRemoved = !networkCreated;
  if (networkCreated) {
    if (networkName !== `le-it-${runId}`) {
      warnings.push('The network name did not match this run; it was left untouched.');
    } else if (!resourcesStopped) {
      warnings.push('The isolated network was retained because a project or function process may still be running.');
    } else {
      try {
        const inspect = await command(dockerBin, networkInspectArgs(networkName), {
          timeoutMs: cleanupTimeoutMs, signal: null
        });
        if (inspect.code !== 0 || inspect.timedOut || inspect.aborted
            || JSON.parse(inspect.stdout).Labels?.['codex.local.integration'] !== runId) {
          throw new Error('Cannot verify ownership of the network.');
        }
        const result = await command(dockerBin, networkRemoveArgs(networkName), {
          timeoutMs: cleanupTimeoutMs, signal: null
        });
        networkRemoved = result.code === 0 && !result.timedOut && !result.aborted;
      } catch {
        networkRemoved = false;
      }
      if (!networkRemoved) warnings.push('The run-owned isolated network could not be removed.');
    }
  }

  let projectDirectoryRemoved = !projectDir;
  if (projectIsOwned && resourcesStopped && (!networkCreated || networkRemoved)) {
    try {
      await removeDirectory(projectDir, { recursive: true, force: true });
      projectDirectoryRemoved = true;
    } catch {
      warnings.push('The run-owned temporary project directory could not be removed.');
    }
  } else if (projectIsOwned && projectDir) {
    warnings.push('The run-owned temporary project directory was retained for safe cleanup recovery.');
  }
  return { projectStopped, functionStopped, networkRemoved, projectDirectoryRemoved, warnings };
}
