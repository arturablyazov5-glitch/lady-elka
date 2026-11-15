# Подтверждённый Pages baseline — 2026-10-03

**Да: SHA `40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9` можно использовать как опубликованный baseline для будущего изолированного blog-only snapshot.** Он подтверждён связкой успешный deployment → workflow run/job → SHA и текущими HTTP байтами Pages. Snapshot/patch/публикация в этой задаче не создавались. Проверка около 22:09 МСК (19:09 UTC) 2026-10-03; это состояние на момент проверки.

## Deployment evidence

Repository: `arturablyazov5-glitch/lady-elka`, локальный origin тот же. Read-only `gh api` использовал существующую авторизацию; token/secrets не читались, auth/login/install не выполнялись.

| Поле | Подтверждённое значение |
| --- | --- |
| Pages URL | https://arturablyazov5-glitch.github.io/lady-elka/ |
| Pages config | build_type=workflow, https_enforced=true, source main /; status=null не интерпретируется как успешный deploy |
| Последний deployment в github-pages | `6451888603`, ref=main, SHA `40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9` |
| Deployment создан | 2026-09-15 04:44:24 UTC / 07:44:24 МСК |
| Deployment success | 2026-09-15 04:44:44 UTC / 07:44:44 МСК, environment_url совпадает с Pages URL |
| Workflow run | [34929980518](https://github.com/arturablyazov5-glitch/lady-elka/actions/runs/34929980518), Deploy app to GitHub Pages, .github/workflows/pages.yml, event=push, attempt=1, completed/success |
| Run SHA | совпадает с deployment SHA |
| Связанный deploy job | [104256005270](https://github.com/arturablyazov5-glitch/lady-elka/actions/runs/34929980518/job/104256005270), run_id совпадает, head_sha совпадает, completed/success |
| Job timestamps | 2026-09-15 04:44:28–04:44:43 UTC; Checkout, Prepare static site, Upload artifact и Deploy to GitHub Pages — success |

Deployment status **сам** содержит log_url на указанный run/job; это не произвольный latest successful build. Проверенный workflow SHA-256 `df1e90bdeaf1602a9a38700f117aa7f5979d37ff26a33fc18f2b23fb9818748a` совпадает с локальным. Его строки 29/33 копируют app/public и загружают site: Pages artifact — вся админка. Изоляцию новой вкладки workflow по-прежнему не обеспечивает.

## Выполненные read-only endpoints

Все перечисленные GitHub GET завершились успешно (данные доступны); список deployment отсортирован API по свежести, первым был указанный deployment:

```sh
gh api repos/arturablyazov5-glitch/lady-elka/pages
gh api 'repos/arturablyazov5-glitch/lady-elka/deployments?environment=github-pages&per_page=5'
gh api repos/arturablyazov5-glitch/lady-elka/deployments/6451888603/statuses
gh api 'repos/arturablyazov5-glitch/lady-elka/actions/runs?head_sha=40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9&per_page=10'
gh api repos/arturablyazov5-glitch/lady-elka/actions/jobs/104256005270
```

Source index/app/workflow получены через `/repos/arturablyazov5-glitch/lady-elka/contents/{path}?ref=40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9`, content base64 декодирован в собственный TEMP `/private/tmp/elka-baseline-*`. Git tree получен через `/git/trees/40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9?recursive=1`, truncated=false. Остальные source bytes сравнивались read-only `git show SHA:path`; для **каждого** файла его локальный Git blob SHA проверен против удалённого tree, поэтому локальный working tree не использовался вместо baseline. TEMP очищен в finally. Git refs/worktree не менялись; fetch/pull не выполнялись.

## Source и текущее serving

В baseline `app/public` **28 файлов**, блоговых файлов нет. HTTP GET корневого Pages URL — 200 и те же байты, что index.html из SHA. GET каждого из 28 файлов с query `baseline-check=<SHA>` и Cache-Control:no-cache — **200, без redirect, 28/28 побайтно совпали с baseline**. JS Content-Type application/javascript, CSS text/css, index text/html, SVG image/svg+xml. API catalog/pay не вызывались: только публичные статические URL; HTML в браузере не запускался.

Состав 28 проверенных URL: index.html; assets/bank_card.svg, assets/sbp-full.svg; css/{analytics,catalog-app,editor,onboarding,orders,payment,promo-pro,promos,settings,styles}.css; js/{analytics,app,editor-model,editor,icons,onboarding,orders,payment,pricing,profile,promo-model,promo-pro,promos,select-control,settings}.js. Проверены и index refs, и transitive modules из полного public tree.

| Файл | Baseline/Pages SHA-256 | Текущий локальный SHA-256 |
| --- | --- | --- |
| app/public/index.html | `d732595f119f107e18c6f1e5a9e0470a6bcfce2dc9e6bba43ab0c0efb7ba312d` | `650f021c809006e3eb040479c3afbf2b475d07d3d4bbc4b6cf19be80e7c97666` |
| app/public/js/app.js | `a3c6aff964833011e4a9ceac7eed2a6569e22f4356aedc9759e4faae4d1eae82` | `215028e1ddb02bc4e7228c90d1f3bb210b41a59676f2ad2b513ade624b186aee` |
| app/public/css/payment.css | `3a7bce3bee1909e4afb73426ccbbaca6cd6b0104244267c8ee2b4ba97cd2ef9d` | `20ff419d50d83359f1d34a29f9b4a61e2727359cf74092b5ba7d1cc807b4f713` |

Удалённые index/app Git blob SHA соответственно `ff616807e9f1cc0af7b2df8ffb61f8c83db9eaa5` и `29dce75e6c6f0b4c3590e4b2a0ed8b1f4f64d610`. В baseline index нет blog navigation/editor/imports и payment-success-page. Baseline `js/app.js:74` не содержит blog или payment-success navigation. Локальная строка 74 совмещает оба изменения; локальный index:93 добавляет payment-success-page, css/payment.css:757 — payment-success-active и последующие стили. Важно: baseline payment.css **уже имеет** прежние generic payment-success стили на :696–715; нельзя удалять их как якобы новые. Отличия определять diff от подтверждённого SHA.

GET новых `js/blog.js`, `js/blog-model.js`, `js/blog-rich-editor.js`, `css/blog.css` — **404 каждый**. Это ожидаемый результат: новый редактор сейчас не опубликован, хотя backend функция развёрнута отдельно.

## Применимость и ограничения

Этот SHA теперь подтверждён как исходная точка для отдельно порученного blog-only candidate. Переносить только новые blog modules/CSS и необходимые blog sections/imports/navigation; не переносить весь current dirty app/public. Проверенный раньше current release с 32 файлами **не стал** безопасным для blog-only публикации: payment/index/app.js изменения остаются смешанными.

Не доказаны: live authenticated blog CRUD/HMAC/CORS, состояние Supabase данных, оплата, browser interaction опубликованной версии, отсутствие любых лишних старых URL на Pages, сохранность/доступность исходного Actions artifact для будущего re-run, текущие environment protection rules. Сохранённая связь run/deployment/SHA и source hashes позволяет подготовить восстановление исходников, но rollback deployment требует отдельного разрешения и повторной проверки destination. Никаких snapshot/patch, commit/push/dispatch/deploy, SQL/секретов или изменений других файлов не было.
