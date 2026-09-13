import {normalizeCode,isLive,GIFT_TEXT} from '../public/js/promo-model.js';
// Колонки повторяют лист Google Таблицы: действующий скрипт сайта читает их без изменений.
export const promoColumns=['promocode','Комментарий','ruble-offer','percent-offer','gift-offer'];
const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
// В CSV попадают только включённые коды: выключенный промокод сайт просто не найдёт.
export function exportPromoCSV(promos){
 const rows=promos.filter(isLive).map(p=>[p.code,p.comment,p.rub||0,p.pct||0,p.gift?GIFT_TEXT:''].map(cell).join(','));
 return [promoColumns.map(cell).join(','),...rows].join('\r\n')+'\r\n';
}
// Статистика берётся из оплаченных заказов: код записан в описание как «| Промо: КОД».
export function promoUsage(orders=[]){
 const stats=new Map();
 for(const order of orders){
  const code=String(order.description||'').match(/\|\s*Промо:\s*([^|]+)/)?.[1];
  if(!code) continue;
  const key=normalizeCode(code);if(!key) continue;
  const stat=stats.get(key)||{orders:0,amount:0,last:null};
  stat.orders++;stat.amount+=Number(order.amount)||0;
  if(!stat.last||order.created_at>stat.last) stat.last=order.created_at;
  stats.set(key,stat);
 }
 return stats;
}
