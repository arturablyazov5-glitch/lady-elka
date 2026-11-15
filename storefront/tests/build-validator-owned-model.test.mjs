import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';
const exec = promisify(execFile);
const deny = 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Network forbidden")}';
test('offline validator accepts 42 models and rejects corrupt owned state', async () => {
  const workspace = await isolatedWorkspace(resolve(import.meta.dirname, '../..'));
  let server;
  try {
    await exec(process.execPath, ['--import', deny, 'storefront/build.mjs', '--mode=preview'], { cwd: workspace.directory });
    server = spawn(process.execPath, ['--import', deny, 'storefront/server.mjs', '--mode=preview'], { cwd: workspace.directory, env: { ...process.env, STOREFRONT_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview startup timeout')), 10000);
      server.stdout.on('data', b => { const m = b.toString().match(/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
      server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
    });
    const validate = () => exec('python3', ['storefront/audit/validate_build.py', `http://127.0.0.1:${port}`], { cwd: workspace.directory, maxBuffer: 1024 * 1024 });
    const valid = JSON.parse((await validate()).stdout);
    assert.equal(valid.products, 42); assert.equal(valid.html, 42); assert.deepEqual(valid.errors, []);
    const file = join(workspace.directory, 'storefront/dist/tree/miranda/index.html');
    const original = await readFile(file, 'utf8');
    const pattern = /(<script type="application\/json" data-storefront-page-product>)([\s\S]*?)(<\/script>)/;
    for (const [label, mutate] of [
      ['invalid JSON', () => '{broken'],
      ['wrong ID', v => { v.id = 'bad'; return v; }],
      ['wrong variant', v => { v.selectedVariant.id = 'bad'; return v; }],
      ['wrong height', v => { v.selectedVariant.height += 1; return v; }],
      ['missing model', () => null],
      ['wrong variant options', v => { v.selectedVariant.options.height = '999'; return v; }],
      ['wrong price', v => { v.variants[0].price += 1; return v; }],
      ['wrong image', v => { v.variants[0].image = '/wrong.png'; return v; }],
    ]) {
      const mutated = mutate(JSON.parse(original.match(pattern)[2]));
      await writeFile(file, original.replace(pattern, (_, a, b, c) => a + (typeof mutated === 'string' ? mutated : JSON.stringify(mutated)) + c));
      await assert.rejects(validate, error => {
        assert.equal(error.code, 1, label);
        const report = JSON.parse(error.stdout);
        assert.ok(report.errors.some(([path, reason]) => path === '/tree/miranda' && reason.includes('model')), label);
        return true;
      }, label);
    }
    // The default height varies by snapshot; mutate the first owned option directly.
    await writeFile(file, original.replace(/(<select data-storefront-option="height"[^>]*>\s*<option value=")[^"]+/, '$1999'));
    await assert.rejects(validate, error => { assert.equal(error.code, 1); assert.ok(JSON.parse(error.stdout).errors.some(([, reason]) => reason.includes('options/selection'))); return true; });
    await writeFile(file, original);
    assert.deepEqual(JSON.parse((await validate()).stdout).errors, []);
    console.log('Validator evidence: 42/42 pages; 9 corruptions rejected; restored artifact passes');
  } finally {
    if (server && server.exitCode === null) { const closed = new Promise(r => server.once('close', r)); server.kill('SIGTERM'); await closed; }
    await workspace.cleanup();
  }
});
