import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
export const leadMigrations = ['supabase/migrations/20261008090000_leads.sql', 'supabase/migrations/20261008120000_lead_retry.sql', 'supabase/migrations/20261008125000_lead_claim_backoff.sql'];
// PGlite + PostgREST-like RPC adapter. Every migration is applied twice to prove idempotency.
export async function leadDatabase({ setup = '' } = {}) {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  if (setup) await db.exec(setup);
  for (const file of leadMigrations) { const sql = await readFile(file, 'utf8'); await db.exec(sql); await db.exec(sql); }
  const request = async (url, options = {}) => {
    const u = new URL(url), p = JSON.parse(options.body || '{}');
    const name = u.pathname.split('/').at(-1);
    if (!u.pathname.includes('/rpc/')) {
      assert.equal(name,'le_leads');
      const { rows } = await db.query("select * from le_leads where delivery_status='pending' and next_attempt_at<=now() order by created_at limit 20");
      return Response.json(rows);
    }
    assert.match(name, /^le_[a-z_]+$/);
    // Named arguments, like PostgREST: ambiguity or a wrong name fails the test.
    const keys = Object.keys(p);
    const values = keys.map(k => p[k] !== null && typeof p[k] === 'object' ? JSON.stringify(p[k]) : p[k]);
    const { rows } = await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as value`, values);
    return Response.json(rows[0].value || null);
  };
  return { db, request };
}
