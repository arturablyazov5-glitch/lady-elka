import {calculatePrice,validateSettings} from './pricing.js';
let state=null,changed=false,pending=false;
const settingsForm=$('#settings-form');for(const id of ['price-adjustment','site-discount','new-type','reset-settings'])$('#'+id).disabled=true;
function message(s,error=false){$('#settings-feedback').textContent=s;$('#settings-feedback').classList.toggle('error',error);}
function renderSettings(){if(!catalogSettings||changed)return;state=structuredClone(catalogSettings);for(const id of ['price-adjustment','site-discount','new-type','reset-settings'])$('#'+id).disabled=false;$('#price-adjustment').value=state.adjustment_pct;$('#site-discount').value=state.discount_pct;renderTypes();preview();$('#save-settings').disabled=true;message('Все изменения сохранены');}
function usedCount(id){return products.filter(p=>p.variants.some(v=>v.type_id===id)).length;}
function renderTypes(){
 $('#types-list').innerHTML=state.types.map(t=>`<div class="type-setting" data-type="${esc(t.id)}"><label class="field"><span>Название типа</span><input data-type-name value="${esc(t.name)}" maxlength="100" required aria-label="Название типа ${esc(t.name)}"></label><span class="type-usage">${usedCount(t.id)?`Товаров: ${usedCount(t.id)}`:'Не используется'}</span><button type="button" class="icon-btn" data-delete-type="${esc(t.id)}" ${usedCount(t.id)||state.types.length===1?'disabled':''} aria-label="Удалить тип ${esc(t.name)}" title="${usedCount(t.id)?'Этот тип используется в товарах':'Удалить тип'}">${pict('trash')}</button></div>`).join('');
}
function preview(){
 const base=10000;const {price,offer}=calculatePrice(base,state);
 const adjustment=Number.isFinite(state.adjustment_pct)?state.adjustment_pct:0,discount=Number.isFinite(state.discount_pct)?state.discount_pct:0;
 $('#price-preview').innerHTML=`<div class="price-preview-grid"><div class="preview-base-group"><span><small>Базовая цена</small><strong>${rub(base)}</strong></span><span class="preview-sign">${adjustment>=0?'+':''}${adjustment}%</span></div><div class="preview-site"><small>Цена на сайте</small><div class="preview-site-main"><strong>${Number.isFinite(price)?rub(price):'—'}</strong>${discount>0?`<span class="preview-discount">-${discount}%</span>`:''}</div><del>${offer&&Number.isFinite(offer)?rub(offer):'—'}</del></div></div>`;
}
function dirtySettings(){changed=true;$('#save-settings').disabled=false;message('Настройки изменятся для всего каталога после сохранения');}
settingsForm.addEventListener('input',e=>{if(!state||pending)return;if(e.target.name){state[e.target.name]=e.target.value===''?NaN:Number(e.target.value);preview();}else if(e.target.matches('[data-type-name]')){state.types.find(t=>t.id===e.target.closest('[data-type]').dataset.type).name=e.target.value;}else return;dirtySettings();});
$('#new-type').addEventListener('click',()=>{state.types.push({id:crypto.randomUUID(),name:'',aliases:[]});renderTypes();dirtySettings();$('#types-list .type-setting:last-child input').focus();});
$('#types-list').addEventListener('click',e=>{const b=e.target.closest('[data-delete-type]');if(b&&!b.disabled){state.types=state.types.filter(t=>t.id!==b.dataset.deleteType);renderTypes();dirtySettings();}});
$('#reset-settings').addEventListener('click',()=>{changed=false;renderSettings();});
settingsForm.addEventListener('submit',async e=>{e.preventDefault();if(pending||!changed)return;try{validateSettings(state);}catch(err){message(err.message,true);return;}pending=true;const controls=[...settingsForm.elements],disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);message('Сохраняем настройки…');
 try{catalogSettings=await api('/api/settings',{method:'PUT',body:JSON.stringify(state)});changed=false;await load();renderSettings();toast('Настройки сохранены. Цены каталога обновлены.');}
 catch(err){message(err.message,true);}
 finally{controls.forEach((c,i)=>c.disabled=disabled[i]);pending=false;$('#save-settings').disabled=!changed;}
});
window.addEventListener('beforeunload',e=>{if(changed){e.preventDefault();e.returnValue='';}});
window.addEventListener('catalog-loaded',renderSettings);renderSettings();
