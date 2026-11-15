// Automatic outbox retry: switch, backoff, attempt limit, double-send protection, owner alert (private only), pg_cron/Vault wiring.
// Telegram is always synthetic here; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadHandler } from '../handler.mjs';
import { leadDatabase, leadMigrations } from './database.mjs';

const PERSONAL = '101', GROUP = '-100202', TOKEN = 'synthetic-retry-token-0123456789abcdef';
let seq = 0;
const lead = () => ({ id: crypto.randomUUID(), type: 'question', name: 'ТЕСТ', phone: `+7999${String(1000000 + ++seq).slice(-7)}`,
  comment: 'ТЕСТ ретрая', page: 'https://lady-elka.ru/', consent: true, website: '' });
const post = data => new Request('https://edge.test/lead', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://lady-elka.ru', 'x-forwarded-for': `10.0.0.${++seq}` }, body: JSON.stringify(data) });
const retryRequest = (body = {}, token = TOKEN) => new Request('https://edge.test/lead?action=retry', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-lead-retry-token': token }, body: JSON.stringify(body) });

async function harness({ env: extra = {}, setup } = {}) {
  const { db, request } = await leadDatabase({ setup });
  const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', TG_BOT_TOKEN: 'synthetic',
    TG_CHAT_IDS: `${PERSONAL},${GROUP}`, CORS_ORIGIN: 'https://lady-elka.ru', LEAD_RETRY_TOKEN: TOKEN, ...extra };
  const tg = { down: new Set(), sends: [], delay: 0 };
  const handler = createLeadHandler({ env: k => env[k], fetch: async (url, options) => {
    if (url.startsWith('https://db.test/')) return request(url, options);
    const method = /^https:\/\/api\.telegram\.org\/botsynthetic\/(sendPhoto|sendMessage)$/.exec(url)?.[1];
    assert.ok(method, url);
    const body = JSON.parse(options.body);
    if (tg.delay) await new Promise(r => setTimeout(r, tg.delay));
    if (tg.down.has('*') || tg.down.has(body.chat_id)) return new Response('{"ok":false}', { status: 502 });
    tg.sends.push({ chat: body.chat_id, text: body.text ?? body.caption, method, body });
    return Response.json({ ok: true, result: { chat: { id: Number(body.chat_id) }, message_id: tg.sends.length } });
  } });
  const row = async id => (await db.query('select * from le_leads where id=$1', [id])).rows[0];
  const due = id => db.query('update le_leads set next_attempt_at=now(), alert_next_at=null where id=$1', [id]);
  const retry = async (body, token) => { const r = await handler(retryRequest(body, token)); return { status: r.status, ...(await r.json()) }; };
  const enable = (patch = '') => db.query(`update le_lead_retry_settings set enabled=true${patch ? ', ' + patch : ''}`);
  return { db, request, env, tg, handler, row, due, retry, enable };
}
const secondsUntil = r => (new Date(r.next_attempt_at) - new Date(r.last_attempt_at)) / 1000;

test('safe by default: disabled switch => no Telegram, no claims, tick does nothing', async t => {
  const h = await harness(); t.after(() => h.db.close());
  const s = (await h.db.query('select * from le_lead_retry_settings')).rows[0];
  assert.equal(s.enabled, false);
  assert.deepEqual([s.max_attempts, s.alert_after_attempts, s.base_delay_seconds, s.max_delay_seconds, s.max_age_hours], [8, 4, 120, 21600, 72]);
  h.tg.down.add('*');
  const p = lead();
  assert.equal((await h.handler(post(p))).status, 202); // intake still saves and tries once
  h.tg.down.clear(); await h.due(p.id);
  const before = await h.row(p.id);
  const result = await h.retry();
  assert.equal(result.status, 200); assert.equal(result.disabled, true); assert.equal(result.attempted, 0);
  assert.equal(h.tg.sends.length, 0);
  assert.equal((await h.row(p.id)).attempt_count, before.attempt_count);
  assert.equal((await h.db.query('select public.le_lead_retry_tick() as v')).rows[0].v, null);
  // Missing settings row also means disabled.
  await h.db.query('delete from le_lead_retry_settings');
  assert.equal((await h.retry()).disabled, true);
  assert.equal(h.tg.sends.length, 0);
});

test('retry endpoint auth: wrong token, short configured token, missing token => 401', async t => {
  const h = await harness(); t.after(() => h.db.close());
  assert.equal((await h.retry({}, 'wrong')).status, 401);
  const weak = await harness({ env: { LEAD_RETRY_TOKEN: 'short' } }); t.after(() => weak.db.close());
  assert.equal((await weak.retry({}, 'short')).status, 401);
  const none = await harness({ env: { LEAD_RETRY_TOKEN: '' } }); t.after(() => none.db.close());
  assert.equal((await none.retry({}, '')).status, 401);
});

test('exponential backoff with jitter, error codes, attempt limit -> failed (no more sends)', async t => {
  const h = await harness(); t.after(() => h.db.close());
  await h.enable('max_attempts=4, alert_after_attempts=50');
  h.tg.down.add('*');
  const p = lead();
  assert.equal((await h.handler(post(p))).status, 202);
  let r = await h.row(p.id);
  assert.equal(r.attempt_count, 1); assert.equal(r.delivery_status, 'pending'); assert.equal(r.last_error, 'telegram_http_502');
  const delays = [secondsUntil(r)];
  for (let attempt = 2; attempt <= 4; attempt++) {
    await h.due(p.id);
    const res = await h.retry();
    assert.equal(res.attempted, 1); assert.equal(res.delivered, 0);
    r = await h.row(p.id);
    assert.equal(r.attempt_count, attempt);
    if (attempt < 4) delays.push(secondsUntil(r));
    else { assert.equal(res.failed, 1); assert.equal(r.delivery_status, 'failed'); assert.ok(r.failed_at); }
  }
  // 120s * 2^(n-1) with ±15% jitter.
  delays.forEach((d, i) => { const base = 120 * 2 ** i; assert.ok(d >= base * 0.85 - 1 && d <= base * 1.15 + 1, `delay ${i}: ${d}`); });
  assert.equal(r.lease_token, null);
  // Failed leads are not claimed again, even when due and Telegram recovers.
  h.tg.down.clear(); await h.db.query('update le_leads set next_attempt_at=now()');
  assert.equal((await h.retry()).attempted, 0);
  assert.equal((await h.retry({ manual: true })).attempted, 0);
  assert.equal(h.tg.sends.length, 0);
  // Client replay of a failed lead does not resend either.
  assert.equal((await h.handler(post(p))).status, 202); assert.equal(h.tg.sends.length, 0);
  // Cap: delay never exceeds max_delay_seconds.
  await h.db.query("update le_lead_retry_settings set max_attempts=50, max_delay_seconds=300");
  await h.db.query("update le_leads set delivery_status='pending', attempt_count=20, failed_at=null where id=$1", [p.id]);
  h.tg.down.add('*'); await h.due(p.id); await h.retry();
  r = await h.row(p.id); assert.ok(secondsUntil(r) <= 300 * 1.15 + 1);
});

test('only missing recipients are retried; delivered leads are never resent', async t => {
  const h = await harness(); t.after(() => h.db.close());
  await h.enable();
  h.tg.down.add(GROUP);
  const p = lead();
  assert.equal((await h.handler(post(p))).status, 202);
  assert.deepEqual(h.tg.sends.map(s => s.chat), [PERSONAL]);
  h.tg.down.clear(); await h.due(p.id);
  const res = await h.retry();
  assert.equal(res.delivered, 1);
  assert.deepEqual(h.tg.sends.map(s => s.chat), [PERSONAL, GROUP]);
  assert.equal((await h.row(p.id)).delivery_status, 'delivered');
  await h.due(p.id);
  assert.equal((await h.retry()).attempted, 0);
  assert.equal(h.tg.sends.length, 2);
});

test('parallel retry runs (overlapping cron ticks) and intake/retry overlap never double-send', async t => {
  const h = await harness(); t.after(() => h.db.close());
  await h.enable();
  h.tg.down.add('*');
  const leads = [lead(), lead(), lead()];
  for (const p of leads) assert.equal((await h.handler(post(p))).status, 202);
  h.tg.down.clear(); h.tg.delay = 15;
  await h.db.query('update le_leads set next_attempt_at=now()');
  const runs = await Promise.all(Array.from({ length: 6 }, () => h.retry()));
  assert.ok(runs.every(r => r.status === 200));
  assert.equal(runs.reduce((n, r) => n + r.delivered, 0), 3);
  for (const p of leads) for (const chat of [PERSONAL, GROUP]) {
    const hits = h.tg.sends.filter(s => s.chat === chat && s.text.replace(/[^\d]/g, '').includes(p.phone.slice(1)));
    assert.equal(hits.length, 1, `lead ${p.id} chat ${chat}`);
  }
  // A lease held by intake blocks the queue claim.
  h.tg.down.add('*');
  const q = lead();
  assert.equal((await h.handler(post(q))).status, 202);
  await h.db.query("update le_leads set next_attempt_at=now(), lease_token=gen_random_uuid(), lease_until=now()+interval '1 minute' where id=$1", [q.id]);
  h.tg.down.clear();
  assert.equal((await h.retry()).attempted, 0);
  // Expired lease (crashed worker) is reclaimed.
  await h.db.query("update le_leads set lease_until=now()-interval '1 second' where id=$1", [q.id]);
  assert.equal((await h.retry()).delivered, 1);
  assert.equal(h.tg.sends.filter(s => s.text.replace(/[^\d]/g, '').includes(q.phone.slice(1))).length, 2);
});

test('circuit breaker: Telegram down => one attempt per run, rest of queue keeps its attempts', async t => {
  const h = await harness(); t.after(() => h.db.close());
  await h.enable();
  h.tg.down.add('*');
  const leads = [lead(), lead(), lead()];
  for (const p of leads) await h.handler(post(p));
  await h.db.query('update le_leads set next_attempt_at=now()');
  const res = await h.retry();
  assert.equal(res.attempted, 1);
  const counts = (await h.db.query('select attempt_count from le_leads order by attempt_count')).rows.map(r => r.attempt_count);
  assert.deepEqual(counts, [1, 1, 2]);
});

test('old leads are not auto-retried (max_age_hours), manual retry may process them', async t => {
  const h = await harness(); t.after(() => h.db.close());
  await h.enable();
  h.tg.down.add('*');
  const p = lead(); await h.handler(post(p));
  await h.db.query("update le_leads set created_at=now()-interval '73 hours', next_attempt_at=now() where id=$1", [p.id]);
  h.tg.down.clear();
  assert.equal((await h.db.query('select public.le_lead_retry_tick() as v')).rows[0].v, null);
  assert.equal((await h.retry()).attempted, 0);
  assert.equal(h.tg.sends.length, 0);
  assert.equal((await h.retry({ manual: true })).delivered, 1);
});

test('owner alert after N attempts: private chat only, exactly once, retried with backoff on failure', async t => {
  const h = await harness(); t.after(() => h.db.close());
  await h.enable('alert_after_attempts=2, max_attempts=3');
  h.tg.down.add('*');
  const p = lead(); await h.handler(post(p));                 // attempt 1
  await h.due(p.id); let res = await h.retry();              // attempt 2 -> alert due, but TG down
  assert.equal(res.alerts.sent, 0);
  // Circuit breaker stopped before alerts? No: alerts are attempted once, failed and backed off.
  let r = await h.row(p.id);
  assert.equal(r.owner_alerted_at, null);
  assert.equal(res.alerts.failed, 1); assert.equal(r.alert_attempts, 1); assert.ok(new Date(r.alert_next_at) > new Date());
  h.tg.down.add(GROUP); h.tg.down.delete('*');               // personal works, group still down
  await h.due(p.id); res = await h.retry();                  // attempt 3 -> personal ok, group fails -> failed
  assert.equal(res.failed, 1); assert.equal(res.alerts.sent, 1);
  const alerts = h.tg.sends.filter(s => s.text.includes('Заявка не доставлена'));
  assert.equal(alerts.length, 1); assert.equal(alerts[0].chat, PERSONAL);
  assert.ok(alerts[0].text.replace(/[^\d]/g, '').includes(p.phone.slice(1))); assert.ok(alerts[0].text.includes('Попыток: 3'));
  assert.ok(alerts[0].text.includes('Не доставлено получателям: 1 из 2'));
  assert.ok(alerts[0].text.includes('telegram_http_502'));
  assert.ok(h.tg.sends.every(s => s.chat !== GROUP), 'nothing ever reached the group in this test');
  r = await h.row(p.id); assert.ok(r.owner_alerted_at); assert.equal(r.delivery_status, 'failed');
  await h.due(p.id); res = await h.retry();
  assert.equal(res.alerts.sent, 0);
  assert.equal(h.tg.sends.filter(s => s.text.includes('Заявка не доставлена')).length, 1);
  const status = (await h.db.query('select public.le_lead_retry_status() as v')).rows[0].v;
  assert.equal(status.failed, 1); assert.equal(status.awaiting_owner_alert, 0); assert.equal(status.enabled, true);
});

test('owner alert recipient is never a group and never ambiguous', async t => {
  for (const [extra, expected] of [
    [{ LEAD_ALERT_CHAT_ID: GROUP }, null],                           // explicit negative id rejected
    [{ TG_CHAT_IDS: `${PERSONAL},202,${GROUP}` }, null],             // two private ids: ambiguous
    [{ TG_CHAT_IDS: GROUP }, null],                                   // group only
    [{ TG_CHAT_IDS: `${GROUP},${PERSONAL}`, LEAD_ALERT_CHAT_ID: '303' }, '303'],
  ]) {
    const h = await harness({ env: extra }); t.after(() => h.db.close());
    await h.enable('alert_after_attempts=1');
    h.tg.down.add('*');
    const p = lead(); await h.handler(post(p));
    h.tg.down = new Set(extra.TG_CHAT_IDS ? extra.TG_CHAT_IDS.split(',') : [PERSONAL, GROUP]);
    await h.due(p.id);
    const res = await h.retry();
    const alerts = h.tg.sends.filter(s => s.text.includes('Заявка не доставлена'));
    if (expected === null) { assert.equal(alerts.length, 0); assert.equal(res.alerts.skipped, 'no_private_owner_chat'); }
    else { assert.deepEqual(alerts.map(a => a.chat), [expected]); }
    assert.ok(alerts.every(a => !a.chat.startsWith('-')));
  }
});

test('public replay of the same lead respects backoff: no extra Telegram calls, no burnt attempts', async t => {
  const h = await harness(); t.after(() => h.db.close());
  let calls = 0;
  const counting = createLeadHandler({ env: k => h.env[k], fetch: async (url, options) => {
    if (url.startsWith('https://db.test/')) return h.request(url, options);
    calls++; return new Response('{"ok":false,"parameters":{"retry_after":30}}', { status: 429 });
  } });
  const p = lead();
  assert.equal((await counting(post(p))).status, 202);
  assert.equal(calls, 2); // initial attempt: personal + group, both 429
  for (let n = 0; n < 8; n++) {
    const r = await counting(post(p));
    assert.equal(r.status, 202); assert.equal((await r.json()).notification, 'pending');
  }
  assert.equal(calls, 2);
  let r = await h.row(p.id);
  assert.equal(r.attempt_count, 1); assert.equal(r.delivery_status, 'pending'); assert.equal(r.last_error, 'telegram_http_429');
  // Parallel replays exactly at the due moment: one claim only.
  await h.due(p.id);
  await Promise.all(Array.from({ length: 6 }, () => counting(post(p))));
  assert.equal(calls, 4);
  r = await h.row(p.id); assert.equal(r.attempt_count, 2); assert.ok(new Date(r.next_attempt_at) > new Date());
  // The DB rule holds even if the handler shortcut is bypassed (direct RPC with a stale row).
  const direct = await (await h.request('https://db.test/rest/v1/rpc/le_claim_lead', { body: JSON.stringify({ p_id: p.id, p_token: crypto.randomUUID() }) })).json();
  assert.equal(direct, null);
  // Attempt limit also caps due replays: never more than max_attempts.
  await h.db.query('update le_lead_retry_settings set max_attempts=3');
  for (let n = 0; n < 5; n++) { await h.due(p.id); await counting(post(p)); }
  r = await h.row(p.id); assert.equal(r.attempt_count, 3); assert.equal(r.delivery_status, 'failed'); assert.equal(calls, 6);
});

const cronStub = `
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create function cron.schedule(name text, sched text, cmd text) returns bigint language sql as
 $$ insert into cron.job(jobname, schedule, command) values (name, sched, cmd)
    on conflict (jobname) do update set schedule=excluded.schedule, command=excluded.command, active=true returning jobid $$;
create function cron.alter_job(job_id bigint, active boolean) returns void language sql as
 $$ update cron.job set active=alter_job.active where jobid=job_id $$;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create schema net;
create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds int);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language sql as
 $$ insert into net.calls(url, headers, body, timeout_milliseconds) values (url, headers, body, timeout_milliseconds) returning id $$;`;

test('pg_cron job is created once and INACTIVE; re-applying never re-activates; tick posts with Vault token only when enabled and due', async t => {
  const h = await harness({ setup: cronStub }); t.after(() => h.db.close());
  let jobs = (await h.db.query('select * from cron.job')).rows;
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].jobname, jobs[0].schedule, jobs[0].command, jobs[0].active],
    ['lady-elka-lead-retry', '*/2 * * * *', 'select public.le_lead_retry_tick();', false]);
  const tick = async () => (await h.db.query('select public.le_lead_retry_tick() as v')).rows[0].v;
  h.tg.down.add('*');
  const p = lead(); await h.handler(post(p)); await h.due(p.id);
  assert.equal(await tick(), null);                               // disabled
  await h.enable();
  assert.equal(await tick(), null);                               // Vault secret missing
  await h.db.query("insert into vault.decrypted_secrets values ('lady_elka_lead_retry_token', 'short')");
  assert.equal(await tick(), null);                               // too short
  await h.db.query("update vault.decrypted_secrets set decrypted_secret=$1", [TOKEN]);
  assert.ok(await tick());
  const call = (await h.db.query('select * from net.calls')).rows.at(-1);
  assert.equal(call.url, 'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/lead?action=retry');
  assert.equal(call.headers['x-lead-retry-token'], TOKEN);
  await h.db.query("update le_leads set next_attempt_at=now()+interval '1 hour'");
  const before = (await h.db.query('select count(*)::int as n from net.calls')).rows[0].n;
  assert.equal(await tick(), null);                               // nothing due -> no HTTP
  assert.equal((await h.db.query('select count(*)::int as n from net.calls')).rows[0].n, before);
  // Owner disabled the job by hand; a re-applied migration must not flip it back on.
  const { readFile } = await import('node:fs/promises');
  for (const file of leadMigrations) await h.db.exec(await readFile(file, 'utf8'));
  jobs = (await h.db.query('select * from cron.job')).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].active, false);
  assert.equal((await h.db.query('select enabled from le_lead_retry_settings')).rows[0].enabled, true); // settings preserved
});

test('RLS/grants: anon/authenticated cannot read settings or call queue functions; tick is not callable by service_role', async t => {
  const h = await harness(); t.after(() => h.db.close());
  for (const role of ['anon', 'authenticated']) {
    for (const sql of ['select * from le_lead_retry_settings', 'select public.le_claim_next_lead(gen_random_uuid(), true)',
      'select public.le_claim_lead_alert(gen_random_uuid(), true)', 'select public.le_lead_retry_status()', 'select public.le_lead_retry_tick()']) {
      await assert.rejects(h.db.exec(`set role ${role}; ${sql};`), undefined, `${role}: ${sql}`);
      await h.db.exec('reset role');
    }
  }
  await assert.rejects(h.db.exec('set role service_role; select public.le_lead_retry_tick();')); await h.db.exec('reset role');
  await h.db.exec('set role service_role; select public.le_lead_retry_status();'); await h.db.exec('reset role');
});
