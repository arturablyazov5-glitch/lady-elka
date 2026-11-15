# Вкладка «Блог» — локальная админка

Реализована в существующем app/public; запуск существующей командой `npm run start:app`, адрес `http://localhost:4180/app#blog`.

## Что работает

Список и поиск по заголовку/адресу, фильтрация статусов, создание, редактирование, архивирование, удаление с явным подтверждением. Заголовок, slug, анонс, ссылка на обложку и alt, обычный текст, SEO title/description. Предпросмотр через textContent; HTML не исполняется. Обложка сохраняется как URL, не загружается автоматически редактором. Для публикации нужны текст и анонс, для обложки нужен alt. Максимальные длины проверяются сервером.

Файловый источник: `app/blog-content/posts.json` (не коммитится); override `BLOG_CONTENT_FILE` — абсолютный путь. Один процесс локального сервера: сериализованная очередь записей, атомарная замена файла, revision для конфликтов между окнами. После перезапуска источник перечитывается. Для нескольких серверных процессов или GitHub Pages нужен отдельный backend/remote store. Требуется резервное копирование локального файла перед переносом машины.

`app/server/blog.mjs` хранит и проверяет данные, `app/server/index.mjs` подключает `/api/blog` под существующую проверку сессии, Origin и X-Catalog-Request. Loopback без настроенного пароля сохраняет существующее поведение доступа; сетевой запуск требует CATALOG_ADMIN_PASSWORD. Идентификатор статьи UUID; slug никогда не используется как путь файла. Дубли локальных slug и адреса существующих исходных статей отклоняются (409).

## Существующие статьи

Два файла `storefront/public/blog/*.html` читаются только для названий/адресов и отображаются отдельными исходными материалами. Они не импортированы в редактируемый plain-text источник: перенос текста и медиа требует отдельного согласованного этапа, чтобы сохранить структуру оригиналов. Их нельзя удалить/архивировать из нового редактора; source-файлы не изменяются. Реальные тексты не сочинялись.

## Контракт к витрине

Авторизованный GET `/api/blog/export` возвращает JSON `{version:1, format:"plain-text", posts:[...]}` только для локально опубликованных статей. Каждая содержит id, revision, title, slug, excerpt, cover, alt, text, seoTitle, seoDescription, status, createdAt, updatedAt и url `/blog/<slug>.html`. Кнопка «Экспорт» скачивает этот JSON.

Будущий storefront importer должен валидировать version/format, экранировать весь текст и атрибуты, разбивать plain text на абзацы, сохранять исходные captured posts и отклонять конфликты URL. Интеграция importer в storefront build в этой задаче НЕ выполнена. Экспорт — данные, а не готовые страницы.

Git remote metadata: github.com/arturablyazov5-glitch/lady-elka. `.github/workflows/pages.yml` копирует app/public, Node server не публикует. Существующий frontend использует Supabase catalog endpoint вне localhost. Новый blog.js использует отдельный le-admin-blog endpoint вне localhost и local file provider на localhost; catalog endpoint не менялся. Существующие schema/RLS/functions/cron/secrets не изменялись. Новые блоговые ресурсы описаны ниже. Статус «Опубликована локально» не означает изменение живого сайта. Нет push/commit/GitHub deployment/PR; отдельная новая Supabase blog function развёрнута по прямому разрешению пользователя.

## Проверка

`npm run test:app`: 42/42. Новые blog tests проверяют durable CRUD, повторное открытие хранилища, revision, дубли, атомарную очередь, экспорт статусов, удаление, traversal/URL/validation и read-only источники.

Offline browser QA: отдельный сервер :4189, временный posts.json, CATALOG_ADMIN_PASSWORD, preload `app/tests/blog-offline-preload.mjs` запрещает каждый исходящий fetch до импорта сервера. Chromium использует установленный Google Chrome. Browser route handler установлен до navigation: любые внешние запросы запрещены; catalog/billing ответы подменены локально. Реальные Supabase товары/платежи не читались и не записывались. API проверки: unauthorized 401, foreign origin 403, traversal rejected. Скриншоты audit/admin-blog-editor.png и audit/admin-blog-list.png содержат исключительно тестовые данные.

