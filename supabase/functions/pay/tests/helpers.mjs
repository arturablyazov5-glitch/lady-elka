import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { orderDatabase } from '../../../../storefront/tests/helpers/order-db.mjs';

// Shared order database plus the rate-limit migration and its RPC (real PostgreSQL semantics via PGlite).
export async function payDatabase() {
  const base = await orderDatabase();
  await base.db.exec(await readFile(new URL('../../../migrations/20261008160000_order_rate_limits.sql', import.meta.url), 'utf8'));
  const request = async (path, options = {}) => {
    const url = new URL(path, 'http://db.local/');
    if (url.pathname === '/rpc/le_rate_limit_take') {
      const args = JSON.parse(options.body || '{}');
      const result = await base.db.query('select public.le_rate_limit_take($1::text[], $2::integer[], $3::integer[]) as value',
        [args.p_buckets, args.p_limits, args.p_windows]);
      return Response.json(result.rows[0].value);
    }
    return base.request(path, options);
  };
  return { db: base.db, request };
}

// PAY_SOURCE lets a reviewer run the same scenarios against a pre-fix copy of index.ts.
export async function loadPay(exportsList) {
  const sourcePath = process.env.PAY_SOURCE || 'supabase/functions/pay/index.ts';
  const source = await readFile(sourcePath, 'utf8');
  const compiled = await build({ stdin: { contents: `${source}\nexport { ${exportsList.join(', ')} };`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
