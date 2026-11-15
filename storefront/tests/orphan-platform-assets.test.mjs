import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const publicRoot = resolve(import.meta.dirname, '../public');
const removed = [
  "assets/site/main.min.js",
  "assets/site/main.min.js?1790676040",
  "assets/site/s3/js/common.min.js",
  "assets/site/s3/js/lang/ru.js",
  "assets/site/vk-id/sdk/2.6.1/index.js",
  "g/libs/jquery/1.10.2/jquery.min.js",
  "g/s3/mosaic/js/do/redesign/do.839.js",
  "g/s3/mosaic/js/do/redesign/do.920.js",
  "g/s3/mosaic/js/do/redesign/do.963.js",
  "g/s3/mosaic/js/do/redesign/do.getCurrentProps.js",
  "g/s3/mosaic/js/do/redesign/do.jquery.inputmask.js",
  "g/s3/mosaic/js/do/redesign/do.jquery.js",
  "g/s3/mosaic/js/do/redesign/do.js",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770426",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770454",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770456",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770457",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770458",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770459",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770462",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770523",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770530",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770548",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770549",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770557",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770558",
  "g/s3/mosaic/js/do/redesign/do.js?rnd=1790770559",
  "g/s3/mosaic/js/do/redesign/do.lodash-es.js",
  "g/s3/mosaic/js/do/redesign/do.photoswipe.js",
  "g/s3/mosaic/js/do/redesign/do.resizeController.js",
  "g/s3/mosaic/js/do/redesign/do.section.js",
  "g/s3/mosaic/js/do/redesign/do.shop2-tools.js",
  "g/s3/mosaic/js/do/redesign/do.slick.js",
  "g/s3/mosaic/js/do/redesign/do.swapSrc.js",
  "g/s3/mosaic/js/do/redesign/do.swiper.js",
  "g/s3/mosaic/js/do/redesign/do.tt_accordion.js",
  "g/s3/mosaic/js/do/redesign/do.tt_animation.js",
  "g/s3/mosaic/js/do/redesign/do.tt_blocklist.js",
  "g/s3/mosaic/js/do/redesign/do.tt_collection_v1.js",
  "g/s3/mosaic/js/do/redesign/do.tt_form.js",
  "g/s3/mosaic/js/do/redesign/do.tt_image.js",
  "g/s3/mosaic/js/do/redesign/do.tt_link_universal.js",
  "g/s3/mosaic/js/do/redesign/do.tt_menu.js",
  "g/s3/mosaic/js/do/redesign/do.tt_modal.js",
  "g/s3/mosaic/js/do/redesign/do.tt_search_bar.js",
  "g/s3/mosaic/js/do/redesign/do.tt_slider.js",
  "g/s3/mosaic/js/do/redesign/do.tt_up_button.js",
  "g/s3/mosaic/js/do/redesign/do.tt_video.js"
];

test('48 captured platform JS files remain physically absent, including query captures', async () => {
  assert.equal(removed.length, 48);
  for (const file of removed) await assert.rejects(stat(join(publicRoot, file)), { code: 'ENOENT' });
  for (const folder of ['g', 'assets/site']) {
    for (const file of await readdir(join(publicRoot, folder), { recursive: true })) {
      assert.ok(!/\.js(?:\?|$)/i.test(file), `unexpected platform JS: ${folder}/${file}`);
    }
  }
  for (const file of ['f/site-runtime.js', 'search.js', 'local-guard.js']) assert.ok((await stat(join(publicRoot, file))).size > 0);
});

test('source HTML, CSS and owned modules have no URL consumer of removed captures', async () => {
  const files = [];
  for (const file of await readdir(publicRoot, { recursive: true })) {
    if (/\.(?:html|css)$/.test(file) || ['f/site-runtime.js', 'search.js', 'local-guard.js'].includes(file)) files.push(join(publicRoot, file));
  }
  for (const folder of ['client', 'products', 'styles', 'config']) {
    const directory = resolve(import.meta.dirname, '..', folder);
    for (const file of await readdir(directory, { recursive: true })) if (/\.(?:js|mjs|css)$/.test(file)) files.push(join(directory, file));
  }
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const removedFile of removed) assert.ok(!content.includes(`/${removedFile}`), `${file} consumes ${removedFile}`);
  }
});

