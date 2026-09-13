// Осторожная синхронизация Google Sheets -> Supabase.
// Не удаляет товары/варианты, не заменяет существующие фото и описания.
// По умолчанию только показывает план; для записи нужен --apply.
import {importCSV, validateProduct} from '../server/catalog.mjs';
import {db, listProducts, listPromos} from '../server/db.mjs';
import {parseCSV} from '../../src/catalog/utils.js';
import {normalizeCode, validatePromo} from '../public/js/promo-model.js';

const SHEETS = {
  trees: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQBYDczXmGsnVqSrCuzjsMwz6-DZu3Q6pSjb66YUkgPxxt7UDecZLll9QZFHU0BHhKc3GMZ4xFoouXB/pub?gid=0&single=true&output=csv',
  decor: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQBYDczXmGsnVqSrCuzjsMwz6-DZu3Q6pSjb66YUkgPxxt7UDecZLll9QZFHU0BHhKc3GMZ4xFoouXB/pub?gid=500105078&single=true&output=csv',
  promos: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQBYDczXmGsnVqSrCuzjsMwz6-DZu3Q6pSjb66YUkgPxxt7UDecZLll9QZFHU0BHhKc3GMZ4xFoouXB/pub?gid=301234033&single=true&output=csv',
};
const apply = process.argv.includes('--apply');
const variantKey = (product, variant) => product.kind === 'trees' ? `${variant.category}|${variant.height_cm}` : String(variant.variants || '');
const sourceNumber = value => Number(String(value || '').replace(',','.').replace(/[^\d.-]/g,'')) || 0;

async function fetchText(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`Google Sheets: ${response.status}`);
  return response.text();
}

function parsePromos(csv) {
  const rows = parseCSV(csv), headers = rows.shift().map(value => String(value || '').trim().toLowerCase());
  const column = names => names.map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1;
  const [codeIndex, commentIndex, rubIndex, pctIndex, giftIndex] = [
    ['promocode','promo','code','код','промокод'], ['комментарий','comment'], ['ruble-offer','rub','скидка в рублях'],
    ['percent-offer','percent','скидка в %'], ['gift-offer','gift','подарок'],
  ].map(column);
  if (codeIndex < 0) throw new Error('В таблице нет колонки промокода');
  return rows.flatMap(row => {
    const code = String(row[codeIndex] || '').trim();
    if (!code || /^текст промокода$/i.test(code)) return [];
    try {
      return [validatePromo({code, comment: String(row[commentIndex] || '').trim(), rub: Math.round(sourceNumber(row[rubIndex])), pct: sourceNumber(row[pctIndex]), gift: /сумк/i.test(String(row[giftIndex] || ''))})];
    } catch { return []; }
  });
}

const [treesCsv, decorCsv, promosCsv, databaseProducts, databasePromos] = await Promise.all([
  fetchText(SHEETS.trees), fetchText(SHEETS.decor), fetchText(SHEETS.promos), listProducts(), listPromos(),
]);
const sheetProducts = [...importCSV(treesCsv, 'trees').products, ...importCSV(decorCsv, 'decor').products];
const databaseById = new Map(databaseProducts.map(product => [product.id, product]));
const productUpdates = [], priceChanges = [], newVariants = [];

for (const sheetProduct of sheetProducts) {
  const existing = databaseById.get(sheetProduct.id);
  // Новых товаров в этой синхронизации не создаём: это требует отдельной проверки карточки и фотографий.
  if (!existing) continue;
  const sheetByVariant = new Map(sheetProduct.variants.map(variant => [variantKey(sheetProduct, variant), variant]));
  let changed = false;
  const variants = existing.variants.map(existingVariant => {
    const sheetVariant = sheetByVariant.get(variantKey(existing, existingVariant));
    if (!sheetVariant) return existingVariant;
    const nextBase = Number(sheetVariant.base_price ?? sheetVariant.price);
    const currentBase = Number(existingVariant.base_price ?? existingVariant.price);
    const nextActive = !!sheetVariant.active;
    if (currentBase === nextBase && !!existingVariant.active === nextActive) return existingVariant;
    changed = true;
    if (currentBase !== nextBase) priceChanges.push({id: existing.id, variant: variantKey(existing, existingVariant), from: currentBase, to: nextBase});
    // Копируем только цену и показ на сайте. Фото, описание, название, тип и характеристики остаются из БД.
    return {...existingVariant, base_price: nextBase, price: nextBase, active: nextActive};
  });
  for (const [key, sheetVariant] of sheetByVariant) {
    if (existing.variants.some(variant => variantKey(existing, variant) === key)) continue;
    changed = true;
    // Это именно новый размер: берём его данные из таблицы, не затрагивая ни один существующий вариант.
    variants.push({...sheetVariant, base_price: Number(sheetVariant.base_price ?? sheetVariant.price)});
    newVariants.push({id: existing.id, variant: key, photoCount: sheetVariant.photos.length});
  }
  if (changed) {
    const payload = {...existing, variants};
    validateProduct(payload);
    productUpdates.push({id: existing.id, revision: existing.revision, payload});
  }
}

const databasePromoByCode = new Map(databasePromos.map(promo => [normalizeCode(promo.code), promo]));
const promoAdds = [], promoUpdates = [];
for (const sheetPromo of parsePromos(promosCsv)) {
  const existing = databasePromoByCode.get(normalizeCode(sheetPromo.code));
  if (!existing) { promoAdds.push(sheetPromo); continue; }
  // Активность сохраняем из БД: в таблице нет безопасного поля для выключенного вручную кода.
  const desired = {...sheetPromo, active: existing.active};
  if (['code','comment','rub','pct','gift','active'].some(key => String(existing[key]) !== String(desired[key]))) promoUpdates.push({id: existing.id, revision: existing.revision, payload: desired});
}

const plan = {products: {updates: productUpdates.length, priceChanges, newVariants}, promos: {add: promoAdds.map(p => p.code), update: promoUpdates.map(p => p.payload.code)}, protects: ['Не удаляет товары или варианты', 'Не меняет фото и описания существующих вариантов', 'Не удаляет и не выключает промокоды, которых нет в таблице']};
console.log(JSON.stringify(plan, null, 2));
if (!apply) {
  console.log('\nЭто предпросмотр. Для аккуратной записи: node app/scripts/sync-google-catalog.mjs --apply');
  process.exit(0);
}

for (const update of productUpdates) {
  const rows = await db(`le_catalog_products?id=eq.${encodeURIComponent(update.id)}&revision=eq.${update.revision}`, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify({payload: update.payload, revision: update.revision + 1, updated_at: new Date().toISOString()})});
  if (!rows.length) throw new Error(`Товар ${update.id} изменился параллельно — синхронизация остановлена`);
}
for (const promo of promoAdds) await db('le_promo_codes', {method: 'POST', body: JSON.stringify(promo)});
for (const update of promoUpdates) {
  const rows = await db(`le_promo_codes?id=eq.${update.id}&revision=eq.${update.revision}`, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify({...update.payload, revision: update.revision + 1, updated_at: new Date().toISOString()})});
  if (!rows.length) throw new Error(`Промокод ${update.payload.code} изменился параллельно — синхронизация остановлена`);
}
console.log(`\nСинхронизация завершена: товаров ${productUpdates.length}, новых вариантов ${newVariants.length}, промокодов добавлено ${promoAdds.length}, обновлено ${promoUpdates.length}.`);
