import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

// Safe local PostgreSQL, not a mock of uniqueness/conditional updates.
export async function orderDatabase() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(`create table payment_orders(md_order text primary key, order_number text not null, amount numeric not null,
    description text, status text, created_at timestamptz default now(), last_checked_at timestamptz, notified_at timestamptz, last_error text);`);
  await db.exec(await readFile(new URL('../../../supabase/migrations/20261001120000_order_idempotency.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../../../supabase/migrations/20261001130000_cod_delivery_retry.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../../../supabase/migrations/20261027100000_cod_duplicate_guard.sql', import.meta.url), 'utf8'));
  const tables = new Set(['le_orders', 'le_order_effects', 'payment_orders']);
  const identifier = value => { if (!/^[a-z_]+$/.test(value)) throw new Error('Unsafe identifier'); return `"${value}"`; };
  const request = async (path, options = {}) => {
    const url = new URL(path, 'http://db.local/');
    if (url.pathname === '/rpc/le_reserve_cod_order') {
      const args = JSON.parse(options.body);
      const result = await db.query('select * from public.le_reserve_cod_order($1,$2,$3)',
        [args.p_order_id, args.p_payload, args.p_fingerprint]);
      return Response.json(result.rows);
    }
    if (url.pathname === '/rpc/le_recover_bank_order') {
      const args = JSON.parse(options.body || '{}');
      const result = await db.query(
        'select public.le_recover_bank_order($1,$2,$3,$4,$5,$6) as result',
        [args.p_order_id, args.p_payment_id, args.p_bank_status, args.p_bank_amount_kopecks,
          args.p_payment_url, args.p_description]
      );
      return new Response(JSON.stringify(result.rows.map(row => row.result)), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    const table = url.pathname.slice(1);
    if (!tables.has(table)) throw new Error(`Unexpected table ${table}`);
    const values = [];
    const bind = value => { values.push(value && typeof value === 'object' ? JSON.stringify(value) : value); return `$${values.length}`; };
    const clauses = [];
    for (const [field, filter] of url.searchParams) {
      if (['on_conflict', 'select', 'order', 'limit'].includes(field)) continue;
      const dot = filter.indexOf('.');
      const op = filter.slice(0, dot), value = filter.slice(dot + 1);
      if (op === 'is' && value === 'null') clauses.push(`${identifier(field)} is null`);
      else if (op === 'not' && value === 'is.null') clauses.push(`${identifier(field)} is not null`);
      else if (['eq', 'gte', 'lte', 'lt'].includes(op)) clauses.push(`${identifier(field)} ${{eq:'=',gte:'>=',lte:'<=',lt:'<'}[op]} ${bind(value)}`);
      else if (op === 'in' && value.startsWith('(') && value.endsWith(')')) {
        const members = value.slice(1, -1).split(',').filter(Boolean);
        if (!members.length) throw new Error('Empty in-filter');
        clauses.push(`${identifier(field)} in (${members.map(bind).join(',')})`);
      }
      else throw new Error('Unexpected filter');
    }
    const where = clauses.length ? ` where ${clauses.join(' and ')}` : '';
    const body = options.body ? JSON.parse(options.body) : null;
    let sql;
    if (options.method === 'POST') {
      const fields = Object.keys(body);
      const conflict = url.searchParams.get('on_conflict');
      sql = `insert into ${table} (${fields.map(identifier)}) values (${fields.map(field => bind(body[field]))})`;
      if (conflict) sql += ` on conflict (${identifier(conflict)}) do nothing`;
      sql += ' returning *';
    } else if (options.method === 'PATCH') {
      sql = `update ${table} set ${Object.keys(body).map(field => `${identifier(field)}=${bind(body[field])}`).join(',')}${where} returning *`;
    } else {
      const selected = url.searchParams.get('select') || '*';
      sql = `select ${selected === '*' ? '*' : selected.split(',').map(identifier)} from ${table}${where}`;
      if (url.searchParams.has('order')) {
        sql += ' order by ' + url.searchParams.get('order').split(',').map(term => {
          const [field, direction, nulls] = term.split('.');
          return `${identifier(field)} ${direction === 'desc' ? 'desc' : 'asc'}${nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : ''}`;
        }).join(',');
      }
      if (url.searchParams.has('limit')) sql += ` limit ${Number(url.searchParams.get('limit'))}`;
    }
    const result = await db.query(sql, values);
    return new Response(JSON.stringify(result.rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { db, request };
}
