export const DEFAULT_SETTINGS={discount_pct:30,adjustment_pct:0,types:[{id:'green',name:'Зелёная',aliases:['Зелёная']},{id:'lights',name:'С освещением',aliases:['С освещением']},{id:'snow',name:'Заснеженная',aliases:['Заснеженная']},{id:'snow-lights',name:'Заснеженная с освещением',aliases:['Заснеженная с освещением']},{id:'thuja',name:'Туя',aliases:['Туя']}]};
export function calculatePrice(base,settings){
 const price=Math.round((base*(100+settings.adjustment_pct))/100);
 return {price,offer:settings.discount_pct?Math.ceil(price*100/(100-settings.discount_pct)):0,discount_pct:-settings.discount_pct};
}
export function resolveType(v,settings){return settings.types.find(t=>t.id===v.type_id)||settings.types.find(t=>t.name===v.category||t.aliases?.includes(v.category));}
export function pricedProduct(p,settings){return {...p,variants:p.variants.map(v=>{
 const base=v.base_price??v.price;
 const type=p.kind==='trees'?resolveType(v,settings):null;
 return {...v,base_price:base,...calculatePrice(base,settings),...(type?{type_id:type.id,category:type.name}:{})};
})};}
export function validateSettings(s){
 if(!s||!Number.isFinite(s.discount_pct)||s.discount_pct<0||s.discount_pct>=100)throw new Error('Скидка должна быть от 0 до 99%');
 if(!Number.isFinite(s.adjustment_pct)||s.adjustment_pct<=-100||s.adjustment_pct>1000)throw new Error('Изменение цены должно быть больше −100% и не больше +1000%');
 if(!Array.isArray(s.types)||!s.types.length||s.types.length>100)throw new Error('Добавьте хотя бы один тип товара');
 const names=new Set(),ids=new Set();for(const t of s.types){if(!t||typeof t.id!=='string'||!/^[a-z0-9-]{1,80}$/.test(t.id)||typeof t.name!=='string'||!t.name.trim()||t.name.length>100)throw new Error('Проверьте название типа');const name=t.name.trim().toLowerCase().replaceAll('ё','е');if(names.has(name)||ids.has(t.id))throw new Error('Названия типов не должны повторяться');names.add(name);ids.add(t.id);}
 return s;
}
