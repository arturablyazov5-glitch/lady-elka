// Сборка фронтенда каталога для Taptop.
// Берёт модули из src/ и собирает в ОДИН файл dist/catalog.js (+ dist/catalog.css),
// которые ты вручную загружаешь на Taptop как раньше.
//
//   npm run build    — собрать один раз
//   npm run watch    — пересобирать при каждом сохранении
//
// Формат IIFE: весь код каталога живёт в изолированной области,
// наружу (для других скриптов на Taptop) выставляются только window.* (norm, getCart, ...).

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const jsOptions = {
  entryPoints: ['src/catalog/index.js'],
  bundle: true,
  format: 'iife',
  target: ['es2019'],
  outfile: 'dist/catalog.js',
  charset: 'utf8',      // важно: в коде кириллица
  legalComments: 'none',
  logLevel: 'info',
};

const cssOptions = {
  entryPoints: ['src/styles/catalog.css'],
  bundle: true,
  outfile: 'dist/catalog.css',
  charset: 'utf8',
  logLevel: 'info',
};

if (watch) {
  const jsCtx = await esbuild.context(jsOptions);
  const cssCtx = await esbuild.context(cssOptions);
  await jsCtx.watch();
  await cssCtx.watch();
  console.log('👀 watch: пересобираю при изменениях в src/. Ctrl+C для выхода.');
} else {
  await esbuild.build(jsOptions);
  await esbuild.build(cssOptions);
  console.log('✅ Собрано: dist/catalog.js + dist/catalog.css');
}
