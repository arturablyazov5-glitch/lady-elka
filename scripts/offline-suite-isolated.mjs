import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isolatedWorkspace } from './offline-suite-isolated-workspace.mjs';
const root = resolve(import.meta.dirname, '..');
const workspace = await isolatedWorkspace(root);
const run = (args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: workspace.directory, stdio: 'inherit', env: { ...process.env, ...env } });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`Offline command exited ${code}: ${args.join(' ')}`)));
});
try {
  const deny = join(workspace.directory, 'deny.mjs');
  await writeFile(deny, "const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:input);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('External network forbidden in offline suite');return nativeFetch(input,{...init,redirect:init?.redirect==='manual'?'manual':'error'})};\n");
  const files = [];
  for (const directory of ['storefront/tests', 'supabase/functions/pay/tests', 'scripts', 'app/tests', 'local-backend-v2/tests']) {
    for (const name of await readdir(join(workspace.directory, directory))) {
      if (name.endsWith('.test.mjs')) files.push(`${directory}/${name}`);
    }
  }
  console.log(JSON.stringify({stage:'node-tests',files:files.length,productionReady:false}));
  await run(['--import', deny, '--test', '--test-concurrency=1', ...files]);
  if(process.argv.includes('--with-v2-browser')) await run(['--import', deny, 'local-backend-v2/browser-qa/run.mjs']);
  await run(['storefront/tests/checkout-browser-offline-run.mjs']);
  await run(['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Build network forbidden")}', 'storefront/build.mjs', '--mode=preview']);
  await run(['storefront/tests/taptop-search-routes-browser.mjs'], { LE_ROUTES_QA_ROOT: workspace.directory });
} finally { await workspace.cleanup(); }
