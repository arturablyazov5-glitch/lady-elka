// Read ignored local secrets without printing values or passing them in argv.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
export async function leadEnv() {
  const values = {};
  for (const file of ['Переменные окружения.ini', '.env']) {
    try { Object.assign(values, parseEnv(await readFile(file, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  Object.assign(values, process.env);
  values.SUPABASE_URL ||= 'https://mgnotvaahftrbifqtahf.supabase.co';
  return values;
}
