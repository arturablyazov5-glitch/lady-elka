# Админка блога: публикация и откат (не выполнены)

## Граница и текущий барьер

Локальный remote — `https://github.com/arturablyazov5-glitch/lady-elka.git`, ветка `main`, HEAD `40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9`. Это локальная информация на 2026-10-03, **не подтверждение текущего GitHub/Pages SHA**. Dirty tree содержит параллельные изменения.

`.github/workflows/pages.yml:4-6`: любой push в main (без paths filter) и ручной workflow_dispatch запускают публикацию. `:9-11` — contents:read, pages:write, id-token:write; `:19-21` — environment github-pages; `:24-36` — checkout выбранного Git ref, копирование **всего** app/public, upload site, deploy Pages. `:14-15` — общая concurrency group pages с отменой прежнего run. Это замена всего Pages artifact репозитория, а не отдельный deploy вкладки блога. В локальной папке workflow других release jobs нет; удалённые настройки Pages, environment approvals, другие ветки и текущая публикация не проверены.

Нельзя обещать сохранность иного контента, если нынешний Pages artifact содержит не только эту админку: `pages.yml:29,33` выкладывает только app/public и не объединяет его с прежним artifact/storefront. До разрешения публикации установить действующий Pages URL, последний успешный deployment/run SHA и сохранить его rollback baseline. Если Pages обслуживает иной release, **STOP**: требуется отдельное согласование назначения/hosting; этот workflow изоляцию не обеспечивает.

Текущий проверенный release содержит также изменённые payment.css/index/app.js и **не безопасен для публикации только блога**. `app/public/js/app.js:74` совмещает blog navigation и payment-success в одном изменённом участке; связанные payment изменения — `app/public/index.html:93` (payment-success-page) и `app/public/css/payment.css:757` (payment-success-active и последующие стили). `app/public/index.html:5,8,15-22,147` подключает blog CSS/навигацию/form/dialog/modules и содержит другие параллельные правки. Простое добавление этих файлов целиком выпустит и чужие изменения. Подтверждённый опубликованный baseline локально **не известен**: HEAD/origin/main не доказывают deployment. Поэтому точный «только блог» snapshot пока **не подготовлен**: требуется отдельно разрешённая подготовка изолированного candidate от подтверждённого baseline, с переносом только blog sections/navigation и проверкой diff. Новый snapshot/patch в этой задаче не создаётся. Основной dirty tree не трогать, не применять full git add, reset/clean.

## Локальный preflight и artifact

В корне проекта (все эти команды безопасны без разрешения на публикацию):

```sh
git status --short
git remote -v
git branch --show-current
git rev-parse HEAD
git diff -- app/public/index.html app/public/js/app.js app/public/css/payment.css
git ls-files --others --exclude-standard app/public
node --test integration-qa/admin-release/assembler.test.mjs
node scripts/build-admin-release.mjs /private/tmp/lady-elka-admin-candidate-01
node integration-qa/admin-release/browser-qa.mjs /private/tmp/lady-elka-admin-candidate-01
```

Выбрать **новый** внешний абсолютный output (существующий не перезаписывается; /tmp symlink запрещён). Assembler доказывает точный набор app/public и SHA-256, отсутствие unsafe symlink/запрещённых путей, неизменность source/workflow во время сборки, соответствие workflow copy/upload. Browser QA доказывает доступность index/modules/CSS, toolbar/preview и canonical structured draft save+reload **с mock API до navigation**, не live auth/Edge. Общий suite не нужен. Результат — site/, manifest.json, source-snapshot.json; QA report/screenshot рядом, вне site. Этот artifact текущего dirty tree пока не является approved blog-only release.

