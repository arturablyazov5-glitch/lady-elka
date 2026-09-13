import fs from 'node:fs/promises';
import {SHEET_CSV_URL,DECOR_SHEET_CSV_URL} from '../../src/catalog/config.js';
import {importCSV,validateProduct} from '../server/catalog.mjs';
import {db} from '../server/db.mjs';
const existing=await db('le_catalog_products?select=id&limit=1');
if(existing.length) throw new Error('Каталог уже заполнен. Импорт остановлен, чтобы сохранить правки.');
const products=[]; const report={imported_at:new Date().toISOString(),sources:[]};
for(const [kind,url] of [['trees',SHEET_CSV_URL],['decor',DECOR_SHEET_CSV_URL]]) {
  const res=await fetch(url); if(!res.ok) throw new Error(`Google Sheets: ${res.status}`);
  const csv=await res.text(); const parsed=importCSV(csv,kind);
  await fs.writeFile(new URL(`../data/source-${kind}.csv`,import.meta.url),csv);
  parsed.products.forEach(validateProduct); products.push(...parsed.products);
  report.sources.push({kind,url,products:parsed.products.length,variants:parsed.products.reduce((n,p)=>n+p.variants.length,0),skipped:parsed.skipped});
}
await db('le_catalog_products',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify(products.map(p=>({id:p.id,payload:p})))});
await fs.writeFile(new URL('../data/import-report.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
