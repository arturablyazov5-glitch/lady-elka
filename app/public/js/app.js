'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rub=n=>Number(n).toLocaleString('ru-RU')+' ₽';
const pict=(name)=>icon(name);
function icons(root=document){root.querySelectorAll('[data-icon]').forEach(e=>e.innerHTML=pict(e.dataset.icon));}
icons();
let catalogSettings=null;
let products=[],kind='all',draft=null,original='',saving=false,sourceOrigin=location.origin,toastTimer,uploading=false;
// Общее подтверждение «Закрыть без сохранения?» для карточки товара и промокода.
let pendingDiscard=null;
function confirmDiscard(action){pendingDiscard=action;$('#confirm-dialog').showModal();}
$('#keep-editing').addEventListener('click',()=>{pendingDiscard=null;$('#confirm-dialog').close();});
$('#discard').addEventListener('click',()=>{const action=pendingDiscard;pendingDiscard=null;$('#confirm-dialog').close();action?.();});
const section=p=>p.kind==='decor'?'decor':p.variants.some(v=>v.type_id==='thuja'||/туя|туи/i.test(v.category))?'thuja':'trees';
// Тот же порядок, что и в исходном списке: декор в конце, внутри раздела — по строке источника, новые товары — в конец своей группы.
const catalogOrder=(a,b)=>(a.kind==='decor')-(b.kind==='decor') || (a.variants[0].source_row??10000)-(b.variants[0].source_row??10000);
const sectionName=p=>({trees:'Ёлки',thuja:'Туи',decor:'Декор'}[section(p)]);
const signature=p=>JSON.stringify(p);
function toast(s){$('#toast').textContent=s;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
const normalizeSearch=s=>String(s??'').toLocaleLowerCase('ru-RU').replaceAll('ё','е').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
const trigrams=s=>{const t=`  ${normalizeSearch(s)} `,out=[];for(let i=0;i<t.length-2;i++)out.push(t.slice(i,i+3));return out;};
const similarity=(a,b)=>{a=normalizeSearch(a);b=normalizeSearch(b);if(!a||!b)return 0;if(a===b)return 1;const shorter=Math.min(a.length,b.length),longer=Math.max(a.length,b.length);if((a.includes(b)||b.includes(a))&&shorter>=3&&shorter/longer>=.5)return .86;const aa=new Set(trigrams(a)),bb=new Set(trigrams(b));let common=0;for(const x of aa)if(bb.has(x))common++;return (2*common)/(aa.size+bb.size)||0;};
const editDistance=(a,b)=>{const row=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let prev=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const next=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));prev=next;}}return row[b.length];};
function searchScore(query,p){const q=normalizeSearch(query);if(!q)return 0;const hay=normalizeSearch([p.title,p.sku,...p.variants.flatMap(v=>[v.category,v.variants,v.height_cm]).filter(Boolean)].join(' '));const qTokens=q.split(' ');const words=hay.split(' ');let score=0;for(const token of qTokens){if(!token)continue;let best=0;for(const word of words){if(word===token)best=Math.max(best,1);else if(word.startsWith(token))best=Math.max(best,.92);else if(token.length>=3)best=Math.max(best,similarity(word,token));else if(word.includes(token))best=Math.max(best,.78);if(token.length>=3&&token.length<=8&&word.length<=12)best=Math.max(best,1-editDistance(word,token)/Math.max(word.length,token.length));}if(best<.42)return 0;score+=best;}const title=normalizeSearch(p.title),sku=normalizeSearch(p.sku);if(title===q)score+=1.2;else if(title.startsWith(q))score+=.7;if(sku===q)score+=1.4;return score/qTokens.length;}
async function api(url,options={}){
 let res;
 try{res=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Catalog-Request':'1',...options.headers}});}
 catch{throw new Error('Нет связи с сервером');}
 const data=await res.json().catch(()=>null);
 if(!res.ok){if(res.status===401 && !$('#login-dialog').open) $('#login-dialog').showModal();throw new Error(data?.error || 'Не удалось выполнить запрос');}
 if(data===null)throw new Error('Некорректный ответ сервера');
 return data;
}
async function load(){
 $('#refresh').disabled=true;$('#add-product').disabled=true;
 try{const data=await api('/api/catalog');catalogSettings=data.settings;products=data.products.sort(catalogOrder);sourceOrigin=data.origin;render();renderFeeds();window.dispatchEvent(new Event('catalog-loaded'));}
 catch(e){$('#result-caption').textContent='Каталог не загружен';$('#product-list').innerHTML=`<div class="load-error">${esc(e.message)}. Нажмите «Обновить каталог», чтобы повторить.</div>`;}
 finally{$('#refresh').disabled=false;$('#add-product').disabled=!catalogSettings;}
}
function render(){
 $('#nav-count').textContent=products.length;
 for(const k of ['all','trees','thuja','decor']) $(`#count-${k}`).textContent=products.filter(p=>k==='all'||section(p)===k).length;
 const q=normalizeSearch($('#search').value),visibility=$('#visibility').value;
 const list=products.filter(p=>(kind==='all'||section(p)===kind)&&(visibility==='all'||(visibility==='active'?p.variants.some(v=>v.active):p.variants.every(v=>!v.active)))).map(p=>({p,score:q?searchScore(q,p):0})).filter(x=>!q||x.score>0).sort((a,b)=>q?(b.score-a.score||a.p.title.localeCompare(b.p.title,'ru')):0).map(x=>x.p);
 $('#result-caption').textContent=`Товаров: ${list.length} из ${products.length}`;
 $('#empty').hidden=!!list.length;
 $('#product-list').innerHTML=list.map(p=>{
  const active=p.variants.filter(v=>v.active),photo=p.variants.flatMap(v=>v.photos)[0];
  const price=Math.min(...(active.length?active:p.variants).map(v=>v.price)),categories=[...new Set(p.variants.map(v=>v.category).filter(Boolean))];
  return `<article class="product-row" data-edit="${esc(p.id)}" role="button" tabindex="0" aria-label="Открыть ${esc(p.title)}"><div class="product-photo">${photo?`<img src="${esc(photo)}" alt="${esc(p.title)}" loading="lazy" referrerpolicy="no-referrer">`:pict('image')}</div><div class="product-summary"><h3>${esc(p.title)}</h3><div class="product-meta"><span>Артикул ${esc(p.sku)}</span><span>·</span><span>Вариантов: ${p.variants.length}</span></div><span class="product-category">${esc([sectionName(p),...categories].join(' · '))}</span></div><div class="product-price">${p.variants.length>1?'от ':''}${rub(price)}<span class="visibility-state ${active.length?'':'off'}"><span></span>${active.length?'На сайте':'Скрыт'}</span>${active.length&&active.length<p.variants.length?`<small>${active.length} из ${p.variants.length} вариантов</small>`:''}</div><button class="icon-btn row-edit" type="button" data-edit="${esc(p.id)}" aria-label="Редактировать ${esc(p.title)}">${pict('pencil')}</button></article>`;
 }).join('');
 $('#product-list').querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{img.parentElement.innerHTML=pict('image');},{once:true}));
}
function navigate(page){const current=['catalog','promos','integration','settings'].includes(page)?page:'catalog';for(const key of ['catalog','promos','integration','settings']){const el=$(`#${key}-page`);if(el){el.hidden=current!==key;el.classList.toggle('active',current===key);}}$$('.side-tabs [data-nav]').forEach(a=>{if(a.dataset.nav===current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});document.title=`${{catalog:'Каталог',promos:'Промокоды',integration:'Подключение сайта',settings:'Настройки'}[current]} — Lady Elka`;window.dispatchEvent(new CustomEvent('page-shown',{detail:current}));}
window.addEventListener('hashchange',()=>{navigate(location.hash.slice(1));window.scrollTo(0,0);});navigate(location.hash.slice(1));
$$('[data-kind]').forEach(b=>b.addEventListener('click',()=>{kind=b.dataset.kind;$$('[data-kind]').forEach(t=>{t.classList.toggle('selected',t===b);t.setAttribute('aria-selected',String(t===b));});render();}));
$('#search').addEventListener('input',render);$('#visibility').addEventListener('change',render);$('#refresh').addEventListener('click',load);
$('#reset-filters').addEventListener('click',()=>{$('#search').value='';$('#visibility').value='all';$('[data-kind="all"]').click();});
$('#product-list').addEventListener('click',e=>{const row=e.target.closest('.product-row[data-edit]');if(row)openEditor(products.find(p=>p.id===row.dataset.edit));});
$('#product-list').addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const row=e.target.closest('.product-row[data-edit]');if(!row||e.target.closest('button'))return;e.preventDefault();openEditor(products.find(p=>p.id===row.dataset.edit));});
function renderFeeds(){
 $('#feed-links').innerHTML=[['trees','Ёлки и туи'],['decor','Декор'],['promos','Промокоды']].map(([key,title])=>{const url=`${sourceOrigin}/feeds/${key}.csv`;return `<section class="feed-card"><div class="feed-title"><div><h3>${title}</h3><p>${key==='promos'?'Действующие промокоды':products.filter(p=>p.kind===key).length+' товаров'} · CSV для Taptop</p></div>${pict('fileText')}</div><input class="feed-url" value="${esc(url)}" readonly aria-label="Ссылка ${title}"><div class="feed-actions"><button class="btn primary" data-copy="${esc(url)}">${pict('copy')}Скопировать ссылку</button><a class="btn secondary" href="${esc(url)}" target="_blank" rel="noopener">${pict('download')}Открыть CSV</a></div></section>`;}).join('');
}
$('#feed-links').addEventListener('click',async e=>{const b=e.target.closest('[data-copy]');if(b){try{await navigator.clipboard.writeText(b.dataset.copy);toast('Ссылка скопирована');}catch{const input=b.closest('.feed-card').querySelector('input');input.select();toast('Ссылка выделена. Нажмите ⌘C для копирования.');}}});
$('#login-dialog').addEventListener('cancel',e=>e.preventDefault());$('#login-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:JSON.stringify({password:e.target.elements.password.value})});e.target.reset();$('#login-dialog').close();load();}catch(err){$('#login-error').textContent=err.message;}});
load();
