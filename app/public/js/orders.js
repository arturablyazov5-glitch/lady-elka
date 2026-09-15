/* Isolated preview: fictional orders, no API calls or production order mutations. */
(()=>{
 const page=document.querySelector('#orders-page');
 const stages={new:'Новый',packing:'Собираем',delivery:'Доставляем',done:'Завершён',cancelled:'Отменён'};
 const orderIcons={box:'<path d="m12 3 9 5v8l-9 5-9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"/>',truck:'<path d="M3 6h11v11H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'};
 const oi=name=>orderIcons[name]?`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${orderIcons[name]}</svg>`:pict(name);
 const stageIcons={new:'receipt',packing:'box',delivery:'truck',done:'circleCheck',cancelled:'circleX'};
 const seed=[
 ['1048','Анна К.','Миранда · зелёная · 215 см',42000,'new',true,'Курьер · 16 сентября, 10–14','Москва','Уточнить удобное время перед выездом.'],
 ['1047','Мария С.','Белла · с освещением · 185 см',28500,'new',false,'Самовывоз · дата не выбрана','Москва','Покупатель выбирает способ оплаты.'],
 ['1046','Салон «Пример»','Катрин · заснеженная · 215 см × 2',76000,'packing',true,'Курьер · 17 сентября, 14–18','Одинцово','Две ёлки для оформления салона.'],
 ['1045','Ольга М.','Аврора · зелёная · 185 см',21000,'delivery',true,'Курьер · 14 сентября, 14–18','Химки','Позвонить за час до доставки.'],
 ['1044','Дмитрий А.','Вивиан · зелёная · 215 см',33000,'packing',true,'Самовывоз · 15 сентября','Москва','Заказ заберёт представитель.'],
 ['1043','Елена П.','Белла · зелёная · 155 см',14450,'done',true,'Доставлен · 13 сентября','Москва',''],
 ['1042','Ирина В.','Миранда · заснеженная · 185 см',38000,'cancelled',false,'Доставка отменена','Красногорск','Покупатель решил выбрать другую высоту.']
 ];
 let orders=seed.map(([id,client,item,total,stage,paid,delivery,city,note])=>({id,client,item,total,stage,paid,delivery,city,note,manager:'Не назначен'}));
 const productPhotos={
  'Миранда':'https://lady-elka.ru/d/img_1948.jpg',
  'Белла':'https://lady-elka.ru/d/photo_2025-09-05_21-23-30.jpg',
  'Катрин':'https://lady-elka.ru/d/photo_2025-09-05_21-40-05.jpg',
  'Аврора':'https://lady-elka.ru/d/photo_2025-09-05_21-49-30.jpg',
  'Вивиан':'https://lady-elka.ru/d/photo_2025-09-06_20-59-34.jpg'
 };
 let filter='all',query='';
 const e=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>n.toLocaleString('ru-RU')+' ₽';
 const options=value=>Object.entries(stages).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${v}</option>`).join('');
 page.innerHTML=`<div class="panel-header contact-finder-heading"><div><h2>Заказы <span class="orders-pro">PRO</span></h2><p class="subtitle">От первого обращения до доставки покупателю</p></div></div>
 <section class="orders-offer"><div class="orders-offer-copy"><h3>Каждый заказ — под контролем</h3><p>Ваш ИИ-агент продаёт 24/7, а заказы попадают в CRM: от оплаты до доставки — вся работа в одном кабинете.</p><div class="orders-benefits"><span>${oi('receipt')}Заказы с сайта</span><span>${oi('users')}Работа команды</span><span>${oi('truck')}Контроль доставки</span></div></div><div class="orders-offer-action"><button class="btn primary" id="orders-upgrade">Подключить PRO ${oi('arrowRight')}</button></div></section>
 <div class="orders-filters" aria-label="Фильтры заказов"></div><div class="filter-bar"><label class="search-control"><span data-icon="search"></span><input id="orders-search" type="search" placeholder="Номер, покупатель или товар" aria-label="Поиск заказов"></label></div>
 <p class="result-caption" id="orders-count" aria-live="polite"></p><div id="orders-list"></div>`;
 joinControls('#orders-page','.orders-filters');
 const dialog=document.createElement('dialog');dialog.id='order-preview';dialog.setAttribute('aria-labelledby','order-preview-title');document.body.append(dialog);

 function render(){
  const filters=[['all','Все',orders.length],['active','В работе',orders.filter(o=>!['done','cancelled'].includes(o.stage)).length],['unpaid','Ждут оплаты',orders.filter(o=>!o.paid&&o.stage!=='cancelled').length],['done','Завершены',orders.filter(o=>o.stage==='done').length]];
  ordersTabs.setItems(filters.map(([k,t,n])=>({value:k,label:t,count:n})));
  const list=orders.filter(o=>(filter==='all'||filter==='active'&&!['done','cancelled'].includes(o.stage)||filter==='unpaid'&&!o.paid&&o.stage!=='cancelled'||filter==='done'&&o.stage==='done')&&`${o.id} ${o.client} ${o.item} ${o.city}`.toLowerCase().includes(query.toLowerCase().trim()));
  page.querySelector('#orders-count').textContent=`Заказов: ${list.length} из ${orders.length} · Тестовые данные`;
  page.querySelector('#orders-list').innerHTML=list.length?list.map(o=>`<article class="order-row" data-order-stage="${o.stage}"><div class="order-card-heading"><button class="order-open" data-open="${o.id}" aria-label="Открыть заказ ${o.id}">№ ${o.id}${oi('chevronRight')}</button><span class="order-customer">${oi('user')}${e(o.client)}</span><div class="order-money"><strong>${money(o.total)}</strong><span class="order-payment ${o.paid?'paid':o.stage==='cancelled'?'cancelled':''}">${oi(o.paid?'circleCheck':o.stage==='cancelled'?'circleX':'clock')}${o.paid?'Оплачен':o.stage==='cancelled'?'Не оплачен':'Ждёт оплаты'}</span></div></div><div class="order-card-body"><div class="order-product"><span class="order-product-photo"><img src="${productPhotos[o.item.split(' · ')[0]]||productPhotos['Миранда']}" alt="${e(o.item.split(' · ')[0])}" loading="lazy" referrerpolicy="no-referrer"></span><div><strong>${e(o.item.split(' · ')[0])}</strong><p>${e(o.item.split(' · ').slice(1).join(' · '))}</p></div></div><label class="order-stage"><span>Статус заказа</span><span class="order-stage-control">${oi(stageIcons[o.stage])}<select class="select-control-field" data-stage="${o.id}" aria-label="Статус заказа ${o.id}">${options(o.stage)}</select></span></label></div><div class="order-card-footer"><span>${oi('mapPin')}${e(o.city)}</span><span>${oi(o.delivery.startsWith('Самовывоз')?'box':'truck')}${e(o.delivery)}</span>${o.note?`<button class="order-note" data-open="${o.id}" aria-label="Комментарий к заказу ${o.id}" title="Открыть комментарий">${oi('messageCircle')}</button>`:''}</div></article>`).join(''):`<div class="empty-state"><h3>Заказов не найдено</h3><p>Попробуйте другой запрос или фильтр.</p><button class="btn secondary" data-clear>Сбросить фильтры</button></div>`;
 }
 function open(id){const o=orders.find(o=>o.id===id);dialog.innerHTML=`<form id="order-demo-form"><div class="orders-modal-head"><div><span class="orders-pro">Тестовый заказ</span><h2 id="order-preview-title">Заказ № ${o.id}</h2></div><button class="icon-btn" type="button" data-close aria-label="Закрыть">${pict('x')}</button></div><div class="orders-modal-body"><div class="order-detail-summary"><div><h3>${e(o.client)}</h3><p>${e(o.city)} · Покупатель из демо</p></div><strong>${money(o.total)}</strong></div><div class="order-detail-item">${e(o.item)}<span class="order-payment ${o.paid?'paid':''}">${o.paid?'Оплачен':'Не оплачен'}</span></div><div class="field-row"><label class="field">Статус заказа<select class="select-control-field" name="stage">${options(o.stage)}</select></label><label class="field">Ответственный<select class="select-control-field" name="manager">${['Не назначен','Анна · менеджер','Мария · менеджер'].map(m=>`<option ${m===o.manager?'selected':''}>${m}</option>`).join('')}</select></label></div><label class="field">Доставка<input name="delivery" maxlength="150" value="${e(o.delivery)}"></label><label class="field">Комментарий менеджера<textarea name="note" maxlength="1000" placeholder="Что важно учесть при обработке">${e(o.note)}</textarea></label><small>Это демо. Покупатель не получит уведомлений.</small></div><div class="editor-footer"><p>Изменения сохранятся до перезагрузки страницы.</p><button class="btn primary" type="submit">Сохранить в демо</button></div></form>`;
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('form').onsubmit=ev=>{ev.preventDefault();const f=ev.target.elements;o.stage=f.stage.value;o.manager=f.manager.value;o.delivery=f.delivery.value;o.note=f.note.value;render();dialog.close();toast('Тестовый заказ обновлён');};dialog.showModal();}
 const ordersTabs=createTabComponent(page.querySelector('.orders-filters'),{ariaLabel:'Фильтры заказов',selected:filter,items:[{value:'all',label:'Все',count:0}],onChange:value=>{filter=value;render();}});
 page.addEventListener('click',ev=>{const b=ev.target.closest('button');if(!b)return;if(b.dataset.open)open(b.dataset.open);if(b.hasAttribute('data-clear')){filter='all';query='';page.querySelector('#orders-search').value='';ordersTabs.select('all');}});
 page.addEventListener('change',ev=>{const id=ev.target.dataset.stage;if(id){orders.find(o=>o.id===id).stage=ev.target.value;render();page.querySelector(`[data-stage="${id}"]`)?.focus();toast('Статус изменён в демо');}});
 page.querySelector('#orders-search').oninput=ev=>{query=ev.target.value;render();};
 page.querySelector('#orders-upgrade').onclick=()=>location.hash='payment';
 icons(page);render();
})();
