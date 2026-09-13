// Декор всегда в одной группе «Без типа» — у него нет вкладок-категорий, только список
// размеров/вариантов. Категории (Зелёная/С освещением/Заснеженная и т.п.) — только у ёлок/туй,
// и оба режима группировки на одном товаре одновременно быть не могут.
export const groupName = (p,v) => p.kind==='decor'?'Без типа':v.category;
// Русское склонение по числительному: 1 размер, 2 размера, 5 размеров.
export function pluralRu(n,[one,few,many]){
 const mod10=n%10,mod100=n%100;
 if(mod10===1 && mod100!==11) return one;
 if(mod10>=2 && mod10<=4 && (mod100<12 || mod100>14)) return few;
 return many;
}
export const sizeWord = n => pluralRu(n,['размер','размера','размеров']);
export const variantWord = n => pluralRu(n,['вариант','варианта','вариантов']);
export const parsePriceInput = value => {
 const normalized=String(value??'').replace(/[^\d,.-]/g,'').replace(',','.');
 const number=Number(normalized);
 return Number.isFinite(number)?number:0;
};
export const formatPriceInput = value => {
 const number=parsePriceInput(value);
 return number>0?`${Math.round(number).toLocaleString('ru-RU')} ₽`:'';
};
export const parseUnitInput = value => parsePriceInput(value);
export const formatUnitInput = value => {
 const number=parseUnitInput(value);
 return number>0?`${number.toLocaleString('ru-RU')} см`:'';
};
export const parseCountInput = value => Math.max(0,Math.round(parsePriceInput(value)));
export const formatCountInput = value => {
 const number=parseCountInput(value);
 return number>0?`${number.toLocaleString('ru-RU')} шт`:'';
};
export const getGroups = p => [...new Set(p.variants.map(v=>groupName(p,v)))];
export const groupVariants = (p,name) => p.variants.filter(v=>groupName(p,v)===name);
export const sharedContent = vs => vs.every(v=>v.description===vs[0].description && JSON.stringify(v.photos)===JSON.stringify(vs[0].photos));
export function setContent(vs, key, value) { for(const v of vs) v[key]=Array.isArray(value)?[...value]:value; }
export function checkDraft(p){
 if(!p.title.trim())return {message:'Введите название товара',field:'title'};
 if(!/^[\p{L}\p{N}_.-]{1,80}$/u.test(p.sku))return {message:'Укажите артикул: буквы, цифры, точка, дефис или подчёркивание',field:'sku'};
 for(const v of p.variants){
  for(const k of ['base_price','height_cm','diameter_cm','branches','source_price','offer']) if(!Number.isFinite(v[k])||v[k]<0||v[k]>1e9)return {message:'Введите число от 0 до 1 000 000 000',key:v.key,field:k};
  if(!Number.isFinite(v.base_price)||v.base_price<=0)return {message:'Укажите базовую цену больше нуля',key:v.key,field:'base_price'};
  if(p.kind==='trees' && v.height_cm<=0)return {message:'Укажите высоту больше нуля',key:v.key,field:'height_cm'};
  if(!Number.isFinite(v.discount_pct)||Math.abs(v.discount_pct)>=100)return {message:'Скидка должна быть от 0 до 99%',key:v.key,field:'discount_pct'};
 }
 return null;
}
export function parsePhotoLinks(text){
 const urls=text.split(/[\s|]+/).map(s=>s.trim()).filter(Boolean);
 if(!urls.length)throw new Error('Вставьте ссылку на фотографию');
 if(urls.some(s=>{try{return !['https:','http:'].includes(new URL(s).protocol);}catch{return true;}}))throw new Error('Нужна полная ссылка, начинающаяся с https:// или http://');
 return [...new Set(urls)];
}