Git snapshot кандидата обязан содержать: app/public/index.html (blog sections/dialog, CSS и module imports), app/public/js/app.js (blog navigation), app/public/css/blog.css, app/public/js/blog.js, blog-rich-editor.js, blog-model.js; все остальные public зависимости из baseline; неизменный .github/workflows/pages.yml. Новый blog.js использует уже существующий каталоговый HMAC sessionStorage token (`blog.js:10`); новый login/server не нужен. app/server/blog-edge, SQL, env, app/blog-content, storefront и Supabase catalog/pay **не входят** в frontend публикацию. QA scripts/manifest должны быть сохранены для проверки; workflow сам их не исполняет и не публикует. Git snapshot модель/frontend не доказывает parity уже развёрнутой Edge function.

После отдельно разрешённого создания candidate commit, обозначить его полный SHA как ADMIN_RELEASE_SHA, проверить diff от baseline и **побайтное соответствие Git snapshot manifest** (не только наличие файлов). Из корня, с путём к artifact:

```sh
export ADMIN_RELEASE_SHA='ВСТАВИТЬ_ПРОВЕРЕННЫЙ_40_HEX_SHA'
export ADMIN_ARTIFACT='/private/tmp/lady-elka-admin-candidate-01'
git diff --name-status BASELINE_SHA "$ADMIN_RELEASE_SHA"
node --input-type=module <<'JS'
import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; import {createHash} from 'node:crypto'; import assert from 'node:assert/strict';
const sha=process.env.ADMIN_RELEASE_SHA; assert.match(sha,/^[0-9a-f]{40}$/);
const m=JSON.parse(fs.readFileSync(process.env.ADMIN_ARTIFACT+'/manifest.json'));
const names=execFileSync('git',['ls-tree','-r','--name-only',sha,'--','app/public'],{encoding:'utf8'}).trim().split('\n').map(s=>s.slice('app/public/'.length)).sort();
assert.deepEqual(names,m.files.map(f=>f.path).sort());
for(const f of m.files){const b=execFileSync('git',['show',sha+':app/public/'+f.path]); assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256,f.path);}
const s=JSON.parse(fs.readFileSync(process.env.ADMIN_ARTIFACT+'/source-snapshot.json'));
assert.equal(createHash('sha256').update(execFileSync('git',['show',sha+':.github/workflows/pages.yml'])).digest('hex'),s.workflow.sha256);
console.log('Git snapshot equals reviewed artifact');
JS
```

BASELINE_SHA — полный заранее подтверждённый rollback SHA (заменить placeholder). Если candidate отличается от текущего source, собрать/проверить artifact **из его отдельного checkout**; текущий artifact переносить на иной SHA нельзя. Перед финальным push проверить, что main содержит только согласованные commit относительно актуальной удалённой main; старый локальный origin/main не служит такой проверкой. Обновление remote refs/подготовка commit в этой задаче не выполнялись.

**Последняя точка перед действием:** предъявить пользователю candidate SHA, diff, manifest, browser report, Pages destination и rollback baseline; получить явное разрешение на push этого SHA в main и замену Pages artifact. Только после разрешения выполнить обычный fast-forward `git push origin "$ADMIN_RELEASE_SHA":refs/heads/main` из подготовленного checkout. Не force push. Если отказ из-за изменения main — остановиться, обновить baseline/candidate и заново проверить. Ручной workflow_dispatch/re-run тоже публикует и требует разрешения; не запускать его дополнительно к push без причины.

## Подтверждение после разрешённого push

В Actions открыть конкретный `Deploy app to GitHub Pages` run, убедиться: head SHA равен ADMIN_RELEASE_SHA, deploy conclusion=success, environment URL соответствует согласованному назначению; сохранить run URL/id и deployment evidence. Для будущей read-only сверки: `gh run view RUN_ID --repo arturablyazov5-glitch/lady-elka --json headSha,status,conclusion,url,workflowName`. Сейчас сетевые GitHub действия не выполнялись. Сам Pages не публикует SHA/manifest (`pages.yml:29`), поэтому run SHA без сверки байтов недостаточен.

Для будущей проверки всех доступных public файлов (после публикации; сейчас не запускать):

