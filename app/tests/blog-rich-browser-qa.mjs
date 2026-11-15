// Offline browser QA; uses the desktop bundled Playwright and installed Chrome.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'/Users/rafael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
const root=fileURLToPath(new URL('../../',import.meta.url)),base='http://127.0.0.1:4189';
const dir=await fs.mkdtemp('/tmp/elka-blog-browser-');
const server=spawn(process.execPath,['--import','./app/tests/blog-offline-preload.mjs','app/server/index.mjs'],{cwd:root,env:{...process.env,PORT:'4189',HOST:'127.0.0.1',BLOG_CONTENT_FILE:dir+'/posts.json',CATALOG_ADMIN_PASSWORD:'offline-qa-password'},stdio:'pipe'});
let browser;
try{
 for(let i=0;i<80;i++){try{if((await fetch(base+'/app')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const headers={'Content-Type':'application/json','X-Catalog-Request':'1',Origin:base};
 const input={title:'QA',slug:'qa',excerpt:'a',text:'b',cover:'',alt:'',seoTitle:'',seoDescription:'',status:'draft'};
 if((await fetch(base+'/api/blog')).status!==401)throw Error('auth');
 if((await fetch(base+'/api/blog',{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify(input)})).status!==403)throw Error('origin');
 const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:'offline-qa-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 if((await fetch(base+'/api/blog/../../bad',{method:'PUT',headers:{...headers,Cookie:cookie},body:'{}'})).status===200)throw Error('traversal');
 browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});const context=await browser.newContext({viewport:{width:1440,height:1100}});
 await context.addCookies([{name:'le_session',value:cookie.split('=')[1],url:base}]);
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();if(url.pathname==='/api/catalog')return route.fulfill({json:{products:[],settings:{revision:1,types:[],discount_pct:0,adjustment_pct:0},origin:base}});if(url.pathname.startsWith('/api/billing/'))return route.fulfill({json:{}});return route.continue();});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/app#blog');await page.getByRole('button',{name:'Пропустить',exact:true}).click();

 await page.getByText('Добавить статью',{exact:true}).click();await page.locator('#blog-form [name="title"]').fill('Визуальный редактор');await page.locator('#blog-form [name="slug"]').fill('visual-editor-qa');await page.locator('#blog-form [name="excerpt"]').fill('Проверка форматирования');
 const editor=page.locator('#blog-rich-editor');await editor.fill('Красивый текст статьи');
 const select=async(start,end)=>page.evaluate(({start,end})=>{const el=document.getElementById('blog-rich-editor');const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);let offset=0,a,b;for(const n of nodes){const len=n.textContent.length;if(!a&&start<=offset+len)a=[n,start-offset];if(!b&&end<=offset+len)b=[n,end-offset];offset+=len;}const r=document.createRange();r.setStart(...a);r.setEnd(...b);const selection=getSelection();selection.removeAllRanges();selection.addRange(r);el.focus();},{start,end});
 await select(0,8);await page.locator('[data-rich="bold"]').click();if(!await editor.locator('b,strong').count())throw Error('bold selection');
 await page.keyboard.press('Meta+i');if(!await editor.locator('i,em').count())throw Error('italic shortcut');
 await page.locator('[data-rich="link"]').click();await page.locator('#blog-link-url').fill('javascript:alert(1)');await page.getByRole('button',{name:'Добавить ссылку',exact:true}).click();await page.getByText('Введите полный адрес https://…, http://… или mailto:name@example.com',{exact:true}).waitFor();await page.locator('#blog-link-url').fill('https://example.com/article');await page.getByRole('button',{name:'Добавить ссылку',exact:true}).click();if(!await editor.locator('a[href="https://example.com/article"]').count())throw Error('link');
 await page.locator('[data-rich="unlink"]').click();if(await editor.locator('a').count())throw Error('unlink');
 await page.locator('[data-rich="heading2"]').click();if(!await editor.locator('h2').count())throw Error('heading');
 await page.locator('[data-rich="undo"]').click();await page.locator('[data-rich="redo"]').click();if(!await editor.locator('h2').count())throw Error('redo');
 await editor.click();await page.keyboard.press('Meta+End');await page.keyboard.press('Enter');await page.keyboard.type('Первый пункт');await page.locator('[data-rich="insertUnorderedList"]').click();if(!await editor.locator('ul').count())throw Error('bullet list');await page.locator('[data-rich="insertOrderedList"]').click();if(!await editor.locator('ol').count())throw Error('numbered list');
 await editor.click();await page.keyboard.press('Meta+End');await page.keyboard.press('Enter');
 await page.evaluate(()=>{const data=new DataTransfer();data.setData('text/html','<p><strong>Вставленный жирный</strong> <em>курсив</em><script>window.pasteXss=1</script><img src="https://evil.invalid/x" onerror="window.pasteXss=1"><a href="javascript:alert(1)">опасная ссылка</a></p>');data.setData('text/plain','fallback');document.getElementById('blog-rich-editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
 if(await editor.locator('img,script,[onerror],a[href^="javascript:"]').count()||await page.evaluate(()=>window.pasteXss))throw Error('paste XSS');if(!await editor.locator('strong').count())throw Error('formatted paste');
 await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Статья сохранена локально. Сайт не изменён.',{exact:true}).waitFor();const stored=JSON.parse(await fs.readFile(dir+'/posts.json','utf8')).posts[0];if(stored.contentFormat!=='le-richtext-v1')throw Error('rich persist');
 await page.reload();await page.getByRole('button',{name:'Редактировать',exact:true}).click();if(!await editor.locator('strong').count()||!await editor.locator('h2').count())throw Error('rich reload');if(!await page.locator('#blog-preview strong').count())throw Error('rich preview');await page.screenshot({path:root+'/audit/admin-blog-rich-editor.png',fullPage:true});await page.locator('.blog-wide').screenshot({path:root+'/audit/admin-blog-rich-toolbar.png'});
 await page.setViewportSize({width:390,height:844});await select(0,8);await page.locator('[data-rich="bold"]').click();const touch=await page.locator('[data-rich="bold"]').boundingBox();if(touch.width<44||touch.height<44)throw Error('mobile toolbar/legacy exact CRLF roundtrip');await page.screenshot({path:root+'/audit/admin-blog-rich-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Статья сохранена локально. Сайт не изменён.',{exact:true}).waitFor();
 const legacyText='  Старый текст\r\n\r\nВторая строка\n ';
 const legacyResponse=await fetch(base+'/api/blog',{method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify({...input,title:'Legacy exact',slug:'legacy-exact',text:legacyText})});if(legacyResponse.status!==201)throw Error('legacy create');await page.reload();await page.locator('.blog-row').filter({hasText:'Legacy exact'}).getByRole('button',{name:'Редактировать',exact:true}).click();await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Статья сохранена локально. Сайт не изменён.',{exact:true}).waitFor();const legacyPost=JSON.parse(await fs.readFile(dir+'/posts.json','utf8')).posts.find(p=>p.slug==='legacy-exact');if(legacyPost.text!==legacyText)throw Error('legacy text loss: '+JSON.stringify(legacyPost.text));
 console.log(JSON.stringify({browser:'selection bold/italic/heading/list/link safety/removal/undo/redo/formatted paste XSS/rich reload/preview/mobile toolbar/legacy exact CRLF roundtrip',pageErrors:errors,format:stored.contentFormat}));
}finally{await browser?.close();server.kill();await fs.rm(dir,{recursive:true,force:true});}
