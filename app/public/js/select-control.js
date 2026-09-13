(function(){
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 window.selectControl=({id,label='',ariaLabel='',options=[],value='',required=false,className=''})=>`<label class="select-control ${esc(className)}">${label?`<span>${esc(label)}</span>`:''}<select id="${esc(id)}" class="select-control-field"${ariaLabel?` aria-label="${esc(ariaLabel)}"`:''}${required?' required':''}>${options.map(option=>`<option value="${esc(option.value)}"${option.value===value?' selected':''}>${esc(option.label)}</option>`).join('')}</select></label>`;
 document.querySelectorAll('select').forEach(select=>select.classList.add('select-control-field'));
})();
