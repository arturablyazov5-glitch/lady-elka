# Деплой бэкенда на Supabase

**2026-10-12: безопасная подготовка рядом со старым сайтом.** Отдельный `pay-v2` уже развёрнут с закрытым приёмом; SQL использует namespace `le_v2_*`. Прежний `pay` v52 и legacy cron не менялись. Новая локальная storefront production-сборка указывает на `pay-v2`; опубликованный сайт пока прежний. До включения проверить отдельные callback банка и Telegram. Детали и доказательства: [audit/pay-v2/README.md](../audit/pay-v2/README.md). Старый порядок замены `pay` ниже не применять для параллельной подготовки.

Проект: **mgnotvaahftrbifqtahf** (`https://mgnotvaahftrbifqtahf.supabase.co`)
Функция: `supabase/functions/pay/index.ts` — платежи PayKeeper + webhook → Telegram (`verify_jwt=false` в `config.toml`).
Состояние: задеплоено, секреты залиты, фронт (`PAYMENT_ENDPOINT` в `src/catalog/index.js`) указывает на функцию.

## Деплой

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...   # выдаёт владелец
supabase link --project-ref mgnotvaahftrbifqtahf
supabase functions deploy pay --no-verify-jwt
supabase functions logs pay
```

## Секреты

```bash
supabase secrets set PK_HOST=... PK_USER=... PK_PASS=... HOOK_SECRET=... \
  TG_BOT_TOKEN=... TG_CHAT_IDS=... CORS_ORIGIN=https://lady-elka.ru
```

Подхватываются на лету, повторный деплой не нужен.

## Проверка

```bash
curl -i -X OPTIONS https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay        # 204
curl -sS -X POST https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay \
  -H 'Content-Type: application/json' \
  -d '{"amount":100,"description":"Тест оплаты","email":"test@test.ru"}'          # {"url": ".../bill/..."}
