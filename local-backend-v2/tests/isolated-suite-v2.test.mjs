import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedWorkspace } from '../../scripts/offline-suite-isolated-workspace.mjs';
test('unified workspace copies app/v2 sources, excludes credentials/content/output and isolates writes',async()=>{
 const root=await mkdtemp('/tmp/le-isolation-source-');let workspace;
 try{
  for(const name of ['storefront','src','supabase','scripts','app','local-backend-v2','node_modules'])await mkdir(join(root,name));
  await writeFile(join(root,'package.json'),'{}');
  for(const name of ['app','local-backend-v2']){
   await writeFile(join(root,name,'source.mjs'),'original');
   for(const file of ['.env','.env.local','billing.private.json','credentials.json','evidence.json'])await writeFile(join(root,name,file),'must not copy');
   for(const dir of ['blog-content','content-store','outputs','dist']){await mkdir(join(root,name,dir));await writeFile(join(root,name,dir,'private'),'must not copy');}
  }
  workspace=await isolatedWorkspace(root);
  for(const name of ['app','local-backend-v2']){
   assert.equal(await readFile(join(workspace.directory,name,'source.mjs'),'utf8'),'original');
   for(const file of ['.env','.env.local','billing.private.json','credentials.json','evidence.json','blog-content','content-store','outputs','dist'])await assert.rejects(access(join(workspace.directory,name,file)),{code:'ENOENT'});
   await writeFile(join(workspace.directory,name,'source.mjs'),'test write');
   assert.equal(await readFile(join(root,name,'source.mjs'),'utf8'),'original');
  }
  await workspace.cleanup();await assert.rejects(access(workspace.directory),{code:'ENOENT'});
 }finally{await workspace?.cleanup();await rm(root,{recursive:true,force:true});}
});
