# Published payment dependencies — 03.10.2026

Результат: metadata `pay v49` подтверждена повторно, но фактический deployed source недоступен текущему аккаунту (HTTP 403). Тождество или отличие remote и local **не установлено**. Нельзя считать приведённую ниже локальную карту картой опубликованного обработчика. `productionReady=false`; cutover остаётся заблокирован.

## Read-only remote evidence и точный предел

Сначала изучен help установленного `/opt/homebrew/bin/supabase`: `functions --help`, `functions download --help`, `functions list --help`. Download поддерживает `--use-api`, без Docker.

Выполнен только management API list через существующую авторизацию:

```text
supabase functions list --project-ref mgnotvaahftrbifqtahf --output json
```

| Function | Version | Status | verify_jwt | Metadata ezbr_sha256 |
| --- | --- | --- | --- | --- |
| pay | 49 | ACTIVE | false | e3b4d3e65dec3aee831d1808f06924304c466571e0e254aa0425d950e5b74f69 |
| catalog | 6 | ACTIVE | false | 91a292c107022cdf6c15e335e574e0f937ba79a457855ef132f09ae8fd7fd745 |

`ezbr_sha256` — hash артефакта из metadata, **не** hash скачанного index.ts. Сравнивать его напрямую с local file SHA-256 нельзя. Entrypoint metadata pay содержит build-path с суффиксом `_47`, хотя version=49; путь не доказывает бизнес-контракт или содержимое.

Создана собственная TEMP-папка `/tmp/le-pay-source.MCM1hA`; из неё выполнено:

```text
supabase functions download pay --project-ref mgnotvaahftrbifqtahf --use-api --workdir /tmp/le-pay-source.MCM1hA
```

Exit code 1, `UnknownError`, `Error status 403`, ответ: `Your account does not have the necessary privileges to access this endpoint.` Исходные файлы не получены (`rg --files` в TEMP не нашёл файлов). После проверки TEMP удалена. Других способов скачивания, credentials lookup, login, установки, raw API обхода или повышения доступа не выполнялось. Повторное скачивание через другой механизм не входит в разрешённую процедуру.

## Local comparison snapshot (не deployed evidence)

SHA-256 прочитанных файлов на момент проверки:

| Local file | SHA-256 |
| --- | --- |
| supabase/functions/pay/index.ts | d75c77a55d9bd2276143f64b30e0d622a3028b9c81cc42122abf29bfe29f5dc7 |
| src/catalog/index.js | 1ba69939e824807b8f475605bd853662fc95a6c1ee419042157ac3fbd5b8fd20 |
| src/catalog/config.js | 1396827fca2945678f5c547773ecba948b2a17bfb3ccc55c42fb57a25e3ab9c2 |
| supabase/DEPLOY.md | 0183cde2015193bf7b37b51e083d90bcdf2c38010499c1d1a7b025fce5f38e53 |

