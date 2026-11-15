import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { leadEnv } from './lead-env.mjs';
import { preparePayV2, migrationPath } from './prepare-pay-v2.mjs';

const project = 'mgnotvaahftrbifqtahf';
const env = await leadEnv();
if (process.argv[2] !== '--deploy') throw new Error('Use --deploy for the authorized isolated deployment');
if (!env.SUPABASE_ACCESS_TOKEN) throw new Error('Management access unavailable');
async function api(path, options = {}) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
    ...options, headers: { Authorization: 'Bearer ' + env.SUPABASE_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error('Management operation failed: ' + response.status);
  return response.json();
}
const query = query => api('database/query', { method: 'POST', body: JSON.stringify({ query }) });
async function baseline() {
  const functions = await api('functions');
  const rows = await query(`BEGIN READ ONLY;
    SELECT jsonb_agg(jsonb_build_object('jobid',jobid,'jobname',jobname,'schedule',schedule,'active',active,'commandHash',md5(command)) ORDER BY jobid) AS cron
      FROM cron.job;
    COMMIT;`);
  const pay = functions.find(f => f.slug === 'pay' || f.name === 'pay');
  if (!pay || pay.status !== 'ACTIVE') throw new Error('Legacy pay is not active');
  return { pay: { version: pay.version, hash: pay.ezbr_sha256, updatedAt: pay.updated_at }, cron: rows };
}
await preparePayV2();
const before = await baseline();
await mkdir('audit/pay-v2', { recursive: true });
await writeFile('audit/pay-v2/before.json', JSON.stringify(before, null, 2) + '\n');
const existing = await query(`BEGIN READ ONLY; SELECT to_regclass('public.le_v2_orders') IS NOT NULL AS present; COMMIT;`);
if (existing[0]?.present) throw new Error('V2 namespace already exists; inspect the previous deployment before resuming');
await query(await readFile(migrationPath, 'utf8'));
console.log('Applied only isolated pay-v2 migration; legacy schema and cron untouched');
const child = spawn('supabase', ['functions', 'deploy', 'pay-v2', '--project-ref', project, '--no-verify-jwt', '--use-api'],
  { env: { ...process.env, SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.resume(); child.stderr.resume();
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
if (code !== 0) throw new Error('pay-v2 deployment failed; isolated tables remain, legacy pay unchanged');
const after = await baseline();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Legacy pay or cron changed during deployment; investigate');
const readiness = await fetch(`https://${project}.supabase.co/functions/v1/pay-v2?action=readiness`, { signal: AbortSignal.timeout(30000) });
const state = await readiness.json();
if (readiness.status !== 200 || state.admission !== 'closed') throw new Error('Prepared admission check failed');
const schema = await query(`BEGIN READ ONLY;
 SELECT c.relname, c.relrowsecurity AS rls,
   has_table_privilege('anon',c.oid,'SELECT') AS anon_read,
   has_table_privilege('authenticated',c.oid,'INSERT') AS authenticated_write
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('le_v2_orders','le_v2_order_effects','le_v2_payment_orders','le_v2_rate_limits') ORDER BY c.relname;
 COMMIT;`);
if (schema.length !== 4 || schema.some(r => !r.rls || r.anon_read || r.authenticated_write)) throw new Error('V2 schema access check failed');
const report = { time: new Date().toISOString(), before, after, state, schema,
  migrationPath, migrationSha256: createHash('sha256').update(await readFile(migrationPath)).digest('hex'),
  endpoint: `https://${project}.supabase.co/functions/v1/pay-v2`, legacyUnchanged: true };
await writeFile('audit/pay-v2/deployment.json', JSON.stringify(report, null, 2) + '\n');
console.log('pay-v2 deployed, admission CLOSED; old pay and all cron definitions unchanged');
