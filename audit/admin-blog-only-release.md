# Blog-only candidate — 2026-10-04

Подготовлен **локальный, неопубликованный** candidate от подтверждённого Pages baseline `40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9` (evidence: audit/admin-published-baseline.md). Current dirty app/public/index.html и app.js целиком не копируются. Исходники app/public, workflow/package, Git refs и чужие изменения не менялись; commit/push/deploy/install, реальные sessions/catalog/pay запросы не выполнялись.

## Команды

Из корня Lady Elka:

```sh
node scripts/build-admin-blog-only-release.mjs /private/tmp/lady-elka-blog-only-20261004-02
node --test integration-qa/admin-blog-only/assembler.test.mjs
node integration-qa/admin-blog-only/browser-qa.mjs /private/tmp/lady-elka-blog-only-20261004-02
```

Для повторной сборки выбрать **новый** абсолютный внешний output: существующий не перезаписывается, symlink ancestor запрещён. Baseline blobs читаются локальным git show exact SHA без fetch; при отсутствии/неожиданном tree сборка останавливается. Reusable assembler/tests/browser harness сохранены в основном каталоге. Output не является единственной копией рецепта изменений.

Проверенный output `/private/tmp/lady-elka-blog-only-20261004-02/`:

- `site/` — 32 release файла.
- `candidate/app/public/` — те же release файлы; `candidate/.github/workflows/pages.yml` — baseline workflow без изменения. Это подготовленные файлы для будущего отдельно разрешённого Git snapshot, **не самостоятельный полный репозиторий и не commit**.
- `baseline/app/public/` и baseline workflow — исходные байты для review.
- `manifest.json` — baseline SHA/blob/SHA-256, hashes release, использованных source/fragments, шесть delta entries, patch hash. JSON детерминирован; текущий app.js вообще не используется как source.
- `baseline-to-blog-only.patch` — reviewable patch с относительными a/baseline и b/candidate путями. SHA-256 `10193fdd24a02423bc5602174fdfec413e89532b29589fe9c686fce03a56d1e3`.
- `browser-report.json`, `browser-editor.png` — локальное browser evidence вне site.

Patch проверен `git apply -p2 --check` и применением `git apply -p2` **только в временной копии baseline**; полученный public tree совпал с site по каждому хешу. В основном dirty tree его не применять. Первый неуспешный временный artifact удалён; финальный artifact — только `...-02`.

## Точная граница изменений

Allowlist: новые `css/blog.css`, `js/blog.js`, `js/blog-model.js`, `js/blog-rich-editor.js`; изменённые `index.html`, `js/app.js`. Других delta нет. Четыре новых ресурса совпадают побайтно с canonical current blog sources.

В baseline index вставлены только извлечённые уникальные blog fragments: stylesheet, sidebar nav, blog section/form/editor/toolbar, link dialog, module script. Удаление этих фрагментов и одного separator newline возвращает **точные baseline bytes всего index** — включая payment/profile DOM, ссылки и script bindings. Extraction отказывает при неоднозначных anchors/fragments или payment-success/pro-ticket внутри blog fragments.

Baseline app.js меняется только в строке navigate: `'blog'` в обоих списках страниц и `blog:'Блог'` в title map. Обратное удаление этих буквальных добавлений возвращает весь baseline app.js побайтно (в том числе `$$` bindings). Никакие current payment-success additions не перенесены. Candidate index SHA-256 `8453fc852c3fcbd17d5bdf0653a764d1142be4ed47adcbb97e02db89f62339ae`; app.js `e565e77832de8b67e4eb2a28230b82264380a3dd2694404c45a5752930c227be`.

**26/28 baseline public файлов полностью неизменны**, включая css/payment.css, js/payment.js, js/profile.js, bank_card.svg/sbp-full.svg и все остальные существующие модули/CSS. Generic baseline payment-success CSS сохранён: payment.css SHA-256 `3a7bce3bee1909e4afb73426ccbbaca6cd6b0104244267c8ee2b4ba97cd2ef9d`. Нет current payment-success-page, payment-success navigation и pro-ticket DOM. Это доказательство сохранения оплаты на уровне исходников/DOM/nav; настоящие транзакции не проверялись и не выполнялись.

## Targeted QA

Assembler tests: **2/2 PASS** — шесть delta files, 26 unchanged hashes, обратное восстановление literal navigation, сохранённый generic payment CSS, отсутствие новых payment additions, детерминированный manifest, patch apply/equality, existing/internal/symlink output отказ и ambiguity отказ. Полный общий suite не запускался.

Browser: **PASS**, установленный headless Google Chrome и уже имеющийся Playwright. Реальный loopback static server обслуживает site с Pages prefix /lady-elka/; тестовый hostname через Chrome host resolver выбирает неизменный remote branch frontend. Route interception + service-worker block до navigation: synthetic catalog с одним товаром, promos и blog; fonts CSS пустой, остальная сеть запрещена. Ни реальный token, ни реальный каталог/платёжные API не использовались.

Проверены каталог с одним synthetic товаром, поиск (1→0→1), переходы каталог→промокоды→настройки→каталог→блог, rich toolbar bold/preview, draft save contentFormat=le-richtext-v1 и reload/reopen с тем же validated structured document/text. Все 32 файла обслужены; pageErrors/requestFailures/httpErrors/notFound/blocked — пустые. Screenshot просмотрен: visual editor/toolbar и bold в preview на месте. Mock draft существует только в памяти harness, browser/server закрыты. При первой browser попытке обнаружено преобразование `$$` в `$` строковым replace; исправлено callback replacement и добавлена проверка обратного соответствия всего app.js. Финальные тесты и browser — PASS.

## Workflow и следующий барьер

Candidate workflow побайтно baseline (`df1e90bdeaf1602a9a38700f117aa7f5979d37ff26a33fc18f2b23fb9818748a`), совместим с существующим `cp -R app/public site` / upload site. **Workflow не берёт внешний output автоматически**: для будущего release нужен отдельно разрешённый Git snapshot с этим candidate app/public, сверка SHA/manifest, затем отдельное явное разрешение на push main/замену Pages artifact. Artifact публикует всю админку, сохраняя baseline payment bytes; server/catalog/pay/Edge/SQL в него не входят.

Live authenticated blog CRUD/HMAC/CORS, физический Safari/iPhone, действующая оплата и GitHub publication не проверены. Baseline был подтверждён 2026-10-03; перед фактическим release повторно проверить действующий deployment, чтобы не затереть новый чужой release. Готовый patch/candidate не применялся ни к основному repo, ни к удалённому хранилищу.