| Dependency/contract | Обнаружено в local | Сопоставление с local v2 / предел |
| --- | --- | --- |
| Create wire | `src/catalog/index.js:2590,3227,3515`: fixed `/functions/v1/pay`, amount в рублях, description/email/phone/orderId/clientId/successUrl/failUrl/promoCode/address/contactPref; эти payload без paymentMethod и structured items | `pay/index.ts:1263` уже требует card и далее items. Это локальный конфликт, не доказанный live regression. V2 использует отдельный versioned envelope/ownerEndpoint; нельзя подменять legacy destination |
| Routing | `pay/index.ts:440–470`: COD/retry, create, check/check-payment, send/send-notification, poll-payments и hook fallback | `local-backend-v2/router.mjs` и `gateway.mjs`: только create/status/callback/internal-poll/internal-retry, unknown route 404. HTTP deployment bridge не проверен |
| Callback wire | `pay/index.ts:493–567`: HOOK_SECRET из header/query/body/Bearer; Telegram callback_query; Alfa mdOrder/orderNumber/operation/status, approved/deposited + status=1, далее bank status verification; иначе PayKeeper normalization | V2 callback lookup по persisted paymentId, LE2 bank_number и exact bank evidence. Legacy callbacks нельзя направлять сюда; настоящий merchant callback routing неизвестен |
| Status | Local check/check-payment и polling используют provider status; это иной wire, чем v2 status envelope | V2 status проверяет caller ownership и отдаёт versioned status + отдельно paymentURL. Фактический live status contract неизвестен |
| Provider | Local create использует Alfa register.do, ALFA_API_BASE/USER/PASS; hook сохраняет PayKeeper путь, PK_* и HOOK_SECRET. DEPLOY.md описывает прежний PayKeeper | Настоящие env values, выбранный merchant, provider hosts/config и callbacks не читались. V2 provider/notifier — внедряемые adapters; реальная интеграция не доказана |
| Return URLs | Legacy frontend: `/spasibo?oid=...`, `/pay-return?fail=1&oid=...`; local pay валидирует через paymentReturnUrl и передаёт returnUrl/failUrl в Alfa | Нельзя заменять старые return destinations или выводить runtime allowlist из local defaults. V2 paymentOrigins allowlist не доказывает настроенные банковские return URLs |
| Legacy queue | `pay/index.ts:917,927,952,961,1045`: public.payment_orders, md_order/order_number, notified_at, 48-hour polling | V2 не использует legacy очередь. Существование таблицы, текущие rows и remote job execution не проверены |
| Orders/effects/RPC | local shared order-store: le_orders/le_order_effects; recovery le_recover_bank_order затрагивает также payment_orders; local poll читает обе очереди | V2 schema-draft/roles-draft: le_checkout_v2 orders/effects и qualified RPC, restrictedAdapter проверяет session_user=current_user отдельной роли. Draft не доказательство remote grants/schema или Edge connectivity |
| Recipients | Local pay сохраняет notification_chat_ids, recipients:card:orderId effect; historical card без snapshot требует review; tgBroadcast per-recipient effects. TG_CHAT_IDS — только имя env, значения не читались | V2 snapshots recipients при reserve, v2:telegram:orderId:recipient; own worker. Remote recipient policy и historical compatibility остаются неизвестными |
| Telegram ownership | Local callback_query и общий bot/token/recipients | Отдельная таблица effects не изолирует общий bot webhook или quota. V2 не может самостоятельно захватить существующий webhook |
| Cron/auth | Local migrations: lady-elka-payment-poll → pay?action=poll-payments, X-Poll-Token/ALFA_CALLBACK_TOKEN; optional lady-elka-cod-delivery → retry-cod-delivery и свой retry auth | Наличие SQL только локально. Enabled remote cron, Vault values, auth и расписания не подтверждены; v2 workers требуют своих routes/auth/queue/budgets |
| Catalog | Local pay читает общий le-catalog-feeds; catalog/config задают public feeds | Catalog v6 metadata не доказывает freshness/pricing revision/storage policies. Общий каталог не менять; источник для v2 — отдельно согласованный read-only snapshot |

Базовая подробная local карта: `audit/supabase-payment-isolation.md`. Предыдущие memory/отчёты об исторических deployment/cron не пересертифицированы и здесь не считаются текущим runtime evidence. Локальные suite выполняет другой чат; их результаты этот документ не утверждает.

## Конкретные запреты для будущего cutover

1. Не заменять опубликованный `pay`, legacy endpoint/payload/status/return URLs, callbacks или destination старых pending tabs локальным pay либо v2. Deployed compatibility не доказана.
2. Не использовать public.payment_orders, le_orders, le_order_effects или le_recover_bank_order как v2 storage/recovery/queue. Не копировать historical rows, не перехватывать unknown/legacy payment и не отправлять notifier fallback без собственного exact ownership.
3. Не перенастраивать существующие poll/retry cron, их auth/Vault names, merchant callback или Telegram webhook ради v2. Не применять local cron/migrations/roles drafts к текущему проекту как готовый rollout.
4. Не разделять bot/merchant quota без согласованного общего бюджета либо выделенной квоты. Отдельный endpoint, namespace и effects не предотвращают двойную внешнюю отправку из независимых обработчиков.
5. Не давать v2 общий admin/service_role pool или SET ROLE вместо отдельной проверяемой identity; RLS не ограничивает service_role. Реальные grants/exposure/role-bound connections ещё требуют отдельного review и авторизации.
6. Не активировать card/COD/create и не разрешать productionReady по metadata или local tests. Нужны доступный source/проверенный deployed contract, schema/grants, callback ownership, provider/recipient policy и реальные интеграционные доказательства в отдельном разрешённом этапе.

## Выполненный scope

Ни один function/bank/Telegram endpoint не вызывался. Заказы/customer records, SQL, secrets, logs и provider configs не читались. Functions/tables/RLS/cron, приложение/config, Timeweb/DNS/Taptop не изменялись. Не было deploy/commit/push. Единственное итоговое изменение этой задачи — данный новый документ. Download закончился явным access boundary; неизвестность deployed business code сохранена и обозначена, не замаскирована локальным исходником.
