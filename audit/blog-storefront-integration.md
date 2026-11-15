# Подготовка локальной публикации блога

Pipeline находится в storefront/blog; app/** только прочитан. Сборка не обращается к Supabase. Этот этап готовит локальный статический артефакт, не публикует сайт; productionReady=false. Статус published в админке означает опубликованные данные, для появления страницы на витрине нужны экспорт, импорт, сборка и отдельно разрешённый deployment.

## Plain-text контракт и применение

Экспорт админки: {version:1,format:"plain-text",posts:[...]}, только published. Каждая запись: UUID id, положительный revision, title, slug, excerpt, cover, alt, text, seoTitle, seoDescription, status, ISO createdAt/updatedAt, url=/blog/<slug>.html. Дубли UUID id (без учёта регистра)/slug, reserved slug index (страница списка), конфликт с существующими статьями, некорректный формат, draft/archive, небезопасные пути/URL отклоняются целиком; неполный экспорт не применяется частично. Текст экранируется, пустые строки разделяют абзацы, одиночные переносы отображаются как br. Markdown/HTML не интерпретируются.

После скачивания настоящего экспорта:

```sh
node storefront/blog/import.mjs --input /absolute/path/export.json
node storefront/build.mjs --mode=preview
```

Default snapshot: storefront/blog/snapshot.json. Его отсутствие сохраняет прежнюю сборку. Валидный пустой экспорт сохраняет обе captured статьи и прежнюю списковую страницу. Существующий снимок требует явного --replace. --output задаёт отдельный файл, LE_BLOG_SNAPSHOT задаёт файл сборки/тестов; явный отсутствующий override приводит к ошибке. Импорт атомарен, без --replace не перезаписывает уже существующий файл даже при гонке. SHA-256 payload фиксирует посты, asset map, provenance и productionReady; provenance хранит имя исходного файла, время импорта и SHA-256 точных исходных JSON bytes. Build manifest записывает provenance/checksum/count/stage.

Обложки должны существовать в storefront/public. Внешняя HTTPS cover ссылка сама не загружается: --assets /path/mapping.json с объектом {"https://host/cover.jpg":"/thumb/.../cover.jpg"} сопоставляет её с уже подготовленным локальным растровым файлом. /images/... также проверяется физически. Snapshot фиксирует SHA-256 файла; сборка повторно сверяет hash и запрещает выход через symlink за public root. Нет wildcard CSP, сетевого скачивания или скрытых broken images.

## Выход

Новые статьи используют существующий approved captured article layout, CSS, header/footer/back button. Генерируются /blog/<slug>.html и идентичный /blog/<slug>/index.html; canonical и og:url — ровно .html адрес экспорта. Title/description берутся из SEO полей с fallback на title/excerpt; h1 — заголовок статьи. Старая метка источника/даты не приписывается новому тексту. Статьи дополняют существующий blog list теми же card classes, search-index и sitemap по одному canonical URL. Список старых страниц сохраняется. Полный rebuild удаляет устаревшие generated pages из нового артефакта, при этом legacy source остаются; в эксплуатации нужна полная замена статического артефакта, а не upload только новых файлов.

Две существующие статьи не импортированы в plain-text, их rich content и URLs не изменены. Нового реального export/snapshot в основном проекте нет; синтетические статьи находятся исключительно во временных fixture. Поэтому обычная сборка сейчас остаётся legacy-only; настоящие тексты/обложки не выдуманы.

## Проверка

node --test --test-concurrency=1 storefront/tests/blog-publication.test.mjs: validation, malformed/unpublished, unsafe HTML/URL/traversal, duplicate/collision, checksum tampering, missing asset, asset mapping/hash, explicit missing override, import/replace. Последовательная TEMP integration: absent + empty + published builds с fetch forbidden; обе legacy generated article byte hashes и empty list hash идентичны baseline. Preview browser в настоящем ephemeral Google Chrome: direct .html/clean, reload, один h1, text script не исполняется, видимая ссылка в blog list, реальный search QABLOG, отсутствующие маршруты 404, ноль external requests/writes. Записи никогда не отправлялись в Supabase.

Rich-text additive контракт: top-level version:1/format:plain-text сохраняется. Optional contentFormat:le-richtext-v1 + content:{version:1,blocks:[...]}; text обязателен и должен точно совпадать с contentText. Используются непосредственно validateContent/contentText/contentHTML из app/public/js/blog-model.js (read-only dependency), отдельные конкурирующие правила не создавались. Paragraph/heading2/heading3 + runs; bulletList/orderedList + items; только text/bold:true/italic:true/safe href. Генерируются p/h2/h3/ul/ol/li/strong/em/a rel=noopener noreferrer, переносы внутри старого single paragraph сохраняются через br. Raw HTML, произвольные поля, неизвестные блоки/форматы, вложенные списки, javascript/data/credentials запрещены canonical validator. Search description для новых статей включает plain fallback всего текста, поэтому ищет также содержимое, без форматирующих тегов. SEO meta description остаётся отдельным SEO полем.

Rich integration проверяет заголовки обоих уровней, bold/italic, numbered/bullet lists, ссылку с экранированным &, локальную реально загруженную cover, HTML injection как буквальный текст, поиск RICHBODYONLY только из body, повторный импорт без потери schema. Malformed rich exports не изменяют прежний snapshot. TEMP harness копирует только публичный canonical blog-model из исходного проекта, никогда app data/сессии/секреты.

Итог проверки 2026-10-03: node scripts/offline-suite-isolated.mjs — 107/107 tests, exit 0, затем checkout browser QA и routes/search browser QA завершены без external requests/writes. После дополнения reserved-route/UUID и published→empty проверок повторный targeted blog suite — 3/3, exit 0; syntax и diff whitespace checks прошли. Legacy baseline сохранён byte-for-byte как с plain, так и rich export; после published→empty rebuild добавленные canonical/alias возвращают точный 404, index снова 57 records, sitemap/list снова legacy-only.

## Границы и откат

Нет Timeweb/DNS/Taptop/remote writes/secret access/commit/push/deploy. app, shared config/package, catalog/payment/backend untouched этой интеграцией. Для локального возврата legacy-only убрать выбранный snapshot/override и выполнить полный build. Для отмены конкретных новых статей импортировать новый актуальный экспорт с --replace и пересобрать; deployment/откат live не выполнялся. Актуальность production catalog unknown и существующие readiness blockers сохраняются.
