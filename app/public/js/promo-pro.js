/* Premium preview only. Demo rules never enter the live promo form or API. */
(()=>{
 const page=document.querySelector('#promos-page');
 const badge='<span class="promo-pro-badge">PRO</span>';
 const banner=document.createElement('section');banner.className='promo-pro-banner';
 banner.innerHTML=`<div class="promo-pro-heading"><span class="promo-pro-symbol">${pict('tag')}</span><div><h3>Больше возможностей для ваших акций ${badge}</h3><p>Срок действия, сумма заказа и лимиты — задавайте точные условия скидки.</p></div></div><button type="button" class="btn" data-preview-pro>Попробовать ${pict('arrowRight')}</button>`;
 page.querySelector('.panel-header').after(banner);
 const entry=document.createElement('div');entry.className='promo-pro-entry';entry.innerHTML=`<div>${pict('settings')}<span><strong>Условия применения ${badge}</strong><small>Сроки, сумма заказа и ограничения</small></span></div><button class="btn secondary" type="button" data-preview-pro>Посмотреть демо</button>`;
 document.querySelector('#promo-preview').before(entry);
 const dialog=document.createElement('dialog');dialog.id='promo-pro-dialog';dialog.setAttribute('aria-labelledby','promo-pro-title');
 dialog.innerHTML=`<div class="promo-pro-modal-head"><div><span class="promo-pro-badge">Демо PRO</span><h2 id="promo-pro-title">Расширенные промокоды</h2><p>Попробуйте условия на примере промокода <strong>ELKA10</strong> со скидкой 10%.</p></div><button class="icon-btn" type="button" id="promo-pro-close" aria-label="Закрыть демо промокодов">${pict('x')}</button></div>
 <div class="promo-pro-scroll"><p class="promo-pro-notice">Это демонстрация. Условия не сохраняются и не применяются к промокодам на сайте.</p>
 <form id="promo-pro-form" novalidate>
 <div class="promo-pro-conditions"><h3 class="promo-pro-column-title">Условия акции</h3>
 <section class="promo-pro-rule"><label class="toggle-label pro-rule-toggle"><span>${pict('calendarDays')}Ограничить срок действия</span><input type="checkbox" name="scheduled" checked></label><div data-rule="scheduled"><div class="field-row"><label class="field">С даты<input type="date" name="start" value="2026-10-01" required></label><label class="field">По дату включительно<input type="date" name="end" value="2026-12-31" required></label></div><small>Даты акции — по московскому времени.</small></div></section>
 <section class="promo-pro-rule"><label class="toggle-label pro-rule-toggle"><span>${pict('creditCard')}Минимальная сумма заказа</span><input type="checkbox" name="hasMinimum" checked></label><div data-rule="hasMinimum"><label class="field">Заказ от, ₽<input type="number" name="minimum" value="20000" min="1" max="10000000" step="1" required></label><small>Общая сумма товаров до скидки, без доставки.</small></div></section>
 <section class="promo-pro-rule"><label class="toggle-label pro-rule-toggle"><span>${pict('receipt')}Ограничить число применений</span><input type="checkbox" name="limited" checked></label><div data-rule="limited"><label class="field">Всего применений<input type="number" name="limit" value="100" min="1" max="100000" step="1" required></label><small>Общий лимит для всех покупателей.</small></div></section>
 <section class="promo-pro-rule"><label class="toggle-label pro-rule-toggle"><span>${pict('user')}Один раз на покупателя</span><input type="checkbox" name="once" checked></label><small>Повторная покупка с тем же кодом — без скидки.</small></section>
 <section class="promo-pro-rule"><h3>${pict('layers')}Товары в акции</h3><label class="field">Применять скидку к<select name="category" class="select-control-field"><option value="all">Всему каталогу</option><option value="trees" selected>Ёлкам</option><option value="thuja">Туям</option></select></label></section>
 </div><aside class="promo-pro-review"><h3 class="promo-pro-column-title">Как будет работать</h3><div class="promo-pro-summary"><div class="pro-coupon"><strong>ELKA10</strong><b>−10%</b></div><p id="promo-pro-summary" aria-live="polite"></p></div><section class="promo-pro-simulator"><h3>${pict('receipt')}Проверка на примере</h3><p class="pro-test-caption">В тестовом заказе один товар выбранной категории.</p><div id="promo-pro-result" aria-live="polite"></div><details class="pro-test-details"><summary>Изменить тестовый заказ</summary><div class="field-row"><label class="field">Сумма заказа, ₽<input type="number" name="amount" value="30000" min="1" max="10000000" step="1" required></label><label class="field">Дата покупки<input type="date" name="date" value="2026-11-15" required></label><label class="field">Товар в заказе<select name="productCategory" class="select-control-field"><option value="trees">Ёлка</option><option value="thuja">Туя</option><option value="decor">Декор</option></select></label><label class="field">Применений другими покупателями<input type="number" name="used" min="0" max="100000" value="12" step="1" required></label></div><label class="toggle-label"><input type="checkbox" name="returning">Этот покупатель уже использовал код</label></details></section><button class="pro-demo-reset" type="button">${pict('refreshCw')}Вернуть пример</button></aside>
 </form></div><div class="promo-pro-modal-footer"><span>Хотите такие условия в своих акциях?</span><a class="btn primary" href="#payment" data-pro-payment>Подключить PRO ${pict('arrowRight')}</a></div>`;
 document.body.append(dialog);dialog.querySelector('[data-pro-payment]').addEventListener('click',()=>{dialog.close();document.querySelector('#promo-dialog')?.close();});
 const form=dialog.querySelector('form'),result=dialog.querySelector('#promo-pro-result');
 function preview(){const f=form.elements;
  for(const key of ['scheduled','hasMinimum','limited']){const group=form.querySelector(`[data-rule="${key}"]`);group.hidden=!f[key].checked;group.querySelectorAll('input').forEach(input=>input.disabled=!f[key].checked);}
  const summary=dialog.querySelector('#promo-pro-summary');
  const category={all:'все товары',trees:'ёлки',thuja:'туи'}[f.category.value];
  const fmt=value=>value.split('-').reverse().join('.');
  summary.textContent=`Скидка 10% на ${category}${f.hasMinimum.checked?` при заказе от ${rub(+f.minimum.value)}`:''}. ${f.scheduled.checked?`С ${fmt(f.start.value)} по ${fmt(f.end.value)} включительно.`:'Без ограничения по сроку.'} ${f.limited.checked?`Не более ${f.limit.value} применений всего.`:'Без общего лимита применений.'}${f.once.checked?' Один раз на покупателя.':''}`;
  if(!form.checkValidity()){const invalid=form.querySelector(':invalid');result.className='promo-pro-result blocked';result.textContent=`Проверьте поле «${invalid.closest('label')?.childNodes[0]?.textContent?.trim()||'Значение'}»: ${invalid.validationMessage}`;summary.textContent='Проверьте заполнение полей — условия пока не готовы.';return;}
  if(f.scheduled.checked&&f.start.value>f.end.value){result.className='promo-pro-result blocked';result.textContent='Дата окончания должна быть не раньше даты начала.';summary.textContent='Исправьте даты акции.';return;}
  const reasons=[];
  if(f.scheduled.checked&&f.date.value<f.start.value)reasons.push('Акция ещё не началась');
  if(f.scheduled.checked&&f.date.value>f.end.value)reasons.push('Срок действия закончился');
  if(f.hasMinimum.checked&&+f.amount.value<+f.minimum.value)reasons.push(`До минимальной суммы не хватает ${rub(+f.minimum.value-+f.amount.value)}`);
  if(f.limited.checked&&+f.used.value>=+f.limit.value)reasons.push('Лимит использований исчерпан');
  if(f.once.checked&&f.returning.checked)reasons.push('Покупатель уже использовал этот промокод');
  if(f.category.value!=='all'&&f.category.value!==f.productCategory.value)reasons.push('Товар не участвует в акции');
  result.className=`promo-pro-result ${reasons.length?'blocked':'allowed'}`;
  const context=`<p class="pro-test-context">${{trees:'Ёлка',thuja:'Туя',decor:'Декор'}[f.productCategory.value]} · ${rub(+f.amount.value)} · ${fmt(f.date.value)}</p>`;
  result.innerHTML=context+(reasons.length?`<strong>${pict('circleX')}Промокод не применится</strong><ul>${reasons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:`<strong>${pict('circleCheck')}Скидка применится</strong><div class="promo-pro-total"><span>Скидка 10%<b>−${rub(Math.round(+f.amount.value*.1))}</b></span><span>К оплате<b>${rub(+f.amount.value-Math.round(+f.amount.value*.1))}</b></span></div>`);
 }
 form.addEventListener('submit',ev=>ev.preventDefault());form.addEventListener('input',preview);form.addEventListener('change',preview);
 const reset=()=>{form.reset();form.querySelector('details').open=false;preview();};
 const open=()=>{reset();dialog.showModal();dialog.querySelector('.promo-pro-scroll').scrollTop=0;};
 dialog.querySelector('.pro-demo-reset').onclick=reset;
 banner.querySelector('button').onclick=open;entry.querySelector('button').onclick=open;
 dialog.querySelector('#promo-pro-close').onclick=()=>dialog.close();
})();
