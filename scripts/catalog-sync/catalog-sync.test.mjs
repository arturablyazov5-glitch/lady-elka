import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { syncCatalog, diskGuard, mediaDigest } from '../catalog-sync.mjs';
import { readPointer, defaultPointerPath, repoRoot, snapshotsRoot, snapshotAcceptance } from '../../storefront/products/snapshot-acceptance.mjs';
import { readFeedsOf } from './snapshot.mjs';
import { checkCatalog } from './guards.mjs';
import { pinMedia } from './media.mjs';
import { telegramTarget, notify } from './notify.mjs';
import { publish } from './publish.mjs';
import { resolveRoutes } from '../../storefront/products/routes.mjs';
import { treeProducts, decorProducts, csvRecords } from '../../supabase/functions/_shared/product-rules.mjs';
const baseline = await readFeedsOf(readPointer().manifestPath), basePointer = await readFile(defaultPointerPath);
const quote = value => '"' + String(value).replaceAll('"','""') + '"';
function change(feeds, mutate) { const rows = csvRecords(feeds.trees), headers = Object.keys(rows[0]); mutate(rows); return {...feeds,trees: [headers.map(quote).join(','),...rows.map(r => headers.map(k=>quote(r[k])).join(','))].join('\n')}; }
const changed = change(baseline.feeds, rows => rows.find(r=>r.id==='13' && r.height_cm==='150').price='23000');
const inputs = feeds => Object.fromEntries(['trees','decor','promos'].map(n=>[n,{...baseline.manifest.feeds[n],text:feeds[n]}]));

