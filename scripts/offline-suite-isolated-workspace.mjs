import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';

// Copy local source trees only: never open env files, credentials or generated outputs.
export async function isolatedWorkspace(root) {
  const directory = await mkdtemp(join('/tmp', 'le-offline-suite-'));
  try {
    for (const name of ['storefront', 'src', 'supabase', 'scripts', 'app', 'local-backend-v2', 'package.json']) {
      const source = join(root, name);
      await cp(source, join(directory, name), { recursive: true, filter(path) {
        const parts = relative(source, path).split('/');
        return !parts.some(part => ['dist', 'node_modules', '.git', '.temp', '.branches', 'blog-content', 'content-store', 'outputs'].includes(part)
          || /(?:\.private\.json$|^evidence\.json$)/i.test(part)
          || /^(?:\.env(?:\.|$)|.*(?:secret|credential).*\.(?:json|toml|env)$)/i.test(part));
      } });
    }
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
