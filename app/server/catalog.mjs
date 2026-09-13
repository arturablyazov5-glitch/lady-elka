import { parseCSV, num } from '../../src/catalog/utils.js';
export const columns = {
  trees: ['id','title','category','height_cm','price','diameter_cm','branches','offer','discount_pct','photos','active','description'],
  decor: ['id','title','category','price','variants','photos','active','description']
};
export const isActive = v => /^(1|true|t|да|yes|y|on|ok|✓|истина)$/i.test(String(v).trim());
export function importCSV(csv, kind) {
  const rows = parseCSV(csv); const headers = rows.shift().map(h => h.trim());
  for (const key of ['id','title','price',...(kind === 'trees' ? ['category','height_cm'] : [])]) if (!headers.includes(key)) throw new Error(`Нет колонки ${key}`);
  const groups = new Map(); let skipped = 0;
  for (const [index, cells] of rows.entries()) {
    const row = Object.fromEntries(headers.filter(Boolean).map(h => [h,cells[headers.indexOf(h)] || '']));
    if (!row.id.trim() || !row.title.trim() || !num(row.price) || (kind === 'trees' && (!row.category.trim() || !num(row.height_cm)))) { skipped++; continue; }
    const id = row.id.trim();
    if (!groups.has(id)) groups.set(id,{id: `${kind}:${id}`, kind, sku:id, title:row.title.trim(), variants:[]});
    groups.get(id).variants.push({key:`${kind}-${index+2}`,category:row.category?.trim() || '',height_cm:num(row.height_cm),price:num(row.price),diameter_cm:num(row.diameter_cm),branches:num(row.branches),offer:num(row.offer),discount_pct:num(row.discount_pct),description:row.description || '',photos:(row.photos || '').split('|').map(s=>s.trim()).filter(Boolean),active:isActive(row.active),variants:row.variants || '',source_price:num(row['Цена из файла']),source_row:index+2});
  }
  return {products:[...groups.values()], skipped};
}
export function validateProduct(p) {
  if (!p || !['trees','decor'].includes(p.kind) || typeof p.sku !== 'string' || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(p.sku) || p.id !== `${p.kind}:${p.sku}`) throw new Error('Укажите корректный артикул');
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length>200) throw new Error('Укажите название товара');
  if (!Array.isArray(p.variants) || !p.variants.length || p.variants.length>200) throw new Error('Добавьте хотя бы один вариант');
  const keys=new Set();
  for (const v of p.variants) {
    if (typeof v.key!=='string' || keys.has(v.key)) throw new Error('Повторяющийся вариант'); keys.add(v.key);
    for(const key of ['price','height_cm','diameter_cm','branches','offer','source_price']) if(!Number.isFinite(v[key]) || v[key]<0 || v[key]>1e9) throw new Error('Проверьте цены и размеры: нужны положительные числа');
    if(v.price<=0 || (p.kind==='trees' && (v.height_cm<=0 || typeof v.category!=='string' || !v.category.trim()))) throw new Error('У каждого варианта должны быть цена, высота и комплектация');
    if(!Number.isFinite(v.discount_pct) || Math.abs(v.discount_pct)>=100) throw new Error('Скидка должна быть меньше 100%');
    if(typeof v.active!=='boolean' || typeof v.description!=='string' || v.description.length>20000 || typeof v.variants!=='string' || v.variants.length>200) throw new Error('Некорректные данные варианта');
    if(!Array.isArray(v.photos) || v.photos.length>50 || v.photos.some(url=>{try {return !['http:','https:'].includes(new URL(url).protocol);}catch{return true;}})) throw new Error('Для фотографий нужны ссылки http или https');
  }
  return p;
}
const cell = value => '"'+String(value ?? '').replaceAll('"','""')+'"';
export function exportCSV(products, kind) {
  const headers = columns[kind];
  return [headers.map(cell).join(','),...products.filter(p=>p.kind===kind).flatMap(p=>p.variants.map(v=>headers.map(h=>cell(h==='id'?p.sku:h==='title'?p.title:h==='active'?(v.active?'TRUE':'FALSE'):h==='photos'?v.photos.join(' | '):v[h])).join(',')))].join('\r\n')+'\r\n';
}