test('guards block missing active title/price/photo, product drop, price jump and failed media; a normal price edit passes', () => {
  assert.equal(checkCatalog({prev:baseline.feeds,next:changed}).passed,true);
  for(const next of [change(baseline.feeds,r=>r.find(r=>r.id==='13').title=''),change(baseline.feeds,r=>r.find(r=>r.id==='13').price=''),change(baseline.feeds,r=>r.find(r=>r.id==='13').photos=''),change(baseline.feeds,r=>r.find(r=>r.id==='13').price='100000'),change(baseline.feeds,r=>r.splice(0,170))]) assert.equal(checkCatalog({prev:baseline.feeds,next}).passed,false);
  assert.equal(checkCatalog({prev:baseline.feeds,next:changed,mediaFailures:[{rawURL:'photo',error:'404'}]}).passed,false);
});
test('Telegram only accepts one private id, refuses group even with old override; dry runs make no network call', async()=>{
  assert.equal(telegramTarget({TG_BOT_TOKEN:'fixture',LE_SYNC_TG_CHAT_ID:'-100123',LE_SYNC_TG_ALLOW_GROUP:'1'}).ok,false);
  assert.equal(telegramTarget({TG_BOT_TOKEN:'fixture',TG_CHAT_IDS:'123,456'}).ok,false);
  let calls=0; await notify('fixture',{env:{TG_BOT_TOKEN:'fixture',LE_SYNC_TG_CHAT_ID:'-100123'},fetchImpl:()=>{calls++;throw Error('network')},log:()=>{}}); assert.equal(calls,0);
});
test('route map preserves URLs across title edits/removal and generates a landscape route for new thuja',()=>{
  const products={tree:treeProducts(csvRecords(changed.trees)),decor:decorProducts(csvRecords(changed.decor))};
  products.tree.set('new-id',{id:'new-id',title:'Туя новая',variants:[{category:'Туя'}]});
  const saved=[{id:'13',kind:'tree',path:'/tree/darina'},{id:'deleted',kind:'tree',path:'/tree/deleted'}];
  const routes=resolveRoutes(saved,products); assert.ok(routes.some(r=>r.path==='/tree/deleted')); assert.equal(routes.find(r=>r.id==='13').path,'/tree/darina'); assert.match(routes.find(r=>r.id==='new-id').path,/^\/tree\/tuya-/);
});
test('atomic local publisher preserves old release and refuses in-place document root',async()=>{
  const work=await mkdtemp(join(tmpdir(),'le-sync-publish-'));
  try {const dist=join(work,'build'),target=join(work,'current');await mkdir(dist);await writeFile(join(dist,'index.html'),'old');const old=await publish(dist,{method:'dir',env:{LE_DEPLOY_DIR:target}});await writeFile(join(dist,'index.html'),'new');await publish(dist,{method:'dir',env:{LE_DEPLOY_DIR:target}});assert.equal(await readFile(join(target,'index.html'),'utf8'),'new');assert.equal((await readdir(target+'.releases')).length,2);assert.equal(await readFile(join(old.release,'index.html'),'utf8'),'old');await assert.rejects(publish(dist,{method:'dir',env:{LE_DEPLOY_DIR:dist}}),/symlink/);}finally{await rm(work,{recursive:true,force:true});}
});
test('sync failure never flips pointer; dry-run price edit builds; repeat after success is unchanged',async()=>{
  const work=await mkdtemp(join(tmpdir(),'le-sync-test-')), pointerPath=join(work,'active.json');await writeFile(pointerPath,basePointer);
  const nextInputs=inputs(changed), seen=[]; const media=await pinMedia(changed,{refreshRemote:false});
  let snapshotId;
  const deps={prepareBlog:async()=>({status:'unchanged',warnings:[]}),fetchInputs:async()=>nextInputs,pinMedia:async()=>media,notify:async()=>{seen.push('notify');return {sent:true}},build:async({output})=>{seen.push('build');await mkdir(output);await writeFile(join(output,'product-routes.json'),'[]')},publish:async()=>{seen.push('publish');throw Error('upload failed')}};
  try {
    const dry=await syncCatalog({pointerPath,dryRun:true},deps);snapshotId=dry.id;assert.equal(dry.status,'dry-run');assert.deepEqual(await readFile(pointerPath),basePointer);assert.deepEqual(seen,['build']);
    await assert.rejects(syncCatalog({pointerPath,dryRun:false,method:'dir'},{...deps,build:async()=>{throw Error('build failed')}}),/build failed/);assert.deepEqual(await readFile(pointerPath),basePointer);
    await assert.rejects(syncCatalog({pointerPath,dryRun:false,method:'dir'},deps),/upload failed/);assert.deepEqual(await readFile(pointerPath),basePointer);
    const result=await syncCatalog({pointerPath,dryRun:false,method:'dir'},{...deps,publish:async()=>{seen.push('publish');return {method:'dir'}}});assert.equal(result.status,'published');assert.equal(readPointer(pointerPath).id,snapshotId);
    const retainedRoot = pointerPath + '.previous-assets';
    assert.equal(await readFile(join(retainedRoot,'product-routes.json'),'utf8'),'[]');
    const publishedPointer=await readFile(pointerPath);
    await writeFile(pointerPath,basePointer);
    await syncCatalog({pointerPath,dryRun:true},{...deps,build:async args=>{
      assert.equal(args.previousAssets,retainedRoot);
      assert.equal(await readFile(join(args.previousAssets,'product-routes.json'),'utf8'),'[]');
      await deps.build(args);
    }});
    await writeFile(pointerPath,publishedPointer);
    const builds=seen.filter(s=>s==='build').length;assert.equal((await syncCatalog({pointerPath,dryRun:false,method:'dir'},deps)).status,'unchanged');assert.equal(seen.filter(s=>s==='build').length,builds);
    const manifest=JSON.parse(await readFile(join(snapshotsRoot,snapshotId,'manifest.json')));const provenance=JSON.parse(await readFile(join(snapshotsRoot,snapshotId,'provenance.json')));assert.throws(()=>snapshotAcceptance(manifest,provenance,Buffer.from('{}')),/checksum/);
  }finally{
    await rm(work,{recursive:true,force:true});
    if(snapshotId){await rm(join(snapshotsRoot,snapshotId),{recursive:true,force:true});await rm(join(repoRoot,'storefront/catalog-import/candidates',snapshotId),{recursive:true,force:true});}
    assert.deepEqual(await readFile(defaultPointerPath),basePointer);
  }
});
test('disk guard aborts before writes below threshold',async()=>{await assert.rejects(diskGuard(tmpdir(),Number.MAX_SAFE_INTEGER),/1.5/);});
test('SQL queue detects every catalog mutation, debounce and ACK preserve concurrent revision; no auto enable',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create table le_catalog_products(id text); create table le_catalog_settings(id int);create table le_promo_codes(id text);create schema storage;create table storage.objects(id int,bucket_id text);create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);insert into vault.decrypted_secrets values('le_catalog_sync_github_token','fixture');create schema net;create table net._http_response(id bigint,status_code int);create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$select 42::bigint$$;`);
    const sql=await readFile(join(repoRoot,'supabase/migrations/20261008110000_catalog_autosync.sql'),'utf8');await db.exec(sql);await db.exec(sql);
    await db.exec(`insert into le_catalog_products values('13');update le_catalog_products set id='14';delete from le_catalog_products;insert into le_promo_codes values('QA');update le_promo_codes set id='QA2';delete from le_promo_codes;insert into le_catalog_settings values(1);insert into storage.objects values(1,'le-catalog-images');update storage.objects set id=2;delete from storage.objects;`);
    let s=(await db.query('select * from le_catalog_sync_state')).rows[0];assert.equal(s.revision,10);assert.equal(s.enabled,false);
    await db.exec(`select le_catalog_sync_dispatch();`);assert.equal((await db.query('select request_id from le_catalog_sync_state')).rows[0].request_id,null);
    await db.exec(`update le_catalog_sync_state set enabled=true,repository='owner/repo';select le_catalog_sync_dispatch();`);assert.equal((await db.query('select request_id from le_catalog_sync_state')).rows[0].request_id,null);
    await db.exec(`update le_catalog_sync_state set changed_at=now()-interval '65 seconds';select le_catalog_sync_dispatch();insert into net._http_response values(42,500);select le_catalog_sync_dispatch();`);
    assert.equal((await db.query('select sent_revision from le_catalog_sync_state')).rows[0].sent_revision,0);
    await db.exec(`update le_catalog_sync_state set requested_at=now()-interval '3 minutes';select le_catalog_sync_dispatch();update net._http_response set status_code=204;insert into le_catalog_products values('15');select le_catalog_sync_dispatch();`);
    s=(await db.query('select * from le_catalog_sync_state')).rows[0];assert.equal(s.sent_revision,10);assert.equal(s.revision,11);assert.equal(s.request_id,null);
  }finally{await db.close();}
});
test('same Supabase photo URL is fetched again and a changed image changes its content hash',async()=>{
  const mediaManifest=JSON.parse(await readFile(readPointer().mediaPath)),remote=mediaManifest.assets.filter(a=>a.rawURL.includes('/le-catalog-images/')&&a.contentType==='image/webp');
  const [a,b]=remote;assert.notEqual(a.sha256,b.sha256);
  const rows=csvRecords(baseline.feeds.trees),row={...rows.find(r=>r.photos.includes(a.rawURL)),photos:a.rawURL};const headers=Object.keys(row);
  const feeds={...baseline.feeds,trees:[headers.map(quote).join(','),headers.map(h=>quote(row[h])).join(',')].join('\n'),decor:baseline.feeds.decor.split(/\r?\n/)[0]};
  let calls=0;const bytes=await readFile(join(repoRoot,b.localPath));
  const media=await pinMedia(feeds,{refreshRemote:true,fetchImpl:async()=>{calls++;return new Response(bytes,{status:200,headers:{'Content-Type':'image/webp'}})}});
  assert.equal(calls,1);assert.equal(media.failures.length,0);assert.equal(media.assets[0].sha256,b.sha256);
  assert.notEqual(mediaDigest(media),mediaDigest({assets:[a]}));
  const hexURL=a.rawURL.replace(/[^/]+$/, 'd45b11afdd19df532bcc719121cf6dfd411c.webp');
  const hexFeeds={...feeds,trees:feeds.trees.replaceAll(a.rawURL,hexURL)};
  const hexMedia=await pinMedia(hexFeeds,{refreshRemote:true,fetchImpl:async()=>new Response(bytes,{status:200,headers:{'Content-Type':'image/webp'}})});assert.equal(hexMedia.failures.length,0,JSON.stringify(hexMedia.failures));
});