## Supabase integration (2026-10-03)

По прямому разрешению пользователя на изолированные blog-owned ресурсы применён только app/server/blog-edge/schema.sql через CLI db query --linked --file, не общая папка migrations. Проверено projects list: linked project mgnotvaahftrbifqtahf, name lady elka. До изменения public tables: le_catalog_products, le_catalog_settings, le_pro_billing, le_promo_codes, payment_orders, все RLS=true; политик public/storage не было. Бакеты le-catalog-feed-benchmark, le-catalog-feeds, le-catalog-images, telegram-assets не изменялись.

Создана public.le_blog_posts с unique slug, revision, payload, status, timestamps, включённым RLS. Для anon/authenticated разрешён только SELECT published policy le_blog_published_read; прямой INSERT/UPDATE/DELETE не разрешён. Админские операции идут через новую функцию le-admin-blog, которая проверяет точно существующий формат HMAC token (payload.signature, exp), используя уже существующий CATALOG_SESSION_SECRET без чтения/изменения значения. Browser передаёт существующий sessionStorage token; service role в browser отсутствует. Новый login endpoint/пароль не создавался. Function использует только le_blog_posts, не импортирует billing/catalog code.

Deploy: отдельная временная CLI workspace, только le-admin-blog --project-ref mgnotvaahftrbifqtahf --use-api --no-verify-jwt, server-side HMAC защищает admin маршруты; /published намеренно публичный и фильтрует status=published. Никаких Docker/login/install/shared config edits. Source app/server/blog-edge/index.ts, shared validator app/public/js/blog-model.js. Новая Edge function ACTIVE. До/после catalog version=6 updated_at=1790744025505; pay version=49 updated_at=1789287367002, unchanged. Все предыдущие таблицы остаются RLS=true. Новая политика относится только к le_blog_posts.

Вне localhost редактор хранит данные в Supabase; локально — в файле для offline QA. Уведомления в UI различают эти источники. GitHub Pages frontend не опубликован, новая вкладка на live GitHub ещё не появилась. Прямая публикация данных статьи не обновляет original frontend; существующие source posts не перенесены.

Проверки: node app/tests/blog-browser-qa.mjs — реальный Chrome, create/save/reload/edit/publish/archive/search/delete/navigation, zero pageErrors; тестовая запись удалена. node app/tests/blog-remote-qa.mjs — реальный Supabase SQL synthetic draft create/read/edit/archive, сохранение cover reference, public draft/archive denied, anonymous admin read/write 401, foreign Origin 403, synthetic row cleanup. RLS проверен под SET LOCAL ROLE anon: draft не виден. QA не публиковал тестовую запись. Existing table records/payment/orders не читались.

Ограничения доказательства: authenticated live Edge write с настоящей админской сессией не выполнен, доступной сессии/пароля нет; секреты не извлекались. HMAC совместимость, отказ повреждённого token и authenticated write path проверены локальным тестом с синтетическим ключом и fake REST. Реальный draft CRUD доказан через SQL Management API, а не через live admin token. Bucket/upload не создавались: редактор хранит cover URL; доступа к новому cover file нет, поскольку файла нет. Закрытый draft не делает уже существующий external cover URL приватным. Для собственных upload/preview нужна отдельная private bucket схема; текущая задача поддерживает ссылку на обложку.

Повторный deploy функции должен использовать изолированную staging workspace: копировать index.ts в supabase/functions/le-admin-blog/index.ts и blog-model.js в supabase/public/js/blog-model.js (относительный import сохранён). Применять schema.sql отдельно; не запускать общие миграции. Откат новой функции/таблицы — отдельное согласованное действие после резервной копии; текущие storefront/products/pay от этих ресурсов не зависят.
