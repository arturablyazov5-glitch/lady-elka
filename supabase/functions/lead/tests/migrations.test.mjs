// Supabase CLI keys migrations by the numeric version prefix: duplicates break `db push` / `migration list`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { leadMigrations } from './database.mjs';

test('every migration version in supabase/migrations is unique and well-formed', async () => {
  const files = (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
  const seen = new Map();
  for (const file of files) {
    const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(file);
    assert.ok(match, `bad migration file name: ${file}`);
    assert.ok(!seen.has(match[1]), `duplicate version ${match[1]}: ${seen.get(match[1])} and ${file}`);
    seen.set(match[1], file);
  }
});

test('lead migrations exist, are applied in version order, and lead-ops --deploy uses the same list', async () => {
  const versions = leadMigrations.map(f => f.split('/').at(-1).slice(0, 14));
  assert.deepEqual([...versions].sort(), versions);
  const files = await readdir('supabase/migrations');
  for (const f of leadMigrations) assert.ok(files.includes(f.split('/').at(-1)), `missing ${f}`);
  const ops = await readFile('scripts/lead-ops.mjs', 'utf8');
  const list = /const leadMigrationFiles = (\[[^\]]+\])/.exec(ops);
  assert.ok(list, 'leadMigrationFiles not found in lead-ops.mjs');
  assert.deepEqual(JSON.parse(list[1].replaceAll("'", '"')), leadMigrations);
});
