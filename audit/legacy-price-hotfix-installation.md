# Старый сайт: установка исправления загрузки цен — 05.10.2026

Подготовка/read-only диагностика, **не установка**. Автор исправляет retry отдельно в release-candidates/legacy-price-hotfix; независимая проверка его результата начнётся после сообщения о готовности. Новый storefront/src, оплата, remote config и production не менялись.

## Что сейчас опубликовано

Captured HTML `/tmp/le-live-incident.html` подключает `/f/catalog.js?v=11`. Повторный публичный GET `https://lady-elka.ru/f/catalog.js?v=11` дал 200 и **те же байты**, что `/tmp/le-incident-catalog.js` и нынешний `dist/catalog.js`: 148870 bytes, SHA-256 `7c314fb4a9fa187c44d34fa1ba78a804bc09c0537235015d63ad6410d8f9070f`. ETag `"6abc96d5-24586"`, Last-Modified `Wed, 30 Sep 2026 04:57:57 GMT`, **Cache-Control: max-age=31536000**. Evidence и постоянный rollback JS: integration-qa/legacy-price-install/evidence.json, catalog-before.js. Этот файл сохранён из exact capture, а не пересобран из исходников.

Git HEAD не содержит dist/catalog.js (сборка исключена из Git). Current src/catalog отличается от HEAD в config/index/sheets/utils: суммарно 142 additions, 59 deletions на момент проверки; подробные хеши в evidence.json. Source modules не равны IIFE bundle по определению; сопоставление исходного index с JS bundle не доказывает идентичность сборок. **Новая полная сборка current src не проверена как равная production**. Совпадение существующего dist с live не означает, что npm run build воспроизведёт эти же байты.

## Путь установки и его граница

`build.mjs:1–3,16–20` описывает src/catalog/index.js → IIFE dist/catalog.js и **ручную загрузку в Taptop**. `README.md:39–50` подтверждает ручную загрузку JS/CSS, а не GitHub Pages/Timeweb deploy. Scripts/root docs не дают подтверждённого CLI/API upload endpoint, способа overwrite/cache purge или site ID Lady Elka. Нельзя считать deploy Pages админки установкой этого файла.

Browser inventory: Codex browser tabs пусты; в Yandex найдена авторизованная Taptop dashboard вкладка, но её открытый site ID 8420192 относится к **другому** сайту. Наличие доступной Lady Elka project/file manager и точного overwrite UI не подтверждено. Credentials/token/password manager не читались; uploads и кнопки публикации не нажимались. До установки необходимо открыть именно проект с действующим доменом lady-elka.ru и подтвердить путь файлов `/f/`. Точное имя пункта UI загрузки пока неизвестно; не придумывать его и не использовать чужой открытый site.

Рекомендуемая граница: один **узко исправленный exact live catalog JS**, со сверенным diff, без пересборки всей смешанной current src и без замены CSS/HTML блоков/платёжных скриптов. Bundle содержит каталог/корзину/оплату вместе, поэтому сохранение оплаты доказывается неизменностью всех байтов вне retry-участка и targeted regression автора, а не одним именем файла. Готовый artifact сначала проверяется независимо; пока его конкретные hashes/результаты не получены.

## После review: конкретный порядок, пока НЕ выполнять

1. Перед загрузкой снова прочитать текущий `/f/catalog.js?v=11`, сравнить SHA-256 с catalog-before.js. Если отличается — STOP: narrow patch надо перепроверить против новых опубликованных байтов. Сохранить старый URL/reference и готовый candidate/hash; не выдавать current local build за backup.
2. В подтверждённом Lady Elka Taptop проекте заменить **только файл `/f/catalog.js`** на проверенный JS, сохранив старые байты как rollback. Если UI не умеет сохранять путь/overwrite или нельзя подтвердить назначение — не удалять существующий файл, остановиться. Не загружать dist/catalog.css и другие assets, не трогать products/payment/config/SQL.
3. **Обязательный барьер кеша:** годовой TTL делает замену за прежним `?v=11` недостаточной. Для надёжной доставки согласовать обновление существующего script reference на новый query, например `/f/catalog.js?v=12`, во всех затронутых шаблонах/страницах. Это дополнительная минимальная правка подключения, не изменение платёжного кода. Если задача допускает буквально только upload одного JS без изменения ссылки — нельзя гарантировать обновление старых клиентов; hard reload проверяет лишь конкретный браузер. Cache purge сервера также не удаляет годовой browser cache. Новое имя файла работает только с обновлённым reference и не устраняет этот барьер.
4. Если Taptop требует публикацию страниц/сайта для обновления reference, заранее показать конкретный diff/набор страниц и получить разрешение на upload/reference publication. Не публиковать несвязанные draft edits. Подтверждение автора retry не является разрешением upload/deploy.
5. После отдельно разрешённой установки: публичный GET нового подключённого URL должен быть 200 с hash candidate; HTML реальных catalog/product/decor страниц должен подключать этот URL. Проверить browser Network и реальные отображаемые цены, в том числе искусственно воспроизведённый временный сбой → retry → цены без F5. Отдельно сверить прежний `?v=11`: он может получать новый серверный файл, но cached clients всё равно использовать старый. Платежи не отправлять; успешные HTTP/CSV ответы сами по себе не доказывают UI recovery.

## Откат

При ошибке вернуть `/f/catalog.js` к **catalog-before.js** с указанным hash. Для уже кешировавших hotfix клиентов подключить новый rollback query (например `?v=13`), а не возвращать прежний номер: если v12 кешируется на год, серверная замена за тем же URL не гарантирует возврат старых байтов. Query и публикация reference требуют той же отдельной авторизации и проверки затронутых страниц. После rollback GET подключённого URL должен совпадать с backup hash; проверить каталог в браузере без платежа. Откат только JS/reference; CSS, данные каталога, Supabase/pay, новый сайт и другие Taptop changes остаются вне этой операции.

Следующий независимый шаг — review готового release-candidates/legacy-price-hotfix artifact/diff. Установка сейчас не выполнена; остаются подтверждение нужного Taptop проекта/overwrite UI и разрешение на конкретную загрузку и изменение cache reference.
