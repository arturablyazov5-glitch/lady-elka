import {validateContent,legacyContent,contentHTML,safeLink} from './blog-model.js';
const blockTags=new Set(['P','DIV','H1','H2','H3','H4','H5','H6','UL','OL','BLOCKQUOTE']);
export function documentFromDOM(root){
 const runs=node=>{if(node.childNodes.length===1&&node.firstChild.nodeType===1&&node.firstChild.tagName==='BR')return [];const out=[];const walk=(n,marks={})=>{
  if(n.nodeType===3){if(n.nodeValue)out.push({text:n.nodeValue,...marks});return;}
  if(n.nodeType!==1)return;const tag=n.tagName.toUpperCase();
  if(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','IMG','VIDEO','AUDIO','INPUT','BUTTON','FORM'].includes(tag))return;
  if(tag==='BR'){out.push({text:'\n',...marks});return;}
  const next={...marks};if(['B','STRONG'].includes(tag)||/^(bold|[6-9]00)$/.test(n.style.fontWeight))next.bold=true;
  if(['I','EM'].includes(tag)||n.style.fontStyle==='italic')next.italic=true;
  if(tag==='A'&&safeLink(n.getAttribute('href')))next.href=n.getAttribute('href');
  for(const child of n.childNodes)walk(child,next);
 };for(const n of node.childNodes)walk(n);return out;};
 const blocks=[];let pending=[];
 const flush=()=>{if(pending.length){const wrapper=document.createElement('div');pending.forEach(n=>wrapper.append(n.cloneNode(true)));blocks.push({type:'paragraph',runs:runs(wrapper)});pending=[];}};
 const visit=node=>{
  if(node.nodeType===1&&['UL','OL'].includes(node.tagName)){flush();const items=[...node.children].filter(n=>n.tagName==='LI').map(runs);if(items.length)blocks.push({type:node.tagName==='UL'?'bulletList':'orderedList',items});}
  else if(node.nodeType===1&&blockTags.has(node.tagName)){flush();if([...node.children].some(n=>blockTags.has(n.tagName))){for(const c of node.childNodes)visit(c);flush();}else blocks.push({type:node.tagName==='H2'?'heading2':/^H[1-6]$/.test(node.tagName)?'heading3':'paragraph',runs:runs(node)});}
  else pending.push(node);
 };
 for(const n of root.childNodes)visit(n);flush();return validateContent({version:1,blocks});
}
export function createRichEditor(editor,toolbar,onChange){
 let selection=null;
 const range=()=>{const s=window.getSelection();return s?.rangeCount&&editor.contains(s.anchorNode)&&editor.contains(s.focusNode)?s.getRangeAt(0):null;};
 const remember=()=>{const r=range();if(r)selection=r.cloneRange();};
 const restore=()=>{editor.focus();if(selection&&editor.contains(selection.commonAncestorContainer)){const s=window.getSelection();s.removeAllRanges();s.addRange(selection);}};
 const update=()=>{remember();for(const b of toolbar.querySelectorAll('[aria-pressed]'))b.setAttribute('aria-pressed',String(document.queryCommandState(b.dataset.rich)));};
 document.addEventListener('selectionchange',update);editor.addEventListener('focus',()=>document.execCommand('defaultParagraphSeparator',false,'p'));
 const command=(name,value)=>{restore();document.execCommand(name,false,value);remember();onChange();update();};
 toolbar.addEventListener('mousedown',e=>{if(e.target.closest('button'))e.preventDefault();});
 toolbar.addEventListener('click',e=>{const b=e.target.closest('[data-rich]');if(!b)return;const action=b.dataset.rich;if(action==='link'){remember();const r=range()||selection;if(!r||r.collapsed){onChange('Выделите текст для ссылки');return;}let n=r.startContainer.nodeType===3?r.startContainer.parentElement:r.startContainer;const a=n.closest?.('a');document.getElementById('blog-link-url').value=a?.getAttribute('href')||'';document.getElementById('blog-link-error').textContent='';document.getElementById('blog-link-dialog').showModal();document.getElementById('blog-link-url').focus();return;}if(['paragraph','heading2','heading3'].includes(action))command('formatBlock',{paragraph:'p',heading2:'h2',heading3:'h3'}[action]);else command(action);});
 const dialog=document.getElementById('blog-link-dialog');document.getElementById('blog-link-cancel').onclick=()=>{dialog.close();restore();};
 document.getElementById('blog-link-form').onsubmit=e=>{e.preventDefault();const url=document.getElementById('blog-link-url').value.trim();if(!safeLink(url)){document.getElementById('blog-link-error').textContent='Введите полный адрес https://…, http://… или mailto:name@example.com';return;}dialog.close();command('createLink',url);};
 editor.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();});
 editor.addEventListener('input',()=>{remember();onChange();});
 editor.addEventListener('keydown',e=>{if(!(e.metaKey||e.ctrlKey)||e.altKey)return;const k=e.key.toLowerCase();if(['b','i'].includes(k)){e.preventDefault();command(k==='b'?'bold':'italic');}else if(k==='z'){e.preventDefault();command(e.shiftKey?'redo':'undo');}else if(k==='y'){e.preventDefault();command('redo');}});
 editor.addEventListener('paste',e=>{e.preventDefault();remember();try{const html=e.clipboardData.getData('text/html'),text=e.clipboardData.getData('text/plain');let doc;if(html){const parsed=new DOMParser().parseFromString(html,'text/html');doc=documentFromDOM(parsed.body);}else doc=legacyContent(text);command('insertHTML',contentHTML(doc));}catch{onChange('Не удалось вставить текст: слишком большой или неподдерживаемый формат.');}});
 editor.addEventListener('drop',e=>e.preventDefault());
 return {get:()=>documentFromDOM(editor),set:(post)=>{const doc=post?.content?validateContent(post.content):legacyContent(post?.text||'');editor.innerHTML=contentHTML(doc);selection=null;},render:(target,doc)=>{target.innerHTML=contentHTML(doc);}};
}