```sh
export ADMIN_PAGES_URL='https://arturablyazov5-glitch.github.io/lady-elka/'
node --input-type=module <<'JS'
import fs from 'node:fs'; import {createHash} from 'node:crypto'; import assert from 'node:assert/strict';
const m=JSON.parse(fs.readFileSync(process.env.ADMIN_ARTIFACT+'/manifest.json'));
for(const f of m.files){const u=new URL(f.path,process.env.ADMIN_PAGES_URL);u.searchParams.set('release-check',process.env.ADMIN_RELEASE_SHA);const r=await fetch(u,{cache:'no-store',redirect:'error'});assert.equal(r.status,200,f.path);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),f.sha256,f.path);}
console.log('Pages bytes equal approved release manifest');
JS
```

В настоящем браузере открыть согласованный Pages URL с #blog, reload без cache: убедиться в наличии editor/toolbar, Network 200 для js/blog.js, js/blog-rich-editor.js, js/blog-model.js, css/blog.css, отсутствии missing-module/404/pageErrors. Не сохранять HAR/Authorization. Hash equality проверяет доступные байты manifest, не отсутствие всех лишних старых URL. Не утверждать опубликованным до успешных run+HTTP+browser проверок.

## Live draft и cleanup

Требуется настоящая сессия обычного входа в **ту же удалённую вкладку**, разрешённый Origin и существующий HMAC каталога. Localhost cookie/mock не подходит; live CRUD пока не подтверждён. По `audit/blog-live-acceptance.md` вставить runner.mjs (без export) и admin-ui-snippet.js в Console авторизованной вкладки; token/секреты не читать, не выводить и не сохранять. Runner делает только отдельный draft: POST → независимый GET → PUT с revision → независимый GET, проверяет отсутствие id/slug в /published и /export, затем DELETE с текущей revision и независимый GET отсутствия. Успех: mode=live, passed=true, liveVerified=true, cleanup=confirmed-deleted.

Если cleanup=UNCONFIRMED, остановить приёмку; по id/slug/title отчёта найти **только свой** QA draft, удалить обычным admin UI после подтверждения и проверить refreshed list. При потере сессии обычный вход; не обходить через SQL/secrets. Никогда не публиковать тестовую статью/трогать чужие записи. Авторизацию на синтетический live draft workflow подтвердить для конкретного запуска; frontend push не означает публикацию статей.

## Откат frontend

**До release** зафиксировать действующий успешный Pages run ID, его полный head SHA, manifest/проверенный artifact и destination. Локальный HEAD выше не считать rollback baseline без live проверки. Для отката получить отдельное разрешение на повторную замену Pages artifact. Самый короткий путь при доступном старом run: в Actions выбрать именно сохранённый успешный run и Re-run all jobs; он должен checkout исходный SHA этого run. До/после убедиться в правильном head SHA и destination, отсутствии более нового конкурирующего deployment; затем повторить HTTP hash/browser проверки по **baseline** manifest. Ручной dispatch текущей main не откатывает на старый SHA.

Если старый run нельзя повторить, подготовить в отдельном checkout новый reviewed rollback commit от актуальной main, восстановив **только app/public** из заранее подтверждённого SHA/проверенного artifact; проверить diff, rollback manifest и браузер, затем отдельное разрешение на обычный push. Это откат всей админки, включая public catalog/payment UI, поэтому перечислить последствия baseline; серверные catalog/pay не изменяются. Текущий workflow не умеет деплоить произвольный сохранённый artifact напрямую (`pages.yml:24-33`): если доступен только artifact, требуется отдельно согласованный механизм deployment либо его перенос в candidate app/public и reviewed commit. Не подменять такой откат запуском main.

Откат не удаляет le_blog_posts, не откатывает данные статей/Edge, не выполняет SQL/migrations, не меняет catalog/pay/buckets/secrets. Draft cleanup — отдельная собственная запись, не удаление таблицы. Чужой dirty tree остаётся нетронутым на всём пути.
