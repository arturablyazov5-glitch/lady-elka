import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Emits an apply_patch patch; never rebuilds the mixed working-tree sources.
const baseline = await readFile('/tmp/lady-elka-live-catalog-20261009.js', 'utf8');
const snapshot = 'storefront/catalog-snapshots/2026-10-08T04-59-43-880Z';
const manifest = JSON.parse(await readFile(`${snapshot}/manifest.json`, 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
if (sha(baseline) !== '7c314fb4a9fa187c44d34fa1ba78a804bc09c0537235015d63ad6410d8f9070f') throw Error('Published bundle changed; review required');
let bundle = baseline;
const edits = [];
for (const [name, expression] of [
  ['trees', 'fetch(SHEET_CSV_URL, { cache })'],
  ['decor', 'fetch(DECOR_SHEET_CSV_URL, { cache })'],
  ['promos', 'fetch(PROMO_SHEET_CSV_URL, { cache: "no-store" })'],
]) {
  const csv = await readFile(`${snapshot}/${name}.csv`, 'utf8');
  if (sha(csv) !== manifest.feeds[name].sha256) throw Error(`Snapshot checksum mismatch: ${name}`);
  if (bundle.split(expression).length !== 2) throw Error(`Unexpected fetch count: ${name}`);
  const replacement = `Promise.resolve({ text: () => Promise.resolve(${JSON.stringify(csv)}) })`;
  bundle = bundle.replace(expression, replacement);
  edits.push({name, before: expression, after: replacement, sha256: sha(csv), records: manifest.feeds[name].records});
}
const root = 'release-candidates/legacy-static-prices';
const files = {
  'catalog-snapshot-20261008.js': bundle,
  'catalog-rollback.js': baseline,
  'manifest.json': JSON.stringify({snapshot, baselineSHA256: sha(baseline), candidateSHA256: sha(bundle), changes: edits.map(({after, ...edit}) => edit)}, null, 2) + '\n',
  'INSTALL.md': '# Статические цены старого сайта\n\nСнапшот от 08.10.2026: 248 вариантов ёлок/туй, 9 позиций декора, 10 промокодов. CSV встроены в JS. Запросы трёх CSV заменены локальными ответами; остальной код опубликованного catalog.js сохранён. Цены и наличие зафиксированы на дату снапшота.\n\n1. Загрузить catalog-snapshot-20261008.js в ресурсы старого проекта Lady Elka в Taptop.\n2. В существующем подключении заменить /f/catalog.js?v=11 на URL загруженного файла (обычно /f/catalog-snapshot-20261008.js; взять фактический URL из ресурсов). Сохранить остальные атрибуты script. Заменить подключение, не добавлять второй скрипт.\n3. Проверить подключение на главной, каталогах, страницах товаров и декора; опубликовать нужные страницы.\n4. В приватном окне проверить цены, выбор высоты/категории, декор, корзину и промокод. Не отправлять тестовый платёж.\n\nНовое имя обходит годовой кеш старого JS. Отдельно CSV загружать не нужно. Фотографии и оплата всё ещё могут обращаться к Supabase; этот комплект отключает только получение цен/наличия/промокодов из CSV.\n\nОткат: загрузить catalog-rollback.js и заменить подключение на его фактический новый URL. Не возвращать уже закешированный URL.\n'
};
console.log('*** Begin Patch\n' + Object.entries(files).map(([name, body]) => `*** Add File: ${root}/${name}\n` + body.split('\n').map(line => '+' + line).join('\n')).join('\n') + '\n*** End Patch');
