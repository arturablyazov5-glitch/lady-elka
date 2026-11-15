import {validatePromo,promoStatus,discountLabel,promoTotal} from './promo-model.js';
let promos=[],promoFilter='all',promoSort='new',loaded=false,loadingPromos=false,editing=null,removing=null,busy=false,originalPromo='';
const promoForm=$('#promo-form'),promoDialog=$('#promo-dialog');
const STATUS={live:['Работает','ok'],off:['Выключен','off']};
const ruStamp=s=>s?new Date(s).toLocaleDateString('ru-RU'):'';
const PREVIEW_TOTAL=20000;

function promoMessage(text,error=false){$('#promo-status').textContent=text;$('#promo-status').classList.toggle('error',error);}
function usageText(p){
 if(!p.usage?.orders) return 'Заказов пока нет';
 return `Оплачено заказов: ${p.usage.orders} · ${rub(Math.round(p.usage.amount))}${p.usage.last?` · последний ${ruStamp(p.usage.last)}`:''}`;
}
function visible(){
 const q=normalizeSearch($('#promo-search').value);
 const list=promos.filter(p=>(promoFilter==='all'||promoStatus(p)===promoFilter)&&(!q||normalizeSearch(`${p.code} ${p.comment}`).includes(q)));
 const order={new:(a,b)=>b.created_at.localeCompare(a.created_at)||a.code.localeCompare(b.code,'ru'),
  used:(a,b)=>(b.usage?.orders||0)-(a.usage?.orders||0)||(b.usage?.amount||0)-(a.usage?.amount||0),
  code:(a,b)=>a.code.localeCompare(b.code,'ru')};
 return list.sort(order[promoSort]);
}
function renderPromos(){
 promoTabs.setItems(['all','live','off'].map(key=>({value:key,label:{all:'Все',live:'Работают',off:'Выключены'}[key],count:promos.filter(p=>key==='all'||promoStatus(p)===key).length})));
 $('#nav-promo-count').textContent=promos.filter(p=>p.active).length;
 const list=visible();
 $('#promo-caption').textContent=promos.length?`Промокодов: ${list.length} из ${promos.length}`:'Промокодов пока нет';
 $('#promo-empty').hidden=!!list.length||!promos.length;
 $('#promo-list').innerHTML=list.map(p=>{
  const [label,tone]=STATUS[promoStatus(p)];
  return `<article class="promo-row" data-promo="${esc(p.id)}"><div class="promo-main"><div class="promo-code-line"><button type="button" class="promo-code" data-copy-code="${esc(p.code)}" title="Скопировать промокод">${esc(p.code)}</button><span class="promo-badge ${tone}">${label}</span></div>${p.comment?`<p class="promo-comment">${esc(p.comment)}</p>`:''}<p class="promo-meta"><span>${esc(usageText(p))}</span></p></div><div class="promo-gain">${esc(discountLabel(p))||'—'}</div><div class="promo-actions"><label class="toggle-label promo-toggle" title="${p.active?'Выключить на сайте':'Включить на сайте'}"><input type="checkbox" data-toggle="${esc(p.id)}" ${p.active?'checked':''} aria-label="${p.active?'Выключить':'Включить'} промокод ${esc(p.code)}"></label><button class="icon-btn" type="button" data-edit-promo="${esc(p.id)}" aria-label="Изменить ${esc(p.code)}" title="Изменить">${pict('pencil')}</button><button class="icon-btn" type="button" data-copy-promo="${esc(p.id)}" aria-label="Дублировать ${esc(p.code)}" title="Дублировать">${pict('copy')}</button><button class="icon-btn danger" type="button" data-delete-promo="${esc(p.id)}" aria-label="Удалить ${esc(p.code)}" title="Удалить">${pict('trash')}</button></div></article>`;
 }).join('');
}
async function loadPromos(force=false){
 if(loadingPromos||(loaded&&!force)) return;
 loadingPromos=true;$('#promo-refresh').disabled=true;
 try{
  const data=await api('/api/promos');promos=data.promos;loaded=true;renderPromos();
 }catch(e){$('#promo-caption').textContent='Промокоды не загружены';$('#promo-list').innerHTML=`<div class="load-error">${esc(e.message)}. Нажмите «Обновить промокоды», чтобы повторить.</div>`;}
 finally{loadingPromos=false;$('#promo-refresh').disabled=false;}
}
function previewPromo(){
 let draft;
 try{draft=validatePromo(readForm());}catch(e){$('#promo-preview').innerHTML=`<p class="promo-preview-hint">${esc(e.message)}</p>`;return;}
 const total=promoTotal(draft,PREVIEW_TOTAL);
 $('#promo-preview').innerHTML=`<div class="promo-preview-grid"><span><small>Заказ на</small><strong>${rub(PREVIEW_TOTAL)}</strong></span><span class="promo-preview-arrow">→</span><span><small>Клиент заплатит</small><strong>${rub(total)}</strong></span>${draft.gift?'<span class="promo-preview-gift">+ сумка для хранения</span>':''}</div><p class="promo-preview-hint">${draft.active?'Для заказов только из декора скидка не применяется.':'Выключен — на сайте не сработает.'}</p>`;
}
const readForm=()=>{const f=promoForm.elements;return {code:f.code.value,comment:f.comment.value,rub:f.rub.value,pct:f.pct.value,gift:f.gift.checked,active:f.active.checked};};
// Скидка либо в рублях, либо в процентах: заполненное поле гасит и очищает второе (сайт всё равно приоритетно читает рубли).
function syncRewardFields(){
 const f=promoForm.elements;
 if(Number(f.rub.value)>0) f.pct.value='';
 else if(Number(f.pct.value)>0) f.rub.value='';
 f.pct.disabled=Number(f.rub.value)>0;f.rub.disabled=Number(f.pct.value)>0;
}
function openPromo(promo=null,copy=false){
 editing=copy?null:promo;
 const base=promo||{code:'',comment:'',rub:0,pct:0,gift:false,active:true};
 const f=promoForm.elements;
 f.code.value=copy?'':base.code;f.comment.value=base.comment||'';
 f.rub.value=base.rub||'';f.pct.value=base.pct||'';f.gift.checked=!!base.gift;f.active.checked=base.active!==false;
 syncRewardFields();
 $('#promo-dialog-title').textContent=editing?'Изменить промокод':copy?'Копия промокода':'Новый промокод';
 $('#promo-dialog-caption').textContent=editing?`Промокод ${editing.code}`:'Промокод';
 promoMessage(copy?'Придумайте новый код — остальное уже скопировано.':'Изменения появятся на сайте после сохранения.');
 originalPromo=signature(readForm());
 previewPromo();promoDialog.showModal();f.code.focus();
}
function closePromo(){
 if(busy) return;
 if(signature(readForm())!==originalPromo){confirmDiscard(()=>promoDialog.close());return;}
 promoDialog.close();
}
async function savePromo(){
 if(busy) return;
 let input;
 try{input=validatePromo(readForm());}catch(e){promoMessage(e.message,true);return;}
 busy=true;const controls=[...promoForm.elements],state=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);promoMessage('Сохраняем…');
 try{
  if(editing) await api(`/api/promos/${encodeURIComponent(editing.id)}`,{method:'PUT',body:JSON.stringify({...input,revision:editing.revision})});
  else await api('/api/promos',{method:'POST',body:JSON.stringify(input)});
  promoDialog.close();toast(editing?'Промокод сохранён':'Промокод добавлен');
  await loadPromos(true);
 }catch(e){promoMessage(e.message,true);}
 finally{busy=false;controls.forEach((c,i)=>c.disabled=state[i]);}
}
async function togglePromo(id,active,input){
 const promo=promos.find(p=>p.id===id);if(!promo) return;
 input.disabled=true;
 try{
  await api(`/api/promos/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify({...promo,active,revision:promo.revision})});
  toast(active?`Промокод ${promo.code} работает на сайте`:`Промокод ${promo.code} выключен`);
  await loadPromos(true);
 }catch(e){toast(e.message);input.checked=promo.active;}
 finally{input.disabled=false;}
}
$('#add-promo').addEventListener('click',()=>openPromo());
$('#promo-refresh').addEventListener('click',()=>loadPromos(true));
$('#promo-search').addEventListener('input',renderPromos);
$('#promo-sort').addEventListener('change',e=>{promoSort=e.target.value;renderPromos();});
const promoTabs=createTabComponent($('#promo-tabs'),{ariaLabel:'Состояние промокодов',selected:promoFilter,items:['all','live','off'].map(key=>({value:key,label:{all:'Все',live:'Работают',off:'Выключены'}[key],count:0})),onChange:value=>{promoFilter=value;renderPromos();}});
$('#promo-reset-filters').addEventListener('click',()=>{$('#promo-search').value='';promoTabs.select('all');});
$('#promo-list').addEventListener('click',async e=>{
 const copyCode=e.target.closest('[data-copy-code]');
 if(copyCode){try{await navigator.clipboard.writeText(copyCode.dataset.copyCode);toast(`Промокод ${copyCode.dataset.copyCode} скопирован`);}catch{toast('Не удалось скопировать промокод');}return;}
 const edit=e.target.closest('[data-edit-promo]');if(edit) return openPromo(promos.find(p=>p.id===edit.dataset.editPromo));
 const copy=e.target.closest('[data-copy-promo]');if(copy) return openPromo(promos.find(p=>p.id===copy.dataset.copyPromo),true);
 const remove=e.target.closest('[data-delete-promo]');
 if(remove){removing=promos.find(p=>p.id===remove.dataset.deletePromo);$('#promo-delete-text').textContent=`Промокод «${removing.code}» перестанет работать на сайте. Отменить удаление нельзя — вместо этого его можно выключить.`;$('#promo-delete-dialog').showModal();}
});
$('#promo-list').addEventListener('change',e=>{const box=e.target.closest('[data-toggle]');if(box) togglePromo(box.dataset.toggle,box.checked,box);});
$('#promo-delete-cancel').addEventListener('click',()=>$('#promo-delete-dialog').close());
$('#promo-delete-confirm').addEventListener('click',async()=>{
 if(!removing||busy) return;busy=true;
 try{await api(`/api/promos/${encodeURIComponent(removing.id)}`,{method:'DELETE'});toast(`Промокод ${removing.code} удалён`);$('#promo-delete-dialog').close();await loadPromos(true);}
 catch(e){toast(e.message);}
 finally{busy=false;removing=null;}
});
promoForm.addEventListener('input',()=>{syncRewardFields();previewPromo();});
promoForm.addEventListener('submit',e=>{e.preventDefault();savePromo();});
$('#cancel-promo').addEventListener('click',closePromo);
$('#close-promo').addEventListener('click',closePromo);
promoDialog.addEventListener('cancel',e=>{e.preventDefault();closePromo();});
// Раздел подгружается при первом открытии: каталог и промокоды независимы.
window.addEventListener('page-shown',e=>{if(e.detail==='promos') loadPromos();});
if(location.hash.slice(1)==='promos') loadPromos();
// Счётчик в сайдбаре нужен сразу, не дожидаясь захода в раздел.
window.addEventListener('catalog-loaded',()=>loadPromos(),{once:true});
