# Локальный release админки — 2026-10-03

Собран **локальный, неопубликованный** artifact из текущего `app/public`, включая существующие незакоммиченные изменения. GitHub Pages/live frontend не проверены и не изменены. App, workflow и package не менялись; commit/push/deploy/install не выполнялись.

## Воспроизведение

Из корня `/Users/rafael/Documents/Работа/Проекты/Lady Elka`:

```sh
node scripts/build-admin-release.mjs /private/tmp/lady-elka-admin-release-20261003-qa
node --test integration-qa/admin-release/assembler.test.mjs
node integration-qa/admin-release/browser-qa.mjs /private/tmp/lady-elka-admin-release-20261003-qa
```

Путь вывода должен быть абсолютным, внешним по отношению ко всему проекту и новым. Для повторной сборки выбрать другой путь; существующий output не перезаписывается. На macOS использовать `/private/tmp`, потому что `/tmp` — symlink, а сборщик отклоняет symlink во всех компонентах пути. TEMP используется только для outputs и временного тестового fixture. Reusable assembler и QA остаются в основном каталоге проекта.

Результат проверенной сборки: `/private/tmp/lady-elka-admin-release-20261003-qa/`:

- `site/` — ровно 32 публичных файла; это каталог для eventual Pages artifact, без служебных manifest/QA файлов.
- `manifest.json` — path, размер и SHA-256 каждого файла `site`, SHA-256 `source-snapshot.json`.
- `source-snapshot.json` — полный список и SHA-256 файлов исходного `app/public`, хеш прочитанного `.github/workflows/pages.yml`, команды copy/upload. Это snapshot текущих байтов, не заявление о clean Git commit.
- `browser-report.json`, `browser-editor.png` — результат и screenshot локальной browser QA, расположены **вне** `site/`.

Manifest/source snapshot детерминированы: без времени, абсолютного output-пути и случайных значений. Повторная сборка неизменных исходников в другой output даёт побайтно одинаковые JSON. Manifest не включает свой собственный хеш; SHA-256 snapshot включён в manifest. Это проверка целостности, не криптографическая подпись.

## Состав и защитные отказы

Workflow `.github/workflows/pages.yml` делает `cp -R app/public site` и загружает `path: site`. Сборщик проверяет именно эти строки и сохраняет хеш всего workflow; при drift отказывается продолжать. Source и release списки файлов/размеров/хешей сравниваются после копирования. При изменении source или workflow во время сборки новый неполный output удаляется. Источник один — `app/public`; `app/server`, `app/blog-content`, env-файлы вне public и секреты не копируются. Названия hidden paths, server/private/secrets/blog-content/node_modules и credential-файлы внутри public дополнительно вызывают отказ вместо молчаливого исключения. Сборщик не извлекает секреты и не обещает распознать произвольный секрет, ошибочно встроенный автором в JS.

Все symlink и special files внутри source отклоняются; symlink в ancestor source/workflow/output тоже отклоняются. Output внутри проекта или содержащий проект запрещён; существующий output не перезаписывается. Source не изменяется. Проверенные fixture отказы: internal output (в том числе внутри app/public), relative output, existing output, symlink source/output ancestor, `.env`, workflow copy drift. Отдельная проверка собирает текущий реальный source и сравнивает весь набор release байтов.

## Canonical blog assets

Проверенный release имеет те же SHA-256, что текущий source:

| Файл | SHA-256 |
| --- | --- |
| `index.html` | `650f021c809006e3eb040479c3afbf2b475d07d3d4bbc4b6cf19be80e7c97666` |
| `js/blog.js` | `4fd76c66c1b6805030587c184b203404edcd08b1e4f68cf59a787ef2d255c177` |
| `js/blog-model.js` | `b9749409e1dad423e3452c7845f8b20a36842729377e217de84e70994c158f44` |
| `js/blog-rich-editor.js` | `634e9022c906f3231263efbd410ad79da5a283fce4341a6569f2f831c9611edd` |
| `css/blog.css` | `cf2bae0657062c73f6cde2d444908c519100e33ecefc6a9946891bedaea13ba3` |

`blog.js` импортирует canonical model/editor через относительные ES modules; editor также импортирует этот model. Сборщик ничего не транспилирует/переписывает. Browser QA повторно сравнивает весь release со snapshot текущего `app/public`, manifest и workflow SHA-256, затем импортирует model/editor непосредственно из release URL и проверяет structured document roundtrip.

## Результат targeted QA

`assembler.test.mjs`: **2/2 PASS**, включая все перечисленные проверки состава, воспроизводимости и отказов. Общий suite не запускался.

`browser-qa.mjs`: **PASS**, установленный Google Chrome headless + уже имеющийся Playwright, desktop viewport 1440×1100. Статический Node HTTP server обслуживал только `site/` на loopback, с Pages-style URL prefix `/lady-elka/`. Host `admin-release.test` через Chrome host-resolver привязан к 127.0.0.1: это заставляет неизменный frontend выбрать remote API branch, как на Pages, но не создаёт реальной DNS-записи. Route interception и service-worker block установлены **до navigation**; catalog/promos/blog ответы синтетические, font CSS пустой; остальные внешние запросы запрещены. В реальную сеть Supabase/оплата запросы не отправлялись, админский token не использовался.

Проверено: index, все scripts/CSS/assets (32/32) доступны из release; blog module/model/editor без missing imports; новая статья открывает contenteditable и toolbar; выделение + bold работает, предпросмотр показывает strong; synthetic draft save отправляет contentFormat=`le-richtext-v1`, content.version=1 и bold mark; reload/reopen сохраняет документ. Canonical `documentFromDOM` → `validateContent` → `contentText` из release совпадает с синтетически сохранёнными content/text. Screenshot визуально просмотрен: toolbar, draft и bold в editor/preview присутствуют.

Финальный report: pageErrors=[], requestFailures=[], httpErrors=[], notFound=[], blocked=[]; `liveAPIVerified:false`, `published:false`. Синтетические запросы: GET catalog, GET promos, GET blog/posts, POST blog/posts, повторные GET blog/posts и catalog. POST оставался draft и существовал только в памяти mock transport браузерного harness; browser/server закрыты после проверки.

Ограничения: эта проверка доказывает готовность локального статического artifact и подключение editor/model, а не live auth/HMAC/CORS/RLS, работу оплаты, физический iPhone/Safari, GitHub deployment или parity с опубликованным frontend. Source snapshot может устареть после дальнейших изменений других чатов; перед отдельным разрешённым релизом собрать новый output и повторить targeted QA. Публикация требует отдельного разрешения.
