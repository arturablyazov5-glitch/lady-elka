// Однократный перенос промокодов из листа Google Таблицы в сервис.
//   node app/scripts/import-promos.mjs            — показать, что будет добавлено
//   node app/scripts/import-promos.mjs --apply    — записать в Supabase
import {db,listPromos} from '../server/db.mjs';
import {parseCSV} from '../../src/catalog/utils.js';
import {validatePromo,normalizeCode,GIFT_TEXT} from '../public/js/promo-model.js';

const SOURCE='https://docs.google.com/spreadsheets/d/e/2PACX-1vQBYDczXmGsnVqSrCuzjsMwz6-DZu3Q6pSjb66YUkgPxxt7UDecZLll9QZFHU0BHhKc3GMZ4xFoouXB/pub?gid=301234033&single=true&output=csv';
const apply=process.argv.includes('--apply');
// Таблица хранит суммы как «1 000,00 ₽» — забираем только число, как это делает скрипт сайта.
const num=s=>Number(String(s||'').replace(',','.').replace(/[^\d.-]/g,''))||0;

const csv=await (await fetch(process.argv.find(a=>a.startsWith('--url='))?.slice(6)||SOURCE,{signal:AbortSignal.timeout(30000)})).text();
const rows=parseCSV(csv);
const head=rows.shift().map(h=>String(h||'').trim().toLowerCase());
const col=names=>names.map(n=>head.indexOf(n)).find(i=>i>=0)??-1;
const iCode=col(['promocode','promo','code','код','промокод']),iComment=col(['комментарий','comment']),
 iRub=col(['ruble-offer','rub','скидка в рублях']),iPct=col(['percent-offer','percent','скидка в %']),iGift=col(['gift-offer','gift','подарок']);
if(iCode<0) throw new Error('В источнике нет колонки с промокодом');

const existing=new Set((await listPromos()).map(p=>normalizeCode(p.code)));
const seen=new Set(),ready=[],skipped=[];
for(const row of rows){
 const code=String(row[iCode]||'').trim();
 // Пустые строки и вторая строка-подсказка листа переносить не нужно.
 if(!code || /^текст промокода$/i.test(code)) continue;
 const key=normalizeCode(code);
 if(existing.has(key)||seen.has(key)){skipped.push([code,'уже есть']);continue;}
 const gift=/сумк/i.test(String(row[iGift]||''));
 try{
  ready.push(validatePromo({code,comment:String(row[iComment]||'').trim(),rub:Math.round(num(row[iRub])),pct:num(row[iPct]),gift}));
  seen.add(key);
 }catch(e){skipped.push([code,e.message]);}
}
for(const p of ready) console.log(`+ ${p.code.padEnd(14)} ${p.rub?p.rub+' ₽':p.pct?p.pct+'%':''} ${p.gift?GIFT_TEXT:''} ${p.comment}`);
for(const [code,why] of skipped) console.log(`· ${code.padEnd(14)} пропущен: ${why}`);
console.log(`\nГотово к переносу: ${ready.length}, пропущено: ${skipped.length}`);
if(!apply) {console.log('Это предпросмотр. Повторите с --apply, чтобы записать.');process.exit(0);}
if(ready.length) await db('le_promo_codes',{method:'POST',body:JSON.stringify(ready)});
console.log(`Записано промокодов: ${ready.length}`);
