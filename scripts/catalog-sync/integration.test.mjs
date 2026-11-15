import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { syncCatalog, buildSnapshot, diskGuard } from '../catalog-sync.mjs';
import { readFeedsOf } from './snapshot.mjs';
import { pinMedia } from './media.mjs';
import { readPointer, defaultPointerPath, repoRoot, snapshotsRoot } from '../../storefront/products/snapshot-acceptance.mjs';
import { csvRecords } from '../../supabase/functions/_shared/product-rules.mjs';
import { browserProof } from './browser-proof.mjs';
const quote=v=>'"'+String(v).replaceAll('"','""')+'"';
test('real offline production build after price/text/size/photo/add/delete edits; no-JS browser and local server use the same snapshot',async()=>{
  await diskGuard();const pointerBefore=await readFile(defaultPointerPath),base=await readFeedsOf(readPointer().manifestPath);
  const rows=csvRecords(base.feeds.trees),headers=Object.keys(rows[0]);
  for(const row of rows.filter(r=>r.id==='13')){row.title='Дарина проверка обновления';row.description='Новый текст из каталога';}
  const darina=rows.find(r=>r.id==='13'&&r.height_cm==='150');darina.price='23000';darina.branches='777';darina.photos=darina.photos.split('|').reverse().join('|');
  rows.push({...darina,id:'autosync-new-fixture',title:'Новая ёлка QA',height_cm:'171',price:'24000'});
  const removed=rows.find(r=>r.id!=='13'&&r.id!=='autosync-new-fixture').id;
  const next={...base.feeds,promos:base.feeds.promos.split(/\r?\n/)[0],trees:[headers.map(quote).join(','),...rows.filter(r=>r.id!==removed).map(r=>headers.map(h=>quote(r[h])).join(','))].join('\n')};
  const media=await pinMedia(next,{refreshRemote:false});
  const previous=await mkdtemp(join(tmpdir(),'le-sw-sync-prior-'));
  const lazyBody='/* previous lazy chunk */', lazyPath='assets/'+createHash('sha256').update(lazyBody).digest('hex')+'.js';
  await mkdir(join(previous,'assets'));await writeFile(join(previous,lazyPath),lazyBody);
  let snapshotId,server;
  const result=await syncCatalog({dryRun:true,mode:'production',previousAssets:previous},{
    prepareBlog:async()=>({status:'unchanged',warnings:[]}),
    fetchInputs:async()=>Object.fromEntries(['trees','decor','promos'].map(n=>[n,{...base.manifest.feeds[n],text:next[n]}])),pinMedia:async()=>media,
    build:async args=>{
      snapshotId=readPointer(args.pointerPath).id;assert.equal(args.previousAssets,previous);await buildSnapshot(args);
      assert.equal(await readFile(join(args.output,lazyPath),'utf8'),lazyBody);
      const routes=JSON.parse(await readFile(join(args.output,'product-routes.json'))),newRoute=routes.find(r=>r.id==='autosync-new-fixture');assert.ok(newRoute);
      const sitemap=await readFile(join(args.output,'sitemap.xml'),'utf8');assert.ok(sitemap.includes(newRoute.path));
      const report=JSON.parse(await readFile(join(args.output,'audit/build-report.json')));assert.ok(report.removedFromFeed.length>0);
      const html=await readFile(join(args.output,'tree/darina/index.html'),'utf8');assert.match(html,/Новый текст из каталога/);assert.match(html,/Дарина проверка обновления/);assert.match(html,/777/);
      const search=JSON.parse(await readFile(join(args.output,'search-index.json')));assert.ok(search.some(r=>r.path===newRoute.path.replace(/\/+$/, '')+'/'&&r.cardHtml));
      server=spawn(process.execPath,['storefront/server.mjs','--mode=preview',`--root=${args.output}`],{cwd:repoRoot,env:{...process.env,STOREFRONT_PORT:'0'},stdio:['ignore','pipe','pipe']});
      const port=await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('Server startup timeout')),15000);server.stdout.on('data',b=>{const m=/localhost:(\d+)/.exec(String(b));if(m){clearTimeout(timer);ok(m[1]);}});server.stderr.on('data',b=>{clearTimeout(timer);fail(Error(String(b)))});});
      const origin=`http://127.0.0.1:${port}`,config=await(await fetch(origin+'/f/storefront-config.js')).text();assert.match(config,/"payment":null/);assert.match(config,/"lead":null/);
      const csv=await(await fetch(origin+'/__offline/catalog/trees.csv')).text();assert.match(csv,/catalog-pinned/);assert.match(csv,/23000/);
      const browser=await browserProof(origin,{expectedPrice:23000,screenshot:join(repoRoot,'agent-context/catalog-autosync-nojs.png')});
      await writeFile(join(repoRoot,'agent-context/catalog-autosync-dryrun-evidence.json'),JSON.stringify({snapshotId,price:23000,text:'Новый текст из каталога',branches:777,newRoute:newRoute.path,removedProduct:removed,sitemap:true,search:true,browser},null,2)+'\n');
      const closed=new Promise(r=>server.once('close',r));server.kill();await closed;server=null;
    },
  }).finally(async()=>{
    if(server){const closed=new Promise(r=>server.once('close',r));server.kill();await closed;}
    if(snapshotId){await rm(join(snapshotsRoot,snapshotId),{recursive:true,force:true});await rm(join(repoRoot,'storefront/catalog-import/candidates',snapshotId),{recursive:true,force:true});}
    await rm(previous,{recursive:true,force:true});
    assert.deepEqual(await readFile(defaultPointerPath),pointerBefore);await diskGuard();
  });
  assert.equal(result.status,'dry-run');assert.equal(result.notification.sent,false);
});
test('approved active snapshot preview renders Darina 22000 and local catalog photos without JavaScript',async()=>{
  const work=await mkdtemp(join('/tmp','le-sync-approved-')),output=join(work,'dist');let server;
  try{
    await diskGuard();await buildSnapshot({pointerPath:defaultPointerPath,output,mode:'preview'});
    server=spawn(process.execPath,['storefront/server.mjs','--mode=preview',`--root=${output}`],{cwd:repoRoot,env:{...process.env,STOREFRONT_PORT:'0'},stdio:['ignore','pipe','pipe']});
    const port=await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('Server startup timeout')),15000);server.stdout.on('data',b=>{const m=/localhost:(\d+)/.exec(String(b));if(m){clearTimeout(timer);ok(m[1]);}});server.stderr.on('data',b=>{clearTimeout(timer);fail(Error(String(b)))});});
    const origin=`http://127.0.0.1:${port}`,browser=await browserProof(origin,{expectedPrice:22000,screenshot:join(repoRoot,'agent-context/catalog-autosync-approved-nojs.png')});
    const product=JSON.parse(/<script type="application\/json" data-storefront-page-product>([^]*?)<\/script>/.exec(await readFile(join(output,'tree/darina/index.html'),'utf8'))[1]);assert.equal(product.variants.find(v=>v.height===230).price,46000);
    await writeFile(join(repoRoot,'agent-context/catalog-autosync-approved-browser.json'),JSON.stringify({active:readPointer().id,darina150:22000,darina230:46000,browser},null,2)+'\n');
  }finally{if(server){const closed=new Promise(r=>server.once('close',r));server.kill();await closed;}await rm(work,{recursive:true,force:true});await diskGuard();}
});