// Exact preservation evidence for the neighboring styles, fonts and media.
const preserved = {
  "g/s3/mosaic/css/ms_site_default.css": "7212a17e6c58661c4f23c1d18069a81c2aa2c5cca70d62b04aa456c89f760713",
  "g/s3/mosaic/images/widgets/slider-arrow-right.svg": "6a9d85ff3dc3c97b06b07a556977082e109ce86bb1c84a351788be1158652f6f",
  "g/s3/mosaic/images/widgets/blocklist-arrow-left.svg": "c5b5a1cfa134bd661678b24645656d68382ff233bdd6b7c9a239d454d534c588",
  "g/s3/mosaic/images/widgets/slider-arrow-left.svg": "eb756dde8602ae982ec3c7686d3ee7cba9b7e3109ae1d72a40ef5ed11be8b805",
  "g/s3/mosaic/images/widgets/upload-button-icon.svg": "7e8ecf1f3aa4069e2f93de895f475ad3e903f10b90224403822892de36c7a523",
  "g/s3/mosaic/images/widgets/map.svg": "3cdbd1531dcf7260cb678c697299962eee9d18d62be0ad5ec4683e4fa87e77b3",
  "g/s3/mosaic/images/widgets/uploading.svg": "efe18ec1883519af301cfe0680cd011bb5fc02544163ecfc6f9f369a8737c877",
  "g/s3/mosaic/images/widgets/up-button.svg": "7b778fa4a6ed597d0af9644e09e7ff963af226b6971b9be2c007538473342123",
  "g/s3/mosaic/images/widgets/blocklist-arrow-right.svg": "72e253df579ea51aed02745b058650454f27063e5a2f72eb6f8f8288bb6490e3",
  "g/s3/mosaic/images/widgets/menu-arrow-left.svg": "5e0ba1edead5952d0e795565bf723ca8e2a961333b7e2589c7845bcf134f454b",
  "g/s3/mosaic/images/widgets/menu-burger.svg": "22c5a9b36673c01e50172f41f0f013ba1200f451e6b13667488250511989dd7e",
  "g/s3/mosaic/images/widgets/upload-remove-icon.svg": "25e1622f35e199b781f4018ac60c18143efd148878e3c9159197c873e17d156b",
  "g/s3/mosaic/images/widgets/info.svg": "1fd8ddaeb901034a5bfa0da6de4f61a3def229c9abe83e5a4381ed8226fd89fb",
  "g/s3/mosaic/images/widgets/collection-pagination-left.svg": "745fa76bd39addbd216e25fdd682f4131f18bfef55c9c7f8da32d102550ce60f",
  "g/s3/mosaic/images/widgets/popup-close.svg": "1fd53e2a548c476e84ec81db34d115bf08b128db157b8a9cc25d182cea40739a",
  "g/s3/mosaic/images/widgets/menu-arrow-down.svg": "384816fbf2246d1ac19548037c534a6f3028a82e3e29605f3f5f1a97aee4164f",
  "g/s3/mosaic/images/widgets/badge-light-logo.svg": "07462456d3ec3b080c339f161af20470060a66e5c3bf1f2b6fe9e71acc2972ed",
  "g/s3/mosaic/images/widgets/badge-small-dark.svg": "ea9ce36374e267e275595a070ac52b121c8a658b4f8b156f3f8a4ea72335ae69",
  "g/s3/mosaic/images/widgets/checkbox.svg": "f336cfd2c038c5640d625324fb430c71b0761ab0841ec1cbbfc58a6135e62c57",
  "g/s3/mosaic/images/widgets/menu-close.svg": "480d8818fca2cccfd9dd61f33ee3a98ea5bfc893336850a598e836a53865fca3",
  "g/s3/mosaic/images/widgets/menu-arrow-right.svg": "ea12124cfba7d5af4f08e430fd88a730b80c58474eb2df641a1033ad31054b5b",
  "g/s3/mosaic/images/widgets/badge-small-light.svg": "b2734ed5bfa6dee18ca1b7a46877503dbe05364f716131e7a647d4c947d59f29",
  "g/s3/mosaic/images/widgets/collection-pagination-right.svg": "da779a3922f58d71a25e0c92f2a82db1656fd267e28149a9d688294ef07df2f6",
  "g/s3/mosaic/images/widgets/collection-arrow-right.svg": "621102d25536bc707f1004ebee91bd784f1b34317edbda9d7931f8de6c5b0040",
  "g/s3/mosaic/images/widgets/page-404.svg": "e4f3fda2d8b705efc8cccad09558ef02069165ea288be90f14ebcfa7ec473bd2",
  "g/s3/mosaic/images/widgets/badge-dark-logo.svg": "42636d255f900d26c1f49009b30924ddfd608da221de094416981f5022488967",
  "g/s3/mosaic/images/widgets/collection-arrow-left.svg": "ec778199fa097abd7647a3e2709976949dec91e99879ecf8247fc1866a97c269",
  "g/s3/mosaic/css/constructor/redesign/tt_default_styles.css": "9e7d89d35f64e6df3e2780d52d2c9a08ac27da15dfca2f82f635989b48ceb350"
};
test('neighboring non-JS assets retain their original bytes', async () => {
  const { createHash } = await import('node:crypto');
  for (const [file, hash] of Object.entries(preserved)) {
    assert.equal(createHash('sha256').update(await readFile(join(publicRoot, file))).digest('hex'), hash, file);
  }
});

test('fresh offline preview and production artifacts exclude every removed platform asset', async () => {
  const { isolatedWorkspace } = await import('../../scripts/offline-suite-isolated-workspace.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const workspace = await isolatedWorkspace(resolve(import.meta.dirname, '../..'));
  try {
    const deny = join(workspace.directory, 'deny-orphan-build.mjs');
    await writeFile(deny, "globalThis.fetch=()=>{throw new Error('Build network forbidden')};\n");
    for (const mode of ['preview', 'production']) {
      await run(process.execPath, ['--import', deny, 'storefront/build.mjs', `--mode=${mode}`], { cwd: workspace.directory, timeout: 120000, maxBuffer: 1024*1024 });
      const target = join(workspace.directory, 'storefront', mode === 'preview' ? 'dist' : 'production/dist');
      for (const file of removed) await assert.rejects(stat(join(target, file)), { code: 'ENOENT' });
      for (const file of await readdir(target, { recursive: true })) {
        if (!/\.(?:html|css|js)$/.test(file)) continue;
        const content = await readFile(join(target, file), 'utf8');
        for (const capture of removed) assert.ok(!content.includes(`/${capture}`), `${mode}/${file} consumes ${capture}`);
      }
      console.log(`${mode}: 48 removed asset paths absent; HTML/CSS/JS consumers absent`);
    }
  } finally { await workspace.cleanup(); }
});
