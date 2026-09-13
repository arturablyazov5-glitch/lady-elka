import {calculatePrice} from './pricing.js';
import {getGroups,groupName,groupVariants,sharedContent,setContent,checkDraft,parsePhotoLinks,parsePriceInput,formatPriceInput,parseUnitInput,formatUnitInput,parseCountInput,formatCountInput,sizeWord,variantWord} from './editor-model.js';
let panelMode='sizes',activeGroup='',contentKey='',lastUndo=null,photoDragIndex=null,lightboxPhotos=[],lightboxIndex=0;
const form=$('#product-form');
const busy=()=>saving||uploading;
const visibilityControl=document.createElement('label');
visibilityControl.className='product-visibility toggle-label';
visibilityControl.innerHTML='<input id="product-visibility-toggle" type="checkbox" aria-label="Показывать товар на сайте"><span>Показывать товар на сайте</span>';
$('#product-visibility').replaceWith(visibilityControl);
const rows=()=>groupVariants(draft,activeGroup);
const contentRows=()=>{const vs=rows();return sharedContent(vs)?vs:[vs.find(v=>v.key===contentKey)||vs[0]];};
const blankVariant=()=>({key:crypto.randomUUID(),category:'Зелёная',height_cm:0,base_price:0,price:0,diameter_cm:0,branches:0,offer:0,discount_pct:0,description:'',photos:[],active:false,variants:'',source_price:0});
const sizeLabel=v=>draft.kind==='decor'?(v.variants&&v.variants!=='-'?v.variants:'Без размера'):`${v.height_cm||'Новый размер'}${v.height_cm?' см':''}`;
function feedback(message,error=false){$('#save-status').textContent=message;$('#save-status').classList.toggle('error',error);}
function dirty(){lastUndo=null;$('#undo-edit').hidden=true;feedback('Есть несохранённые изменения');$('#save-product').disabled=false;}
function rememberUndo(action,message){lastUndo=action;$('#undo-edit').hidden=false;feedback(message);$('#save-product').disabled=false;}
const typesForProduct=()=>{
 const isThuja=draft?.kind==='trees'&&draft.variants.some(v=>v.type_id==='thuja'||/туя|туи/i.test(v.category));
 return catalogSettings.types.filter(t=>isThuja||!(t.id==='thuja'||/туя|туи/i.test(t.name)));
};
$('#undo-edit').addEventListener('click',()=>{if(lastUndo){lastUndo();dirty();renderGroups();}});
window.openEditor=function(product,seed=null){
 if(product) draft=structuredClone(product);
 else if(seed) draft={id:'',sku:'',title:`${seed.title} (копия)`,kind:seed.kind,variants:seed.variants.map(v=>({...v,key:crypto.randomUUID()}))};
 else {
  draft={id:'',sku:'',title:'',kind:kind==='decor'?'decor':'trees',variants:[blankVariant()]};
  const type=catalogSettings.types.find(t=>kind==='thuja'?t.id==='thuja':t.id==='green')||catalogSettings.types[0];draft.variants[0].category=type.name;draft.variants[0].type_id=type.id;
 }
 panelMode='sizes';activeGroup=getGroups(draft)[0];contentKey='';lastUndo=null;original=signature(draft);
 form.elements.title.value=draft.title;form.elements.sku.value=draft.sku;form.elements.kind.value=draft.kind;
 $('.product-settings').open=!product;form.elements.sku.disabled=!!product;form.elements.kind.disabled=!!product;
 $('#editor-title').textContent=product?product.title:(draft.title||'Новый товар');
 $('#editor-caption').textContent=product?`${sectionName(product)} · Артикул ${product.sku}`:(seed?'Дублирование товара — укажите новый артикул':'Добавление в каталог');
 $('#sku-hint').textContent=product?'Артикул связывает товар с карточкой на сайте.':'Укажите такой же артикул в карточке Taptop.';
 $('#undo-edit').hidden=true;$('#save-product').disabled=!!product;feedback(product?'Все изменения сохранены':(seed?'Заполните новый артикул для дубликата':'Заполните название, артикул и цену'));
 $('#duplicate-product').hidden=!product;$('#delete-product').hidden=!product;
 renderGroups();$('#editor').showModal();$('.editor-scroll').scrollTop=0;(seed?form.elements.sku:form.elements.title).focus();
};
$('#add-product').addEventListener('click',()=>openEditor());
function smallInput(v,key,label,{min=0,max=1e9,readonly=false}={}){
 const price=key==='base_price',unit=key==='height_cm'||key==='diameter_cm',count=key==='branches';
 const value=price?formatPriceInput(v[key]):unit?formatUnitInput(v[key]):count?formatCountInput(v[key]):(key==='discount_pct'?Math.abs(v[key]):v[key]||'');
 const attrs=price?'type="text" inputmode="numeric" data-price-mask':unit?'type="text" inputmode="numeric" data-unit-mask':count?'type="text" inputmode="numeric" data-count-mask':'type="number" inputmode="decimal" min="'+min+'" max="'+max+'" step="any"';
 return `<label class="field"><span>${label}</span><input data-field="${key}" ${attrs} value="${value}" ${readonly?'readonly':''} aria-label="${label}"></label>`;
}
function renderGroups(){
 const groups=getGroups(draft);if(!groups.includes(activeGroup))activeGroup=groups[0];
 $('#groups-title').textContent=draft.kind==='decor'?'Размеры и варианты':'Типы товара';$('#groups-hint').textContent=draft.kind==='decor'?'Цены по размерам, общее описание и фотографии.':'У каждого типа — свои размеры, цены и фотографии.';
 $('#add-group').hidden=draft.kind==='decor';$('#group-tabs').hidden=draft.kind==='decor';
 $('#product-visibility-toggle').checked=draft.variants.some(v=>v.active);
 $('#group-tabs').innerHTML=groups.map((name,i)=>`<button type="button" role="tab" id="group-tab-${i}" aria-controls="group-panel" aria-selected="${name===activeGroup}" tabindex="${name===activeGroup?'0':'-1'}" data-group="${esc(name)}" class="group-tab ${name===activeGroup?'selected':''}">${esc(name)}<span>${groupVariants(draft,name).length}</span></button>`).join('');
 const vs=rows(),common=sharedContent(vs),media=contentRows()[0];
 $('#variants').innerHTML=`<section class="group-panel" id="group-panel" role="tabpanel" ${draft.kind==='trees'?`aria-labelledby="group-tab-${groups.indexOf(activeGroup)}"`:'aria-label="Размеры и варианты"'}><div class="group-heading"><div><h3>${esc(activeGroup)}</h3><span>${vs.length} ${draft.kind==='decor'?variantWord(vs.length):sizeWord(vs.length)}</span></div><div class="group-actions">${draft.kind==='trees'?`<label class="type-picker"><span>Тип товара</span><select id="group-type-select" aria-label="Тип товара">${typesForProduct().filter(t=>t.name===activeGroup||!getGroups(draft).includes(t.name)).map(t=>`<option value="${esc(t.id)}" ${t.name===activeGroup?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label>`:''}<button type="button" class="btn secondary" id="add-size">${pict('plus')}Добавить размер</button></div></div><div class="content-tabs" role="tablist" aria-label="Содержимое типа"><button type="button" role="tab" data-mode="sizes" aria-controls="sizes-panel" aria-selected="${panelMode==='sizes'}" class="${panelMode==='sizes'?'selected':''}">Размеры и цены</button><button type="button" role="tab" data-mode="content" aria-controls="content-panel" aria-selected="${panelMode==='content'}" class="${panelMode==='content'?'selected':''}">Фото и описание</button></div><div class="size-list" id="sizes-panel" ${panelMode==='sizes'?'':'hidden'}>${vs.map(v=>`<div class="size-card" data-key="${esc(v.key)}"><div class="size-main">${draft.kind==='trees'?smallInput(v,'height_cm','Высота, см',{min:1}):`<label class="field"><span>Размер / вариант</span><input data-field="variants" value="${esc(v.variants==='-'?'':v.variants)}" placeholder="Например, 120х40х40"></label>`}${smallInput(v,'base_price','Базовая цена, ₽',{min:.01})}<div class="computed-price"><span>Цена на сайте</span><output data-price>${rub(v.price)}</output><small>Без скидки: <span data-offer>${v.offer?rub(v.offer):'—'}</span></small></div><label class="toggle-label size-visible"><span>Показывать</span><input type="checkbox" data-field="active" ${v.active?'checked':''} aria-label="Показывать ${esc(sizeLabel(v))} на сайте"></label><button type="button" class="icon-btn size-remove" data-remove="${esc(v.key)}" title="Удалить размер" aria-label="Удалить ${esc(sizeLabel(v))}" ${draft.variants.length===1?'disabled':''}>${pict('trash')}</button></div>${draft.kind==='trees'?`<details class="size-extra"><summary>Характеристики ${pict('chevronDown')}</summary><div class="size-extra-grid">${smallInput(v,'diameter_cm','Диаметр, см')}${smallInput(v,'branches','Количество веток')}<p class="field-hint">Цены рассчитываются из базовой цены. Общая скидка и изменение цен задаются в настройках.</p></div></details>`:''}</div>`).join('')}</div>
 <div class="group-content" id="content-panel" ${panelMode==='content'?'':'hidden'}><div class="content-heading"><h3>Описание и фотографии</h3><p>${common?(vs.length>1?'Общие для всех размеров этого типа. Изменения применятся ко всем размерам.':'Для этого варианта товара.'):'У этого типа содержимое отличается по размерам. Выберите размер для редактирования.'}</p></div>${!common?`<label class="field content-scope">Размер<select id="content-scope">${vs.map(v=>`<option value="${esc(v.key)}" ${v.key===media.key?'selected':''}>${esc(sizeLabel(v))}</option>`).join('')}</select></label>`:''}<label class="field">Описание<textarea id="group-description" rows="3" maxlength="20000" placeholder="Расскажите о товаре">${esc(media.description)}</textarea></label>
 <div class="photos-heading"><h4>Фотографии <span id="photo-count">${media.photos.length}</span></h4><p>Первое фото — обложка. Перетаскивайте фотографии, чтобы менять порядок.</p></div><div id="photo-gallery" class="photo-gallery"></div>
 <div class="photo-dropzone" id="photo-dropzone"><button class="btn primary" type="button" id="choose-photos">${pict('plus')}Добавить фотографии</button><span>Выберите файлы или перетащите их сюда</span><small>JPG, PNG, WebP · до 8 МБ · сжатие в WebP 80%</small><input type="file" id="photo-files" accept="image/jpeg,image/png,image/webp" multiple hidden></div>
 <div class="photo-url-row"><label class="field"><span>Или добавьте по ссылке</span><input id="photo-url" type="text" placeholder="https://site.ru/photo.jpg" autocomplete="off"></label><button class="btn secondary" type="button" id="add-photo-url">Добавить</button></div><p id="photo-feedback" class="photo-feedback" role="status"></p></div></section>`;
 const typeSelect=$('#group-type-select');
 if(typeSelect){
  const options=[...typeSelect.options].map(option=>({value:option.value,label:option.textContent}));
  typeSelect.closest('.type-picker').outerHTML=selectControl({id:'group-type-select',options,value:typeSelect.value,ariaLabel:'Тип товара',className:'type-picker'});
 }
 $('.content-heading')?.remove();
 renderPhotos();
}
function renderPhotos(){
 const media=contentRows()[0];$('#photo-count').textContent=media.photos.length;
 $('#photo-gallery').innerHTML=media.photos.map((url,i)=>`<div class="gallery-item" draggable="true" data-photo="${i}"><button type="button" class="photo-open" data-preview="${i}" aria-label="Открыть фото ${i+1}"><img src="${esc(url)}" alt="Фото ${i+1}" draggable="false" referrerpolicy="no-referrer"></button>${i===0?'<span class="cover-badge">Обложка</span>':''}<button class="gallery-delete" type="button" data-photo-remove="${i}" title="Удалить фото" aria-label="Удалить фото ${i+1}">${pict('x')}</button><div class="gallery-actions"><button type="button" data-photo-left="${i}" ${i===0?'disabled':''} title="Переместить влево" aria-label="Переместить фото ${i+1} влево">${pict('arrowLeft')}</button><button type="button" data-photo-first="${i}" ${i===0?'disabled':''} title="Сделать обложкой" aria-label="Сделать фото ${i+1} обложкой">${pict('star')}</button><button type="button" data-photo-right="${i}" ${i===media.photos.length-1?'disabled':''} title="Переместить вправо" aria-label="Переместить фото ${i+1} вправо">${pict('arrowRight')}</button></div></div>`).join('');
 $$('#photo-gallery img').forEach(img=>img.addEventListener('error',()=>{img.hidden=true;const note=document.createElement('span');note.className='photo-error';note.textContent='Фото недоступно';img.parentElement.append(note);},{once:true}));
}
function selectGroup(name){if(busy())return;activeGroup=name;contentKey='';renderGroups();$('#group-panel').scrollIntoView({block:'nearest'});}
$('#group-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-group]');if(b&&!busy())selectGroup(b.dataset.group);});
$('#group-tabs').addEventListener('keydown',e=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;e.preventDefault();const names=getGroups(draft);const index=e.key==='Home'?0:e.key==='End'?names.length-1:(names.indexOf(activeGroup)+(e.key==='ArrowRight'?1:-1)+names.length)%names.length;selectGroup(names[index]);$('[data-group].selected').focus();});
form.addEventListener('input',e=>{
 if(!draft||busy())return;
 if(e.target.name==='title')draft.title=e.target.value;
 else if(e.target.name==='sku'){draft.sku=e.target.value;draft.id=`${draft.kind}:${draft.sku}`;}
 else if(e.target.id==='group-description')setContent(contentRows(),'description',e.target.value);
 else if(e.target.dataset.field){const v=draft.variants.find(v=>v.key===e.target.closest('[data-key]').dataset.key),k=e.target.dataset.field;const val=e.target.type==='checkbox'?e.target.checked:e.target.type==='number'?(e.target.value===''?0:Number(e.target.value)):k==='base_price'?parsePriceInput(e.target.value):e.target.matches('[data-unit-mask]')?parseUnitInput(e.target.value):e.target.matches('[data-count-mask]')?parseCountInput(e.target.value):e.target.value;if(k==='base_price'){v.base_price=val;Object.assign(v,calculatePrice(val,catalogSettings));}else v[k]=val;const card=e.target.closest('[data-key]');if(k==='base_price'){card.querySelector('[data-price]').textContent=rub(v.price);card.querySelector('[data-offer]').textContent=v.offer?rub(v.offer):'—';}}
 else return;
 e.target.removeAttribute('aria-invalid');dirty();
});
form.addEventListener('focusin',e=>{if(e.target.matches('[data-price-mask]')){const card=e.target.closest('[data-key]');const v=draft.variants.find(item=>item.key===card?.dataset.key);e.target.value=v?String(v.base_price||''):'';}});
form.addEventListener('focusout',e=>{if(e.target.matches('[data-price-mask]'))e.target.value=formatPriceInput(e.target.value);});
form.addEventListener('focusin',e=>{if(e.target.matches('[data-unit-mask]')){const card=e.target.closest('[data-key]');const v=draft.variants.find(item=>item.key===card?.dataset.key);e.target.value=v?String(v[e.target.dataset.field]||''):'';}});
form.addEventListener('focusout',e=>{if(e.target.matches('[data-unit-mask]'))e.target.value=formatUnitInput(e.target.value);});
form.addEventListener('focusin',e=>{if(e.target.matches('[data-count-mask]')){const card=e.target.closest('[data-key]');const v=draft.variants.find(item=>item.key===card?.dataset.key);e.target.value=v?String(v.branches||''):'';}});
form.addEventListener('focusout',e=>{if(e.target.matches('[data-count-mask]'))e.target.value=formatCountInput(e.target.value);});
form.elements.kind.addEventListener('change',e=>{draft.kind=e.target.value;draft.id=`${draft.kind}:${draft.sku}`;activeGroup=getGroups(draft)[0];dirty();renderGroups();});
$('#product-visibility-toggle').addEventListener('change',e=>{if(busy())return;const active=e.target.checked;draft.variants.forEach(v=>v.active=active);dirty();renderGroups();feedback(active?'Все размеры включены. Сохраните товар.':'Товар будет скрыт после сохранения.');});
function groupDialog(){
 const available=typesForProduct().filter(t=>!getGroups(draft).includes(t.name));
 if(!available.length){feedback('Все типы уже добавлены. Новый тип можно создать в разделе «Настройки».');return;}
 $('#group-dialog-title').textContent='Добавить тип';$('#group-name').innerHTML=available.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');$('#group-error').textContent='';$('#group-form button[type="submit"]').textContent='Добавить';$('#group-dialog').showModal();$('#group-name').focus();
}
$('#add-group').addEventListener('click',groupDialog);$('#cancel-group').addEventListener('click',()=>$('#group-dialog').close());
$('#group-form').addEventListener('submit',e=>{e.preventDefault();const type=catalogSettings.types.find(t=>t.id===$('#group-name').value);if(!type||getGroups(draft).includes(type.name))return;const v=blankVariant();v.category=type.name;v.type_id=type.id;draft.variants.push(v);activeGroup=type.name;panelMode='sizes';contentKey='';dirty();renderGroups();$('#group-dialog').close();});
function photoFeedback(s,error=false){$('#photo-feedback').textContent=s;$('#photo-feedback').classList.toggle('error',error);}
function updatePhotos(photos){setContent(contentRows(),'photos',photos);dirty();renderPhotos();}
function movePhoto(from,to){if(from===to)return;const photos=[...contentRows()[0].photos];const [p]=photos.splice(from,1);photos.splice(to,0,p);updatePhotos(photos);photoFeedback('Порядок фотографий изменён');}
function addLinks(){try{const urls=parsePhotoLinks($('#photo-url').value),old=contentRows()[0].photos,photos=[...new Set([...old,...urls])];if(photos.length>50)throw new Error('Можно добавить не более 50 фотографий');updatePhotos(photos);$('#photo-url').value='';photoFeedback(photos.length===old.length?'Эти фотографии уже добавлены':`Добавлено фото: ${photos.length-old.length}`);}catch(e){photoFeedback(e.message,true);$('#photo-url').focus();}}
$('#variants').addEventListener('keydown',e=>{if(e.target.id==='photo-url'&&e.key==='Enter'){e.preventDefault();addLinks();}});
$('#variants').addEventListener('click',e=>{
 if(busy())return;
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.mode){panelMode=b.dataset.mode;renderGroups();return;}
 
 if(b.id==='choose-photos')return $('#photo-files').click();
 if(b.id==='add-photo-url')return addLinks();
 if(b.id==='add-size'){panelMode='sizes';if(draft.variants.length>=200){feedback('В одном товаре может быть не более 200 вариантов',true);return;}const source=contentRows()[0],v=blankVariant();v.category=activeGroup;v.type_id=source.type_id;v.description=source.description;v.photos=[...source.photos];draft.variants.push(v);dirty();renderGroups();const last=$(`[data-key="${v.key}"] input`);last.focus();last.scrollIntoView({block:'nearest'});return;}
 if(b.dataset.remove){const index=draft.variants.findIndex(v=>v.key===b.dataset.remove);const [v]=draft.variants.splice(index,1);rememberUndo(()=>{draft.variants.splice(index,0,v);activeGroup=groupName(draft,v);},`Размер ${sizeLabel(v)} удалён`);renderGroups();return;}
 if(b.dataset.preview!==undefined){lightboxPhotos=contentRows()[0].photos;showLightbox(+b.dataset.preview);$('#photo-lightbox').showModal();return;}
 if(b.dataset.photoRemove!==undefined){const vs=contentRows(),previous=vs.map(v=>[v,[...v.photos]]),photos=[...vs[0].photos];photos.splice(+b.dataset.photoRemove,1);setContent(vs,'photos',photos);renderPhotos();rememberUndo(()=>previous.forEach(([v,ph])=>v.photos=ph),'Фотография удалена');return;}
 if(b.dataset.photoFirst!==undefined)return movePhoto(+b.dataset.photoFirst,0);
 if(b.dataset.photoLeft!==undefined)return movePhoto(+b.dataset.photoLeft,+b.dataset.photoLeft-1);
 if(b.dataset.photoRight!==undefined)return movePhoto(+b.dataset.photoRight,+b.dataset.photoRight+1);
});
function showLightbox(i){
 lightboxIndex=(i+lightboxPhotos.length)%lightboxPhotos.length;
 $('#large-photo').src=lightboxPhotos[lightboxIndex];
 const many=lightboxPhotos.length>1;
 $('#photo-prev').hidden=$('#photo-next').hidden=!many;
 $('#photo-counter').textContent=many?`${lightboxIndex+1} из ${lightboxPhotos.length}`:'';
}
$('#close-photo').addEventListener('click',()=>$('#photo-lightbox').close());
$('#photo-prev').addEventListener('click',()=>showLightbox(lightboxIndex-1));
$('#photo-next').addEventListener('click',()=>showLightbox(lightboxIndex+1));
$('#photo-lightbox').addEventListener('click',e=>{if(e.target.id==='photo-lightbox')$('#photo-lightbox').close();});
$('#photo-lightbox').addEventListener('keydown',e=>{if(e.key==='ArrowLeft')showLightbox(lightboxIndex-1);else if(e.key==='ArrowRight')showLightbox(lightboxIndex+1);});
$('#variants').addEventListener('change',e=>{if(e.target.id==='group-type-select'){const type=catalogSettings.types.find(t=>t.id===e.target.value);if(type){rows().forEach(v=>{v.type_id=type.id;v.category=type.name;});activeGroup=type.name;dirty();renderGroups();}return;}if(e.target.id==='content-scope'){contentKey=e.target.value;renderGroups();}if(e.target.id==='photo-files')uploadFiles([...e.target.files]);});
$('#variants').addEventListener('dragstart',e=>{const tile=e.target.closest('[data-photo]');if(tile){photoDragIndex=+tile.dataset.photo;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(photoDragIndex));}});
$('#variants').addEventListener('dragover',e=>{if(e.target.closest('[data-photo],#photo-dropzone')){e.preventDefault();const zone=e.target.closest('#photo-dropzone');if(zone)zone.classList.add('dragging');}});
$('#variants').addEventListener('dragleave',e=>{if(e.target.id==='photo-dropzone')e.target.classList.remove('dragging');});
$('#variants').addEventListener('dragend',()=>photoDragIndex=null);
$('#variants').addEventListener('drop',e=>{const zone=e.target.closest('#photo-dropzone'),tile=e.target.closest('[data-photo]');if(!zone&&!tile)return;e.preventDefault();zone?.classList.remove('dragging');if(busy())return;if(e.dataTransfer.files.length){uploadFiles([...e.dataTransfer.files]);return;}if(tile&&photoDragIndex!==null){movePhoto(photoDragIndex,+tile.dataset.photo);photoDragIndex=null;}});
async function uploadFiles(files){
 if(busy()||!files.length)return;
 if(files.some(f=>f.size>8*1024*1024||!['image/jpeg','image/png','image/webp'].includes(f.type))){photoFeedback('Выберите JPG, PNG или WebP до 8 МБ',true);return;}
 const targets=contentRows();if(files.length+targets[0].photos.length>50){photoFeedback('Не более 50 фотографий в галерее',true);return;}
 uploading=true;const controls=[...form.elements],states=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);let count=0;
 try{for(const [i,file]of files.entries()){photoFeedback(`Сжимаем и загружаем фото ${i+1} из ${files.length}…`);const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(new Error('Не удалось прочитать файл'));r.readAsDataURL(file);});const {url}=await api('/api/photos',{method:'POST',body:JSON.stringify({data})});targets.forEach(v=>v.photos.push(url));count++;renderPhotos();}photoFeedback(`Добавлено фото: ${count}`);}
 catch(e){photoFeedback(`${e.message}${count?`. Уже добавлено: ${count}`:''}`,true);}
 finally{controls.forEach((c,i)=>c.disabled=states[i]);uploading=false;if(count)dirty();$('#photo-files').value='';}
}
function closeEditor(){if(busy())return;if(signature(draft)!==original){confirmDiscard(()=>{$('#editor').close();draft=null;});return;}$('#editor').close();draft=null;}
$('#close-editor').addEventListener('click',closeEditor);$('#cancel-editor').addEventListener('click',closeEditor);$('#editor').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});
function startDuplicate(){const seed=draft;openEditor(null,seed);}
$('#duplicate-product').addEventListener('click',()=>{if(busy())return;if(signature(draft)!==original){confirmDiscard(startDuplicate);return;}startDuplicate();});
let deletingProduct=null;
$('#delete-product').addEventListener('click',()=>{
 if(busy()||!draft?.id)return;
 deletingProduct=draft;
 $('#product-delete-text').textContent=`Товар «${draft.title}» исчезнет из каталога и ссылок для сайта. Действие нельзя отменить.`;
 $('#product-delete-dialog').showModal();
});
$('#product-delete-cancel').addEventListener('click',()=>$('#product-delete-dialog').close());
$('#product-delete-confirm').addEventListener('click',async()=>{
 if(!deletingProduct||busy())return;
 saving=true;$('#product-delete-confirm').disabled=true;
 try{
  await api(`/api/products/${encodeURIComponent(deletingProduct.id)}`,{method:'DELETE'});
  products=products.filter(p=>p.id!==deletingProduct.id);
  toast(`Товар «${deletingProduct.title}» удалён`);
  $('#product-delete-dialog').close();$('#editor').close();draft=null;
  render();renderFeeds();
 }catch(e){toast(e.message);}
 finally{saving=false;$('#product-delete-confirm').disabled=false;deletingProduct=null;}
});
window.addEventListener('beforeunload',e=>{if(draft&&(busy()||signature(draft)!==original)){e.preventDefault();e.returnValue='';}});
form.addEventListener('submit',async e=>{
 e.preventDefault();if(busy())return;
 const invalid=checkDraft(draft);if(invalid){if(invalid.key){const v=draft.variants.find(v=>v.key===invalid.key);activeGroup=groupName(draft,v);panelMode='sizes';renderGroups();}feedback(invalid.message,true);const input=invalid.key?$(`[data-key="${invalid.key}"] [data-field="${invalid.field}"]`):form.elements[invalid.field];if(input){input.closest('details')?.setAttribute('open','');input.setAttribute('aria-invalid','true');input.focus();}return;}
 saving=true;const controls=[...form.elements],states=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);$('#save-product').textContent='Сохраняем…';feedback('Сохраняем изменения…');
 try{draft.title=draft.title.trim();const saved=await api(draft.revision?`/api/products/${encodeURIComponent(draft.id)}`:'/api/products',{method:draft.revision?'PUT':'POST',body:JSON.stringify(draft)});const index=products.findIndex(p=>p.id===saved.id);if(index>=0)products[index]=saved;else products.push(saved);products.sort(catalogOrder);original=signature(saved);draft=null;$('#editor').close();render();renderFeeds();
  const hiddenByKind=kind!=='all'&&section(saved)!==kind,hiddenByVisibility=$('#visibility').value==='active'&&!saved.variants.some(v=>v.active);
  toast(hiddenByKind?`Товар сохранён — он в разделе «${sectionName(saved)}», не в текущем фильтре`:hiddenByVisibility?'Товар сохранён, но скрыт фильтром «На сайте» — он выключен':'Товар сохранён');}
 catch(err){feedback(err.message,true);}
 finally{controls.forEach((c,i)=>c.disabled=states[i]);saving=false;$('#save-product').textContent='Сохранить';}
});
