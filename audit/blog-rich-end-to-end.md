# Сквозная локальная проверка rich blog

Проверка `2026-10-03T18:25:28.525Z` — `2026-10-03T18:25:37.978Z` завершилась `passed`, процесс exit 0. Запуск: `node integration-qa/blog-rich/run.mjs`. Это браузерная проверка реального локального admin UI и реального import/build CLI, только синтетическая статья. ProductionReady=false; актуальные цены каталога не подтверждены, default manifest не изменён. Live Edge auth не проверен.

## Проверенный путь

В ephemeral Chrome админка открывается с локальной HttpOnly сессией. Каталог и billing замоканы на loopback; blog save/load/export выполняет настоящий app/server/index.mjs с TEMP BLOG_CONTENT_FILE. Кнопками toolbar созданы bold, italic, h2, h3, оба списка, безопасная ссылка; undo убрал h2, redo восстановил. Форматированная и plain вставка выполнены ClipboardEvent с настоящим обработчиком paste (не системным буфером). Unsafe javascript ссылка отвергнута диалогом; script/img/data URL из вставки удалены. Литеральный `<script>` из plain paste сохраняется текстом.

Сохранение записало durable local JSON. После реального F5 rich DOM восстановился. Legacy запись с настоящими CRLF, пустой строкой и краевыми пробелами прошла открытие/сохранение без потери text. Кнопка экспорта скачала настоящий JSON; draft и archived исключены (1 published из 3 локальных записей).

Этот **же скачанный файл** передан import CLI, без ручного сочинения rich публикации. Cover HTTPS identifier сопоставлен с существующим local PNG — сетевого скачивания нет. Snapshot content deep-equal экспортированным posts; export posts deep-equal durable запись + url. Полная сборка выполнена в TEMP workspace. Hash manifest совпал со snapshot, provenance — с точными bytes экспорта.

Chrome проверил actual article: h1, h2/h3, strong/em, ul/ol/li, rel=noopener noreferrer, реально загруженную local cover, literal script без исполнения, F5. Actual /blog содержит одну карточку новой статьи. Actual /search?search=E2EBODYONLY нашёл слово только из тела статьи и сохранил результат после F5.

Потом статья архивирована кнопкой реальной админки; скачан пустой published export, импортирован с --replace и выполнен полный rebuild. Canonical .html и clean route стали 404. Две legacy generated статьи сохранили byte hashes, blog list вернулся к baseline hash. Производные от реального export adversarial raw HTML/javascript/data документы отвергнуты canonical моделью и importer; прежний snapshot bytes не менялись.

## Цепочка hashes

- Exact export bytes SHA-256: `4da2bfed5e05241536ff5332d141f0f7857aa3b527e2dba409eb13d6570f69af`.
- Durable content JSON SHA-256: `7c3df87e314d4fa4e3f5fbf34df569e40ffa0ca353f0948a8a5a2885e3278da0`.
- Snapshot payload SHA-256: `61916ae4b5eca30c8f918d3f2f876c38b6491a0b6e70b1a3c13366b0874a0d09`; такой же в build manifest.
- Legacy price article: `807104b0cb13b9547d72bf78650091394e5ee3e214b91eb434243252543a3dc5`.
- Legacy choosing article: `37ca9ee467c8d72990176582f43b9cc87a76193586d6d97198bf2faf8177577c`.

## Сеть, cleanup и границы

До импорта server modules preload блокирует global fetch и process.loadEnvFile: .env/секреты не читаются. Дочерние процессы получают минимальный синтетический env. Chrome запущен с deny proxy и deny DNS; loopback исключён. Serviceworkers blocked + CDP bypass до навигации, response CSP ограничена self до загрузки admin страницы. Browser route allowlist допускает только два loopback origin. Зафиксировано 281 routed requests; external attempts 0, page errors 0, interception errors 0. Blog writes — только TEMP local store. Storefront сервер GET/HEAD-only. Native Chromium background traffic ограничен proxy/DNS, журнал относится к page requests.

Playwright ожидания ограничены 10/15 сек, CLI 120 сек, startup 15 сек; teardown закрывает браузер, завершает собственные серверы с bounded SIGTERM/SIGKILL и удаляет TEMP workspace. Сборки, посты, downloads и sessions удалены; QA-код, result.json и два скриншота оставлены в integration-qa/blog-rich. Ошибки не замаскированы: failed run пишет result и возвращает ненулевой код. При усилении сценария исправлено только построение selection QA (вставка первого p в конец h2 сливалась с текущим блоком); код приложения не менялся.

Source before/after SHA-256 всех 10 relevant app/blog/build/server modules совпадают: `True`. Полные hashes в result.json; результат относится к этой версии дерева, дальнейшие изменения требуют нового запуска. Изменения ограничены integration-qa/blog-rich/** и этим audit файлом. Нет Supabase/Timeweb/Taptop/DNS-конфигурации/платежей/APIv2 banks/GitHub publish/commit/push/deploy.

## Артефакты

- [Harness](../integration-qa/blog-rich/run.mjs)
- [Machine evidence](../integration-qa/blog-rich/result.json)
- [Admin screenshot](../integration-qa/blog-rich/admin.png)
- [Article screenshot](../integration-qa/blog-rich/article.png)
