import test from 'node:test';
import assert from 'node:assert/strict';
import {exportPromoCSV,promoUsage,promoColumns} from '../server/promos.mjs';
import {validatePromo,promoStatus,promoTotal,normalizeCode,GIFT_TEXT} from '../public/js/promo-model.js';
import {parseCSV} from '../../src/catalog/utils.js';

// Разбор промокодов так, как это делает действующий скрипт сайта (src/catalog/index.js, PROMO v4-lite).
function siteReadsPromos(csv){
 const rows=parseCSV(csv),head=rows.shift().map(h=>String(h||'').trim().toLowerCase());
 const col=names=>{for(const n of names){const i=head.indexOf(n);if(i>=0)return i;}return -1;};
 const iCode=col(['promocode','promo','code','код','промокод','прмокод']),iRub=col(['ruble-offer','ruble','rub-off','rub','скидка в рублях','руб','рубли']),
  iPct=col(['percent-offer','percent','pct','%','скидка в %','процент','проценты']),iGift=col(['gift-offer','gift','gift_offer','подарок']);
 assert.ok(iCode>=0&&iRub>=0&&iPct>=0&&iGift>=0,'скрипт сайта должен найти все четыре колонки');
 const toNum=s=>Number(String(s||'').replace(',','.').replace(/[^\d.-]/g,''));
 const out={};
 for(const row of rows){
  const code=normalizeCode(row[iCode]||'');if(!code)continue;
  out[code]={rub:toNum(row[iRub]),pct:toNum(row[iPct]),gift:/сумк/i.test(String(row[iGift]||'').trim())};
 }
 return out;
}
const promo=over=>validatePromo({code:'NEW',rub:1000,...over});

test('CSV читается действующим скриптом сайта без изменений',()=>{
 const csv=exportPromoCSV([promo({code:'Сахалин',comment:'Эрик, "свой" код, 1000'}),promo({code:'bravo',rub:0,pct:5.5}),promo({code:'2026',rub:0,gift:true})]);
 assert.equal(parseCSV(csv)[0].join(','),promoColumns.join(','));
 const list=siteReadsPromos(csv);
 assert.deepEqual(list['сахалин'],{rub:1000,pct:0,gift:false});
 assert.deepEqual(list['bravo'],{rub:0,pct:5.5,gift:false});
 assert.deepEqual(list['2026'],{rub:0,pct:0,gift:true});
 assert.ok(csv.includes(GIFT_TEXT));
});
test('в CSV попадают только включённые промокоды',()=>{
 const codes=[promo({code:'live'}),promo({code:'off',active:false}),promo({code:'gift-only',rub:0,gift:true})];
 assert.deepEqual(Object.keys(siteReadsPromos(exportPromoCSV(codes))).sort(),['gift-only','live']);
 assert.deepEqual(codes.map(promoStatus),['live','off','live']);
});
test('скидка считается как на сайте: рубли важнее процентов и не уходит ниже нуля',()=>{
 assert.equal(promoTotal({rub:1000,pct:0},20000),19000);
 assert.equal(promoTotal({rub:0,pct:5},20001),19001);
 assert.equal(promoTotal({rub:14883,pct:0},10000),0);
 assert.equal(promoTotal({rub:0,pct:0,gift:true},20000),20000);
});
test('регистр, «ё» и пробелы в промокоде не различаются',()=>{
 assert.equal(normalizeCode(' ЁЛКА '),normalizeCode('елка'));
 assert.equal(normalizeCode('Home'),'home');
});
test('неверные промокоды отклоняются с понятной ошибкой',()=>{
 const cases=[{code:''},{code:'a'.repeat(41)},{code:'код с пробелом'},{code:'код,с,запятой'},
  {code:'ok',rub:1000,pct:5},{code:'ok',rub:0,pct:0,gift:false},{code:'ok',rub:-5},{code:'ok',rub:1.5},
  {code:'ok',rub:0,pct:100}];
 for(const input of cases) assert.throws(()=>validatePromo({rub:0,pct:0,...input}),/.+/,JSON.stringify(input));
 assert.deepEqual(validatePromo({code:'  NEW  ',rub:'1000',pct:'',comment:' Отец '}),{code:'NEW',comment:'Отец',rub:1000,pct:0,gift:false,active:true});
});
test('счётчик использований берёт код из описания оплаченного заказа',()=>{
 const usage=promoUsage([
  {description:'Миранда 230 см (Зелёная) — 44299 ₽ | Адрес: … | Связь: Telegram | Промо: Home',amount:43299,created_at:'2026-09-03T07:26:08Z'},
  {description:'Ёлка | Промо: home | Скидка по промокоду: 1000 ₽',amount:10000,created_at:'2026-09-05T07:26:08Z'},
  {description:'Ёлка без промокода',amount:5000,created_at:'2026-09-06T07:26:08Z'},
  {description:'Ёлка | Промо: HappY',amount:7000,created_at:'2026-09-01T07:26:08Z'}]);
 assert.deepEqual(usage.get('home'),{orders:2,amount:53299,last:'2026-09-05T07:26:08Z'});
 assert.equal(usage.get('happy').orders,1);
 assert.equal(usage.size,2);
});
