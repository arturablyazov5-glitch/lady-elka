import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
const root = resolve(process.argv.find(a => a.startsWith('--root='))?.slice(7) || 'storefront/dist');
const evidenceDir = resolve('agent-context/legal-documents');
await mkdir(evidenceDir, { recursive: true });
let playwright = process.env.PLAYWRIGHT_MODULE;
if (!playwright) for (const cache of await readdir(join(homedir(), '.npm/_npx'))) {
  const candidate = join(homedir(), '.npm/_npx', cache, 'node_modules/playwright/index.mjs');
  try { await readFile(candidate); playwright=candidate; break; } catch {}
}
if (!playwright) throw new Error('Playwright is required; set PLAYWRIGHT_MODULE');
const { chromium } = await import(pathToFileURL(playwright));
const server = spawn(process.execPath, ['storefront/server.mjs', '--mode=preview', `--root=${root}`], { env: { ...process.env, STOREFRONT_PORT: '0' }, stdio: ['ignore','pipe','pipe'] });
const origin = await new Promise((yes,no) => { let text=''; server.stdout.on('data', b => { text+=b; const m=text.match(/localhost:(\d+)/); if(m)yes('http://127.0.0.1:'+m[1]); }); server.once('exit', code => no(Error('Server exit '+code))); });
const evidence = { upstream: [], local: [], documents: [], links: [], screenshots: [] };
const run = promisify(execFile);
let browser;
try {
  for (const route of ['/person','/privacy','/oferta']) {
    for (const base of ['https://lady-elka.ru',origin]) {
      const { stdout } = await run('curl',['-sSI','--max-time','30','-o','/dev/null','-w','%{http_code}',base+route]);
      const status=Number(stdout); assert.equal(status,base===origin?200:route==='/person'?404:200);
      evidence[base===origin?'local':'upstream'].push({route,status,method:'HEAD'});
    }
  }
  browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true });
  const context=await browser.newContext({ viewport:{width:390,height:844},deviceScaleFactor:1 });
  await context.route('**/*', route => {
    const u=route.request().url();
    if (!['GET','HEAD'].includes(route.request().method()) || /mc\.yandex\.ru|yandex\.ru\/ads/.test(u)) return route.abort();
    if (u.startsWith('http://127.0.0.1:') && !u.startsWith(origin)) return route.abort();
    return route.continue();
  });
  const page=await context.newPage();
  async function open(url) {
    const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{}); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700);
    return response;
  }
  async function documentData() {
    return page.evaluate(() => {
      const body=document.querySelector('.tt-rich-text');
      const first=body?.querySelector('p');
      const h=document.querySelector('#i6r9fw1g2_0, #imro0g6q3_0');
      const box=el => { const b=el.getBoundingClientRect(),s=getComputedStyle(el); return { x:b.x,y:b.y,width:b.width,height:b.height,font:s.fontFamily,size:s.fontSize,line:s.lineHeight,color:s.color,weight:s.fontWeight }; };
      return {text:body?.innerText,html:body?.innerHTML,body:body&&box(body),paragraph:first&&box(first),heading:h&&box(h),title:document.title,robots:document.querySelector('meta[name=robots]')?.content,breadcrumb:document.querySelector('.bread__crumbs')?.innerText };
    });
  }
  for (const width of [390,1280]) {
    await page.setViewportSize({width,height:844});
    for (const route of ['/privacy','/oferta']) {
      await open('https://lady-elka.ru'+route); const original=await documentData();
      const originalFile=`${route.slice(1)}-original-${width}.png`;
      await page.screenshot({path:join(evidenceDir,originalFile),fullPage:true});
      await open(origin+route); const local=await documentData();
      const localFile=`${route.slice(1)}-local-${width}.png`;
      await page.screenshot({path:join(evidenceDir,localFile),fullPage:true});
      assert.equal(local.text,original.text,route+' legal text');
      // Original home links now resolve within the migrated storefront.
      assert.equal(local.html,original.html.replace(/href="https?:\/\/(?:www\.)?lady-elka\.(?:ru|ry)\/?"/g,'href="/"'),route+' document markup');
      for (const part of ['body','paragraph','heading']) {
        for(const key of ['x','y','width','height']) assert.ok(Math.abs(local[part][key]-original[part][key])<2, `${route} ${width} ${part}.${key}: ${local[part][key]} vs ${original[part][key]}`);
        for(const key of ['font','size','line','color','weight'])assert.equal(local[part][key],original[part][key],`${route} ${width} ${part}.${key}`);
      }
      evidence.documents.push({route,width,exactText:true,exactMarkupWithLocalHomeLinks:true,original: {body:original.body,paragraph:original.paragraph,heading:original.heading},local: {body:local.body,paragraph:local.paragraph,heading:local.heading}});
      evidence.screenshots.push(originalFile,localFile);
    }
    await open(origin+'/person'); const placeholder=await documentData();
    assert.match(placeholder.text,/Документ пока не опубликован/);assert.doesNotMatch(placeholder.text,/Оператор|152-ФЗ/);
    assert.match(placeholder.breadcrumb,/Согласие на обработку персональных данных/);assert.equal(placeholder.robots,'noindex, follow');
    assert.ok(placeholder.body.x>=0 && placeholder.body.x+placeholder.body.width<=width);
    const file=`person-local-${width}.png`;await page.screenshot({path:join(evidenceDir,file),fullPage:true});evidence.screenshots.push(file);
  }
  // Verify every legal href/data-url in every generated page, including shared checkout and footer.
  const targets=new Set();let count=0;
  async function scan(dir) {
    for(const e of await readdir(dir,{withFileTypes:true})) {
      const path=join(dir,e.name);if(e.isDirectory())await scan(path);
      else if(e.name.endsWith('.html')) {
        const html=await readFile(path,'utf8');
        for(const m of html.matchAll(/\b(?:href|data-url)=['"](\/(?:person|privacy|oferta))['"]/g)) { targets.add(m[1]);count++; }
      }
    }
  }
  await scan(root); assert.deepEqual([...targets].sort(),['/oferta','/person','/privacy']);
  for(const route of targets)assert.equal((await fetch(origin+route,{method:'HEAD'})).status,200);
  evidence.allLegalLinks={count,targets:[...targets],status:200};
  // Match each original form's legal destinations; source ownership changes field mechanics, not document URLs.
  for(const route of ['/','/decor','/o-nas','/tree/miranda']) {
    const links=()=>page.evaluate(()=>[...document.querySelectorAll('form')].map(f=>({id:f.id,links:[...f.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(h=>/^\/(person|privacy|oferta)$/.test(h))})).filter(f=>f.links.length));
    await open('https://lady-elka.ru'+route);const original=await links();
    await open(origin+route);const local=await links();
    for(const f of original)assert.deepEqual(local.find(l=>l.id===f.id)?.links,f.links,route+' '+f.id);
    evidence.links.push({route,forms:original,originalDestinationsPreserved:true});
  }
  await open(origin+'/');
  const footerLink=page.locator('footer [href="/privacy"]').first();await footerLink.scrollIntoViewIfNeeded();
  await Promise.all([page.waitForURL(origin+'/privacy'),footerLink.click()]);assert.equal(new URL(page.url()).pathname,'/privacy');
  evidence.footerPrivacyClick=true;
  const sitemap=await readFile(join(root,'sitemap.xml'),'utf8');
  assert.match(sitemap,/https:\/\/lady-elka.ru\/privacy</);assert.match(sitemap,/https:\/\/lady-elka.ru\/oferta</);assert.doesNotMatch(sitemap,/https:\/\/lady-elka.ru\/person</);
  evidence.sitemap={privacy:true,oferta:true,person:'noindex placeholder, excluded'};
  await writeFile(join(evidenceDir,'checks.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({documents:evidence.documents.length,head:evidence.local,links:evidence.allLegalLinks,footerPrivacyClick:true}));
} finally { await browser?.close();server.kill(); }
