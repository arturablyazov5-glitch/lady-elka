import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const projectRoot = fileURLToPath(new URL('../',import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent,child) => child === parent || child.startsWith(parent+path.sep);
const unsafeName = relative => relative.split('/').some(part =>
  part.startsWith('.') || /^(?:server|secrets?|private|blog-content|node_modules)$/i.test(part) ||
  /(?:\.(?:pem|key|p12|pfx)|\.env(?:\..*)?)$/i.test(part));

// Reject all symlinks, even internal ones: cp semantics otherwise vary by environment.
export async function snapshot(source) {
  const rows = [];
  async function walk(dir,relative='') {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe source directory: ${relative || '.'}`);
    for (const name of (await fs.readdir(dir)).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      if (unsafeName(rel)) throw new Error(`Forbidden release path: ${rel}`);
      const full = path.join(dir,name), info = await fs.lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Source symlink rejected: ${rel}`);
      if (info.isDirectory()) await walk(full,rel);
      else if (info.isFile()) {
        const bytes = await fs.readFile(full);
        rows.push({path:rel,bytes:bytes.length,sha256:sha256(bytes)});
      } else throw new Error(`Special source file rejected: ${rel}`);
    }
  }
  await walk(source);
  return rows.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}

async function noSymlinkAncestors(target) {
  let current=path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Output/source ancestor symlink rejected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function buildAdminRelease(output,{root=projectRoot}={}) {
  if (!output || !path.isAbsolute(output)) throw new Error('Provide an absolute external output path');
  root=path.resolve(root); output=path.resolve(output);
  await noSymlinkAncestors(root); await noSymlinkAncestors(output);
  root=await fs.realpath(root);
  if (inside(root,output) || inside(output,root)) throw new Error('Output must be external to the project and must not contain it');
  try { await fs.lstat(output); throw new Error('Output already exists; choose a fresh path'); }
  catch(error) { if (error.code !== 'ENOENT') throw error; }
  const source=path.join(root,'app/public'),workflowPath=path.join(root,'.github/workflows/pages.yml');
  await noSymlinkAncestors(source); await noSymlinkAncestors(workflowPath);
  if (!(await fs.lstat(workflowPath)).isFile() || (await fs.lstat(workflowPath)).isSymbolicLink()) throw new Error('Unsafe workflow');
  const workflow=await fs.readFile(workflowPath);
  const workflowText=workflow.toString();
  if (!/^\s*run: cp -R app\/public site\s*$/m.test(workflowText) || !/^\s*path: site\s*$/m.test(workflowText)) throw new Error('Workflow no longer copies app/public into uploaded site');
  const before=await snapshot(source);
  for (const required of ['index.html','js/blog.js','js/blog-model.js','js/blog-rich-editor.js','css/blog.css']) {
    if (!before.some(row=>row.path===required)) throw new Error(`Missing required release file: ${required}`);
  }
  const sourceSnapshot={version:1,source:'app/public',workflow:{path:'.github/workflows/pages.yml',sha256:sha256(workflow),copy:'cp -R app/public site',upload:'site'},files:before};
  await fs.mkdir(output,{recursive:true});
  try {
    const site=path.join(output,'site'); await fs.mkdir(site);
    for (const row of before) {
      const target=path.join(site,row.path),full=path.join(source,row.path);
      const stat=await fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Source changed: ${row.path}`);
      const bytes=await fs.readFile(full);
      if (sha256(bytes)!==row.sha256) throw new Error(`Source changed: ${row.path}`);
      await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,bytes,{flag:'wx'});
    }
    const after=await snapshot(source),released=await snapshot(site);
    if (JSON.stringify(before)!==JSON.stringify(after) || JSON.stringify(before)!==JSON.stringify(released) || sha256(await fs.readFile(workflowPath))!==sha256(workflow)) throw new Error('Source/workflow changed during assembly');
    const sourceJSON=JSON.stringify(sourceSnapshot,null,2)+'\n';
    await fs.writeFile(path.join(output,'source-snapshot.json'),sourceJSON,{flag:'wx'});
    const manifest={version:1,algorithm:'SHA-256',releaseRoot:'site',files:released,sourceSnapshot:{path:'source-snapshot.json',sha256:sha256(sourceJSON)}};
    await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    return {output,files:released.length,manifest:path.join(output,'manifest.json')};
  } catch(error) {
    // Only this fresh output is owned by this invocation; never touch previous artifacts.
    await fs.rm(output,{recursive:true,force:true}); throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildAdminRelease(process.argv[2]),null,2)); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}
