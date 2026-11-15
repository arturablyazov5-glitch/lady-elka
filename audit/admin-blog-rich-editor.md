# Визуальный редактор блога

Заменено поле ввода HTML/plain text в существующей вкладке «Блог» на визуальный contenteditable редактор. Пользователь выделяет текст и нажимает привычные кнопки: жирный, курсив, обычный текст, заголовок, подзаголовок, маркированный/нумерованный список, ссылка/удаление ссылки, отмена/повтор. Поддерживаются Cmd/Ctrl+B/I/Z, Shift+Z и Ctrl+Y. Enter создаёт абзацы; вставка из документов сохраняет разрешённые жирный/курсив/ссылки/заголовки/списки. Панель сохраняет выделение при нажатии и обозначает активные marks. Кнопки минимум 44px, панель переносится на узком экране. Диалог ссылки не отправляет форму статьи; некорректный адрес выводит понятную ошибку.

Форматирование показывается в редакторе, кратком фрагменте списка и предпросмотре. Блок текста не предлагает вводить HTML или Markdown. Внешних библиотек/сервисов и новых dependencies нет; используется native browser editing + focused structured serialization. Физическая клавиатура iPhone/Safari не тестировалась: mobile QA — Chrome viewport 390x844.

## Хранение и защита

`app/public/js/blog-rich-editor.js`: UI, native selection/history, paste normalization и DOM→structured document.
`app/public/js/blog-model.js`: общий строгий валидатор local server/Edge, document→plain text и escaped document→HTML.
`app/public/js/blog.js`, `app/public/index.html`, `app/public/css/blog.css`: интеграция в существующий blog CRUD.

Canonical document — JSON, не HTML. Только paragraph/heading2/heading3/bulletList/orderedList, runs text/bold/italic/href. Неизвестные поля и блоки, marks неверного типа, небезопасные ссылки, control chars в URL и превышение лимитов отклоняются сервером. href допускает полный http/https без credentials, mailto адрес без query/hash. HTML rendering генерируется исключительно из проверенной структуры и экранирует text/attributes; CR кодируется entity для точного сохранения CRLF. Paste никогда не вставляет исходный HTML: DOMParser inert parse → allowlisted structured document → escaped HTML. Script/style/iframe/svg/math/images/embed/media/forms удаляются; event handlers/inline CSS/прочие attributes не сериализуются. Разрешены только font-weight/font-style как marks; картинки из вставки не загружаются редактором. Небезопасная ссылка превращается в обычный текст. Drop запрещён. Preview/лист не исполняют чужой HTML.

Plain legacy posts без content превращаются в один paragraph с точным text, включая ведущие/замыкающие пробелы и CRLF. Прежний validatePost.trim для text убран; metadata продолжает trim. Сохранение rich документа генерирует plain fallback text; это текст содержимого, не HTML. Пустой абзац с native placeholder BR нормализуется в пустой runs, предотвращая лишний перенос. Revision, duplicate slug и existing source reserved URL защиты сохранены.

## Точный backwards-compatible экспорт

Top-level **не изменён**: `{version:1, format:"plain-text", posts:[...]}`. Старый importer продолжает читать обязательный `text`. В post добавлены optional:

```json
{
  "contentFormat": "le-richtext-v1",
  "content": {
    "version": 1,
    "blocks": [
      {"type":"heading2", "runs":[{"text":"Заголовок", "bold":true}]},
      {"type":"paragraph", "runs":[{"text":"Текст", "italic":true, "href":"https://example.com"}]},
      {"type":"bulletList", "items":[[{"text":"Пункт"}]]}
    ]
  }
}
```

Другие допустимые types: heading3 и orderedList. Runs могут иметь только text (string), bold:true, italic:true, href:safeURL; список содержит массивы runs без nested lists. Все блоки→text join через LF, каждый list item — отдельная строка. Legacy exact text — один paragraph, не splitting/trim. Лимиты: 1000 blocks, 1000 runs/block или items/list, суммарно 10000 runs и 100000 text chars; href ≤2000 chars. content.version строго 1; contentFormat обязателен при content. Raw HTML полей нет.

Контракт передан координатору для integration чата 01a101d0-e0af-7720-a26e-eadc117244f5: optional rich renderer должен валидировать ту же структуру, выводить escaped p/h2/h3/ul/ol/li/strong/em/a и rel=noopener noreferrer, fallback text для legacy. Storefront/build файлы в этой задаче не менялись. До внедрения renderer plain fallback читабелен, форматирование отдельно не отображается старым importer. Оригинальный сайт не активирован.

## Supabase и границы

JSONB payload существующей отдельной le_blog_posts уже вмещает новый document; schema/RLS migration не понадобилась. Обновлена **только** новая blog-owned Edge le-admin-blog в подтверждённом mgnotvaahftrbifqtahf / lady elka (isolated temporary CLI workspace, --use-api --no-verify-jwt, shared HMAC session validation внутри Edge). Shared validator включён в deploy. Catalog/pay/functions/tables/buckets/secrets/cron не менялись. Browser не получает service_role. Auth/revisions/published-only RLS unchanged; drafts/archives closed.

Cover остаётся URL reference; media candidate не активирован и upload/bucket не создавались. Реальные статьи не публиковались, source posts не изменялись. GitHub/frontend не пушились/не публиковались.

## Проверки

- `npm run test:app` — 46/46: rich local file roundtrip/export, exact legacy whitespace, strict unsafe document/URL rejection, escaped render; existing app tests. Edge authenticated path проверен synthetic HMAC + fake blog-only REST, malformed document returns 400.
- `node app/tests/blog-rich-browser-qa.mjs` — real Chrome, external network deny before navigation, mock catalog/billing, local temporary durable blog backend: selection bold/italic, heading, lists, safe link dialog + broken link rejection + removal, native undo/redo, formatted paste XSS, rich save/reload/preview, mobile toolbar, exact legacy CRLF conversion/save. Zero page errors. Screenshots audit/admin-blog-rich-editor.png, admin-blog-rich-mobile.png, admin-blog-rich-toolbar.png.
- `node app/tests/blog-browser-qa.mjs` — общий CRUD browser regression adapted to rich UI: save/reload/publish/archive/search/delete/navigation.
- `node app/tests/blog-remote-qa.mjs` — real Supabase synthetic draft with structured heading/bold/italic content, SQL create/read/edit/archive, rich JSONB roundtrip and cover URL reference, public draft/archive exclusion, anonymous read/write 401 and foreign Origin 403; cleanup only unique synthetic row.

Live authenticated Edge CRUD с настоящей admin session не подтверждён: доступного admin token/password нет, секреты не извлекались. Real remote persistence проверяется SQL Management API, не подменяется заявлением о live admin write. HMAC protocol/browser rich UI/authenticated handler отдельно проверены локально. Real publish frontend/staging website activation не выполнялись.

Финальная remote сверка: le-admin-blog ACTIVE version=3, updated_at=1791032429816. Catalog version=6 updated_at=1790744025505 и pay version=49 updated_at=1789287367002 неизменны. После rich remote QA synthetic_remaining=0. Remote JSONB content сверяется структурно (порядок ключей JSONB не считается изменением документа). Финальный rich browser run после placeholder-BR/paste-selection исправлений — success, zero pageErrors, exact legacy CRLF roundtrip.