```

## PayKeeper

Webhook-URL в кабинете: `https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay?secret=<HOOK_SECRET>`.

## Ограничение

Дедуп уведомлений in-memory (один инстанс). Надёжнее — таблица `payments` в Postgres.
(Относится к задеплоенной версии; локальная версия pay дедуплицирует через `le_order_effects`, см. ниже.)

## pay: выкат нового checkout (локальная версия ещё НЕ задеплоена)

Проверено 2026-10-08 (read-only): на проде `pay` v49 от 2026-09-13; таблиц `le_orders`/`le_order_effects` нет
(применены только миграции `payment_polling`, `fix_payment_poll_auth`). Живой lady-elka.ru (Taptop, `/f/catalog.js`)
шлёт старый формат `{amount, description, email, ...}` без `paymentMethod`/`items`.

Локальная `pay/index.ts` требует новый формат (`paymentMethod`, `items`, сверка цен с `le-catalog-feeds`) и таблицы
заказов. Поэтому **деплой только вместе с переключением сайта на `storefront/`**, строго по порядку:

1. Точечно применить ровно `20261001120000_order_idempotency.sql`, затем `20261001130000_cod_delivery_retry.sql`,
   затем `20261008160000_order_rate_limits.sql` (SQL Editor или Management API, как для `leads`; не общий `db push`).
   Без последней pay отвечает 503 на создание заказа (лимитер fail-closed).
2. `supabase functions deploy pay --project-ref mgnotvaahftrbifqtahf --no-verify-jwt --use-api`.
3. Опубликовать storefront-сборку с этим endpoint. До шага 3 оплата картой со старого сайта получит 400.
4. Для автоповтора уведомлений COD: секрет `COD_DELIVERY_RETRY_TOKEN` (≥32 символа) и cron раз в 1–5 минут:
   POST `.../pay?action=retry-cod-delivery`, заголовок `x-cod-retry-token`. Без него недоставленные COD-уведомления
   повторяются только при повторной отправке формы клиентом.
5. Опционально: `NEW_ORDER_ADMISSION=closed` закрывает приём новых заказов (повторы существующих работают).
6. `HOOK_SECRET` обязателен: без него webhook/callback (Альфа, PayKeeper, Telegram callback) и `send-notification`
   отвечают 503/401. Значение не меняется; URL callback'ов должны содержать `?secret=` (или заголовок `x-hook-secret`).

### Лимиты частоты (pay)

Атомарно в Postgres (`public.le_rate_limit_take`, таблица `le_rate_limits`, только service_role). Отказ → 429 + `Retry-After`,
ничего не засчитывается. Недоступность лимитера → 503 без заказа и без внешних вызовов. Значения `лимит/окно_сек`
(secrets, необязательно; по умолчанию):

| Секрет | По умолчанию | Что ограничивает |
|---|---|---|
| `ORDER_RATE_LIMIT_IP` | `10/600` | новые заказы (карта и COD) с одного адреса |
| `ORDER_RATE_LIMIT_CONTACT` | `5/600` | новые заказы на один email и отдельно на один телефон (последние 10 цифр, хэш) |
| `EXTERNAL_RATE_LIMIT_GLOBAL` | `200/3600` | общий бюджет: новые заказы + `check-payment` (банк, PayKeeper, Telegram, фиды) |
| `CHECK_RATE_LIMIT_IP` | `10/600` | публичный `check-payment` с одного адреса |
| `REPLAY_RATE_LIMIT_IP` | `30/600` | повторы уже принятого заказа (отдельный бюджет) |

Адрес клиента: заголовок `CLIENT_IP_HEADER` (по умолчанию `cf-connecting-ip`), иначе правый элемент `X-Forwarded-For`;
IPv6 — по /64. **[УТОЧНИТЬ при выкате]**: какой заголовок реально доходит до Edge Function на этом проекте
(временно залогировать имена заголовков одного тестового запроса). Если ни один не доходит, все клиенты попадут
в один IP-бакет — тогда поднять `ORDER_RATE_LIMIT_IP`; лимиты по контактам и общий бюджет работают независимо.

### PayKeeper (legacy)

Webhook и `check-payment` не доверяют телу запроса: счёт подтверждается API PayKeeper (`status` строго `paid`),
`id`/`orderid`/сумма сверяются с `payment_orders`; без записи — 409 «на разбор». Дедуп — по `notified_at` и
эффектам Telegram, без ограничения по возрасту заказа (поздняя оплата уведомляется).

Старые платежи из `payment_orders` без записи в `le_orders` после выката не уведомляются автоматически
(«Card recipient snapshot requires review») — сверить вручную. Telegram-эффект в состоянии `unknown`
(таймаут/обрыв ответа Telegram) повторно не отправляется — нужна ручная проверка `le_order_effects`.

Проверки: `node --test --test-concurrency=1 supabase/functions/pay/tests/*.test.mjs storefront/tests/cod-server.test.mjs storefront/tests/product-server-validation.test.mjs`.
Два storefront-теста pay требуют фикстуры с RPC лимитера и `HOOK_SECRET`: патч `agent-context/pay-storefront-tests.patch`
(`git apply`), до него они падают по задуманной причине (fail-closed).

## Заявки: функция `lead`

`lead` использует тот же `TG_BOT_TOKEN` / `TG_CHAT_IDS`, что `pay`. Клиент не выбирает получателей: production сохраняет серверный список (личка + группа) в каждой заявке. Endpoint:
`https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/lead`.

Добавочная миграция: `supabase/migrations/20261008090000_leads.sql`. Таблица `le_leads` закрыта для anon/authenticated; доступ и RPC только service_role. До Telegram заявка сохраняется, при недоступности базы возвращается 503 без ложного успеха. Если Telegram недоступен, ответ 202 с `accepted:true` / `notification:pending`: заявка уже в базе. Ответ 200 означает подтверждённую доставку всем сохранённым получателям.

Точечное применение **только этой** миграции и CLI-деплой, без применения остальных незавершённых миграций:

```bash
node scripts/lead-ops.mjs --deploy
```

Скрипт читает игнорируемые `.env` / `Переменные окружения.ini`, не выводит секреты, применяет SQL транзакцией через Supabase Management API, затем вызывает:

```bash
supabase functions deploy lead --project-ref mgnotvaahftrbifqtahf --no-verify-jwt --use-api
```

Для ручной процедуры сначала выполните ровно `20261008090000_leads.sql` в SQL Editor. Не используйте общий `db push`, если чужие миграции не проверены. `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` предоставляет Edge runtime; Telegram/CORS уже существуют в секретах проекта. Допустимые origins задаёт существующий `CORS_ORIGIN`, как у pay. Для другого опубликованного домена добавьте его в список; не включайте `*` без необходимости.

### Вид уведомления (lead v6, 2026-10-10)

Как у заказа: баннер «новая заявка» (`telegram-assets/lead-notification.png`, копия `banner.png` с заменённым заголовком, Soyuz Grotesk Bold 444px, #083A0D) через `sendPhoto` + HTML-подпись: заголовок типа, блоки «Заявка:», «Клиент:», «Откуда:», короткий № (8 символов). Кнопки: «💬 WhatsApp» (wa.me), «✈️ Telegram» (t.me/+номер); `tel:` Telegram в кнопках не принимает — телефон кликабелен в тексте. Подпись ≤ 1024 видимых символов: длинный комментарий обрезается «…», полный текст уходит отдельным сообщением (подтверждение `<chat>#full` в `delivered_to`, ретрай не повторяет баннер). Фото отклонено (4xx) → текст с кнопками; HTML отклонён → простой текст; 429/5xx → ретрай. Механика — `supabase/functions/_shared/telegram-notify.mjs`. `LEAD_PHOTO_URL` (secret, необязательно): другой URL баннера или `off`.

Кнопки статуса («🆕 Новая → В работе → Закрыта») **не сделаны**: webhook бота (`allowed_updates: callback_query`) указывает на функцию `pay` (задеплоена v50 от 13.09), обработчик `callback_query` живёт там; локальную `pay` нельзя деплоить до переключения сайта (см. выше), а правка боевой v50 рискует статусами заказов. Сделать после выката нового `pay`: префикс `lead_status_*` в `handleTelegramCallback` + колонка статуса в `le_leads`.

Откат: `agent-context/rollback/lead-before-v6/README.md`.

### Очередь повторной доставки

`delivered_to` сохраняет подтверждённых получателей, `lease_until` предотвращает одновременную доставку; неуспешные остаются `pending`, `next_attempt_at` задаёт паузу (экспоненциальную, см. «Автоповтор»). Telegram не предоставляет идемпотентность sendMessage: потеря ответа после фактической отправки может дать повтор при следующей попытке, но сама заявка остаётся сохранена.

Ручная обработка до 20 ожидающих записей с локальными server-side секретами:

```bash
node scripts/lead-ops.mjs --retry
```

**Эта команда отправляет реальные ожидающие заявки сохранённым получателям, включая группу для production-заявок. Не запускайте её как тест.** Ручной режим (`manual:true`) игнорирует выключатель и лимит возраста, но не lease/лимит попыток; за прогон до 10 заявок. Автоматический планировщик — раздел «Автоповтор» ниже (`LEAD_RETRY_TOKEN` ≥ 32 символов, заголовок `x-lead-retry-token`; токен бота туда не подставлять). Публичный retry без секрета возвращает 401.

### Автоповтор (pg_cron → `lead?action=retry`)

Миграция `20261008120000_lead_retry.sql` (применена 2026-10-08, **выключена**). Как работает:

- Статусы `pending → delivered | failed`. После неудачной попытки пауза `120 с × 2^(n−1)` (±15 %, не больше 6 ч); после `max_attempts`=8 (~4 ч) — `failed`, автоповтор прекращается. `last_error` — короткий код (`telegram_http_502`, `telegram_timeout`…), без персональных данных.
- Защита от двойной отправки: атомарный claim одной заявки (`FOR UPDATE SKIP LOCKED` + lease 2 мин), подтверждение каждого получателя отдельно (повтор только недоставленным), circuit breaker — если Telegram лежит, за прогон тратится одна попытка, а не вся очередь. Остаётся неустранимое: таймаут ответа Telegram после фактической отправки может дать один дубль.
- Заявки старше `max_age_hours`=72 автоматически не повторяются (только `--retry` вручную).
- Уведомление владельцу: если заявка не доставлена после `alert_after_attempts`=4 попыток (или стала `failed`) — одно сообщение «⚠️ Заявка не доставлена» с текстом заявки **только в личку**: `LEAD_ALERT_CHAT_ID` (положительный id) или единственный положительный id из `TG_CHAT_IDS`; отрицательные (группы) отвергаются, при неоднозначности алерт не шлётся. Неудачный алерт повторяется с паузой 5 мин × 2^n.
- Две независимые блокировки: `le_lead_retry_settings.enabled=false` (функция и `le_lead_retry_tick()` ничего не делают) и cron-джоба `lady-elka-lead-retry` (каждые 2 мин) создана **неактивной**. Повторное применение миграции её не включает.
- Токен: Vault `lady_elka_lead_retry_token` = Edge secret `LEAD_RETRY_TOKEN` (64 hex, создан `node scripts/lead-ops.mjs --provision-retry-token`, не перезаписывает существующий). `le_lead_retry_tick()` не вызывает HTTP, если выключено или нечего делать.

Состояние (только агрегаты, без персональных данных): `node scripts/lead-ops.mjs --retry-status`.

**Включение — только с разрешения владельца.** Перед этим проверить `--retry-status`: `pending`/`failed` должны быть ожидаемыми (при включении они уйдут обоим получателям, включая группу). Затем в SQL Editor:

```sql
update public.le_lead_retry_settings set enabled = true, updated_at = now() where id = 1;
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'lady-elka-lead-retry'), active := true);
```

Выключение (мгновенно, без потери заявок):

```sql
update public.le_lead_retry_settings set enabled = false, updated_at = now() where id = 1;
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'lady-elka-lead-retry'), active := false);
```

Вернуть `failed`-заявку в очередь (после устранения причины): `update public.le_leads set delivery_status='pending', attempt_count=0, failed_at=null, next_attempt_at=now() where id='<uuid>';`. Параметры (`max_attempts`, `alert_after_attempts`, `base_delay_seconds`, `max_delay_seconds`, `max_age_hours`) меняются `update public.le_lead_retry_settings …`. Журнал cron: `select * from cron.job_run_details where jobid=(select jobid from cron.job where jobname='lady-elka-lead-retry') order by start_time desc limit 20;`, ответы pg_net: `select status_code, content from net._http_response order by created desc limit 20;`.

`node scripts/lead-ops.mjs --deploy` применяет lead-миграции **по порядку** (090000 → 120000 → 125000) и деплоит функцию; не применяйте 090000 или 120000 отдельно — они вернут старые версии RPC.

**Ожидает разрешения владельца:** `20261008125000_lead_claim_backoff.sql` (фикс ревью №5: публичный повтор той же заявки до `next_attempt_at` не тратит попытку и не шлёт в Telegram — initial claim один раз, далее только по сроку и лимиту) и соответствующий handler **не применены/не задеплоены** на боевой проект. Применение: `node scripts/lead-ops.mjs --deploy` (идемпотентно, автоповтор остаётся выключенным).

### Проверки

```bash
node --test --test-concurrency=1 supabase/functions/lead/tests/*.test.mjs storefront/tests/forms.test.mjs
npm run build:storefront
node storefront/tests/forms-browser.mjs
```

Браузерный тест: 128 экземпляров на 50 страницах, локальные HTTP/SQL и синтетический Telegram; никаких внешних Telegram-запросов. Он использует `agent-context/forms-inventory.json`. Preview остаётся read-only; тест отдельно подменяет guard/конфиг только внутри локального fixture. Production-сборка содержит настоящий lead URL:

```bash
npm run build:storefront:production
```

Разрешённый владельцем однократный живой тест (всегда только положительный личный chat id, пометка «ТЕСТ»):

```bash
node scripts/lead-ops.mjs --live-test
```

Скрипт сохраняет личный recipient snapshot, проверяет `ok:true`, совпадение адресата и message_id. Не используйте публичную production-функцию для тестовой заявки: там будут оба получателя. Отчёты без секретов находятся в `agent-context/forms-*-report.json`.

## Catalog: лимит входа и тела запроса (подготовлено 2026-10-08, НЕ применено)
Боевая edge `catalog` = v8 (повтор выгрузки фидов + X-Feed-Warning). В репо следующая версия: поток тела считается в байтах с ранним cancel (login ≤ 4 КБ, прочее ≤ 12 МБ) и лимит перебора пароля в общей таблице БД.
Порядок только с разрешения владельца: 1) применить ТОЛЬКО `supabase/migrations/20261008150000_catalog_login_limit.sql` (SQL Editor, одной транзакцией); 2) `node --test --test-concurrency=1 app/tests/catalog-edge-*.test.mjs`; 3) `supabase functions deploy catalog --no-verify-jwt`. Обратный порядок ломает вход в кабинет (без функций лимита /api/login отвечает 503 — fail closed).
Параметры: 5 попыток с источника, далее пауза 30 с·2^(n−5) до 1 ч (сброс после часа тишины или успешного входа); общий бюджет 100 попыток/15 мин; ответ 429 + Retry-After. Разблокировать вручную: `delete from public.le_catalog_login_limits;`.

## Каталог: GitHub Actions (вариант C)

**Подготовлено, не применено. Прямой Supabase dispatch заблокирован.** PAT из Vault неизбежно попадает в `net.http_request_queue` при `net.http_post` с Authorization. Supabase не поддерживает ограничение grants/RLS этой очереди: [официальное ограничение](https://supabase.com/docs/guides/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net-ad6357). Поэтому исходный контракт безопасно включить нельзя. До решения владельца использовать согласованный резерв: GitHub workflow каждые 20 минут с проверкой хэша прямых фидов. Он не требует миграции/триггеров/PAT в Supabase.

1. Ипполит готовит workflow на **main** в `arturablyazov5-glitch/lady-elka-cloud-preview`: событие `catalog_changed`, payload revision, расписание 20 минут, сборка и публикация `/site`, Timeweb deploy. Проверить workflow на main и его журнал; HTTP204 подтверждает только приём события.
2. Владелец должен выбрать безопасный отдельный relay с пересмотром прямого POST-контракта либо оставить расписание единственным каналом. Для будущего relay отдельно согласовать место чтения PAT и доверенную роль: передавать PAT через API-роль при нынешнем требовании нельзя. Создание PAT/запись Vault пока **не требуются**. Когда транспорт согласован: владелец создаёт fine-grained PAT только этого репозитория (Contents/Actions write), сохраняет `le_catalog_sync_github_token` через Vault UI, без SQL с реальным значением, env, истории shell и печати. Нужны SQL Editor/admin и включение pg_cron/pg_net через Dashboard. [GitHub permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
3. После **отдельного разрешения** точечно применить старую и новую миграции в одной транзакции, без `db push` и применения посторонних миграций. Если старая уже применена — только новую. Команда для подготовленной административной DATABASE_URL (не выводить её):

   ```sh
   { printf 'BEGIN;\n'; cat supabase/migrations/20261008110000_catalog_autosync.sql supabase/migrations/20261010110000_catalog_ci_dispatch.sql; printf '\nCOMMIT;\n'; } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
   ```

   Новая версия уникальна, повторное применение выключает dispatch; revision/sent_revision сохраняются. Расширения/cron не создаются, PAT не читается. Не применять старую миграцию отдельно после новой: она вернёт небезопасный отправитель.
4. Проверить состояние и ACL (SQL Editor, только администратор):

   ```sql
   select enabled, revision, sent_revision, verify_revision, ready_revision,
          request_id, request_revision, last_status, retry_at, diagnostic
   from public.le_catalog_sync_state where id=1;
   select t.tgname from pg_trigger t where not t.tgisinternal
     and t.tgname like 'le_catalog_sync_%';
   select r.rolname,
     has_table_privilege(r.oid,'public.le_catalog_sync_state','SELECT') as state_read,
     has_function_privilege(r.oid,'public.le_catalog_sync_dispatch()','EXECUTE') as dispatch,
     has_function_privilege(r.oid,'public.le_catalog_sync_send(bigint)','EXECUTE') as transport
   from pg_roles r where r.rolname in ('anon','authenticated','service_role');
   -- При установленных расширениях; выбирать только булевы права, никаких секретов:
   select r.rolname,
     has_table_privilege(r.oid,'vault.decrypted_secrets','SELECT') as vault_read,
     has_table_privilege(r.oid,'net.http_request_queue','SELECT') as queue_read
   from pg_roles r where r.rolname in ('anon','authenticated','service_role');
   select jobid,jobname,schedule,active from cron.job
     where jobname='le-catalog-sync-debounce';
   ```

   Ожидание: enabled=false; state_read/dispatch/transport=false; свежая установка — cron отсутствует. vault_read/queue_read могут показать платформенные доступы: это блокер, а не повод экспериментировать с grants общей очереди. Не включать enabled и не создавать cron с текущим транспортом. `supabase/sql/catalog-autosync-enable.sql.example` теперь содержит только безопасную диагностику/откат. Рабочей команды включения прямого транспорта **нет** до решения конфликта.
5. После согласования и реализации безопасного транспорта потребуется отдельная staging-проверка реальных pg_net/Vault/Storage: публикация трёх фидов → проверка bytes/revision → один event после тишины → workflow на main → `/site` → успешный Timeweb deploy. Локальный mock этого не заменяет. Не менять боевую цену для проверки без отдельного разрешения.

**Откат/выключение Supabase одной командой:**

```sql
select public.le_catalog_sync_disable();
```

Функция ставит enabled=false, делает dirty-триггеры неактивными и удаляет cron `le-catalog-sync-debounce` в той же транзакции. Старые данные/миграция/триггеры сохраняются; уже переданный запрос не отзывается. Для остановки резервного канала отключить workflow на GitHub; откат сайта — сохранённый релиз `/site`/Timeweb. Не возвращать старую функцию dispatch: она передаёт PAT в открытую очередь.

Архитектура/диагностика: [AUTOSYNC.md](AUTOSYNC.md). Локальные проверки:

```sh
node --test --test-concurrency=1 supabase/tests/catalog-ci-dispatch.test.mjs scripts/catalog-sync/catalog-sync.test.mjs app/tests/feeds.test.mjs app/tests/catalog-edge-feeds.test.mjs
node --test --test-concurrency=1
```
