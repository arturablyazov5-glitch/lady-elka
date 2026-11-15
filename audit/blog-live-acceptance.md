# Приёмка le-admin-blog — 2026-10-03

**Live authenticated CRUD НЕ проверен.** В доступном Codex browser inventory нет вкладок; в открытом Яндекс Браузере по доступному UI нет вкладки админки Lady Elka. Пригодная авторизованная сессия не подтверждена. Это не доказательство отсутствия сессии во всех профилях. Пароли, token storage и секреты при проверке не читались; обход входа не выполнялся. Live запросы/записи этим сценарием ещё не выполнялись.

Подготовлены `integration-qa/blog-live/runner.mjs`, `runner.test.mjs`, `admin-ui-snippet.js`. Код app/Edge function не изменён, deploy/SQL/commit/push/install не выполнялись. Существующие изменения сохранены.

## Локальная проверка

Из корня проекта:

```sh
node --test integration-qa/blog-live/runner.test.mjs
```

Результат: 8/8 PASS, Node built-in test runner, без зависимостей и сети. Это **имитация transport**, не запросы к Supabase и не проверка HMAC/CORS/RLS опубликованной функции. Успешный сценарий получил POST 201, остальные GET/PUT/DELETE 200; revision 1 → 2; собственная синтетическая запись удалена из имитируемого хранилища. Отдельно проверены утечка draft в feed, revision conflict, потерянные ответы POST/PUT, отказ cleanup, unauthorized и существующий slug. При ошибках после создания выполняется очистка; её ошибка делает результат неуспешным.

## Запуск из настоящей авторизованной админки

1. Открыть существующую удалённую админку `https://arturablyazov5-glitch.github.io/lady-elka/` в браузере пользователя, выполнить обычный вход вручную. Оставаться в той же вкладке: sessionStorage привязан к вкладке. Локальная cookie-сессия localhost не подходит для HMAC Edge API. Опубликованная вкладка «Блог» для запуска не обязательна.
2. Открыть DevTools Console этой вкладки. Не выводить sessionStorage, token, заголовки Authorization; не сохранять HAR/network dumps. Код берёт сессию только внутри request adapter и отправляет её только существующей функции Supabase. Не отключать браузерные защитные предупреждения.
3. Вставить содержимое `runner.mjs`, удалив только слово `export` перед `async function runBlogAcceptance`. Затем вставить `admin-ui-snippet.js`. Не менять origin/endpoint и не передавать token runner-у. Runner генерирует новый UUID и отдельный slug `qa-blog-live-<UUID>`; все записи имеют status=draft, cover пустой.
4. Сохранить только напечатанный JSON отчёт. Критерий успеха: `mode:live`, `passed:true`, `liveVerified:true`, `cleanup:confirmed-deleted`. Наличие синтетических данных в mock или `mode:simulation` не считается live evidence. После выполнения обновить эту заметку реальными статусами и временем, не копировать токен или существующие статьи.

Transport принимает `{method,path,body?}` и возвращает `{status,data}`. Авторизацию выполняет adapter, а не runner. Публичный `/published` вызывается без Authorization. Все запросы идут в `https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/le-admin-blog`; мутации имеют Content-Type application/json и X-Catalog-Request:1, admin запросы — существующий Bearer HMAC. Credentials=omit, cache=no-store. Ошибки backend/transport и содержимое других статей не включаются в отчёт.

## Конкретная последовательность

| Запрос | Ожидаемый результат |
| --- | --- |
| GET /posts | 200; новый slug отсутствует; при 401 ни одной мутации |
| POST /posts | 201; только синтетический draft, UUID и revision ≥1 |
| GET /posts повторно | 200; id/slug/draft/revision/text совпадают |
| GET /published; GET /export | 200; version=1, format=plain-text; id и slug draft отсутствуют |
| PUT /posts/{собственный id} | 200; полный draft payload с изменённым text и предыдущим revision; revision увеличен ровно на 1 |
| GET /posts повторно | 200; изменённый текст и новая revision сохранились |
| GET /published; GET /export повторно | 200; draft по-прежнему отсутствует |
| GET /posts перед cleanup | 200; подтверждены собственные id, уникальный slug, title, draft и текущая revision |
| DELETE /posts/{собственный id} | 200, ok=true; JSON содержит текущую revision |
| GET /posts после удаления | 200; отсутствуют и id, и slug |

## Ошибки и очистка

`finally` перечитывает список и удаляет только запись с собственным синтетическим slug/title и status=draft, проверяя id, если он уже известен. Это позволяет очистить draft, если ответ POST или PUT потерян после записи. До POST runner проверяет отсутствие slug; существующий slug останавливает запуск без удаления. Runner никогда не публикует/архивирует статьи и не обращается к товарам, оплате, SQL, Timeweb или DNS.

Если `cleanup:UNCONFIRMED`, live приёмка провалена: не запускать повторно вслепую. По `slug` и `id` отчёта найти **только собственный** QA draft в авторизованной админке, подтвердить совпадение title/status и удалить обычным интерфейсом, затем обновить список и убедиться в отсутствии. При потере авторизации сначала выполнить обычный вход. Если запись отсутствует, зафиксировать повторный GET. Не удалять чужие статьи и не использовать SQL/секреты для обхода барьера. Ошибка POST до получения id с последующей недоступностью GET может оставить draft: его уникальный slug всегда есть в отчёте.

Оставшийся барьер: выполнить этот готовый сценарий в настоящей авторизованной удалённой админской вкладке и получить успешный JSON с подтверждённым удалением. Совместимость опубликованного HMAC, реальный CORS и authenticated write path пока не доказаны этим отчётом.
