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
 await page.getByText('Добавить статью',{exact:true}).click();
 for(const [name,value] of Object.entries({...input,title:'Проверка сохранения',slug:'offline-check',text:'<img src=x onerror=alert(1)>\n\nБезопасный текст.'})){const field=page.locator('#blog-form').locator(`[name="${name}"]`);if(name==='status')await field.selectOption(value);else if(name==='text')await page.locator('#blog-rich-editor').fill(value);else await field.fill(value);}
 await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Статья сохранена локально. Сайт не изменён.',{exact:true}).waitFor();
 if(await page.locator('#blog-preview img').count())throw Error('XSS preview');await page.screenshot({path:root+'/audit/admin-blog-editor.png',fullPage:true});
 await page.reload();await page.getByRole('button',{name:'Редактировать',exact:true}).click();const reloadedText=await page.evaluate(async()=>{const {documentFromDOM}=await import('/js/blog-rich-editor.js'),{contentText}=await import('/js/blog-model.js');return contentText(documentFromDOM(document.getElementById('blog-rich-editor')));});if(reloadedText!== '<img src=x onerror=alert(1)>\n\nБезопасный текст.')throw Error('reload persistence '+JSON.stringify(reloadedText));
 await page.locator('#blog-form [name="status"]').selectOption('published');await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Статья сохранена локально. Сайт не изменён.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'В архив',exact:true}).click();await page.locator('#blog-list').getByText('Архив',{exact:true}).waitFor();await page.getByRole('button',{name:'Закрыть',exact:true}).click();
 await page.locator('.side-tabs [data-nav="catalog"]').click();await page.locator('.side-tabs [data-nav="blog"]').click();await page.getByRole('button',{name:'Редактировать',exact:true}).waitFor();await page.screenshot({path:root+'/audit/admin-blog-list.png',fullPage:true});
 await page.locator('#blog-search').fill('не-существует');await page.getByText('Статьи не найдены. Создайте статью или измените фильтр.',{exact:true}).waitFor();await page.locator('#blog-search').fill('');
 await page.getByRole('button',{name:'Редактировать',exact:true}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Удалить',exact:true}).click();await page.getByRole('button',{name:'Редактировать',exact:true}).waitFor({state:'detached'});

 console.log(JSON.stringify({api:'auth 401, foreign origin 403, traversal rejected',browser:'create/save/reload/edit/publish/archive/search/delete/navigation/plain-text XSS verified',pageErrors:errors,storage:JSON.parse(await fs.readFile(dir+'/posts.json','utf8')).posts.length}));
}finally{await browser?.close();server.kill();await fs.rm(dir,{recursive:true,force:true});}
