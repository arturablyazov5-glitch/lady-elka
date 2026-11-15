# Изоляция оплаты Supabase — 03.10.2026

Результат: рабочий `pay` нельзя заменять локальным новым handler. Для витрины нужен отдельный versioned handler с собственной областью хранения, polling, effects и callback ownership. `productionReady=false` сохраняется. Это карта и следующий локальный этап, не разрешение на активацию.

## Verified remote metadata

Единственная удалённая операция: установленный CLI `supabase functions list --project-ref mgnotvaahftrbifqtahf --output json`, через существующую авторизацию; без установки, login, поиска credentials, вызовов функций или чтения записей.

| Функция | Версия | Статус | JWT gateway |
| --- | --- | --- | --- |
| pay | 49 | ACTIVE | verify_jwt=false |
| catalog | 6 | ACTIVE | verify_jwt=false |

Это версия deployment, а не версия бизнес-контракта. Deployed source не скачивался; тождество локального `supabase/functions/pay/index.ts` версии 49 не доказано. CLI metadata не доказывает provider configuration, schema, grants, cron execution или доставку. Других remote metadata проверок не выполнялось.

## Verified local: используемые ресурсы и конфликты

Изучены актуальные `storefront/audit/payment-hardening.md`, `order-abuse-plan.md`, `taptop-cleanup-final-acceptance.md`, source/config и deploy docs. Их предыдущие test counts здесь не пересертифицированы.

| Ресурс | Локальное evidence | Следствие для изоляции |
| --- | --- | --- |
| Legacy API | `src/catalog/index.js:2590`, payload около 3227/3515: `/functions/v1/pay`, amount/description/email/phone/orderId/clientId/return URLs; без paymentMethod | Нельзя перенаправлять старые вкладки на новый structured контракт. `routePay` в local pay:1263 требует card; новый endpoint обязателен |
| Gateway/router | `supabase/config.toml`; local pay:428–462, hook fallback:523–567 | pay совмещает create/check/send/poll/COD retry/Alfa/PayKeeper/Telegram. v2 нужна явная таблица routes, без implicit hook/unknown action fallback |
| Legacy queue | `20260902000000_payment_polling.sql`: public.payment_orders, PK md_order, amount/order_number/status/notified_at | Local card и recovery тоже пишут сюда; shared queue позволяет старому poller забрать новый заказ. v2 не пишет/читает эту таблицу |
| Новые заказы/effects | `20261001120000_order_idempotency.sql`, `_shared/order-store.mjs`: public.le_orders, public.le_order_effects; unique order_id/payment_id/effect_key, SHA-256 canonical payload | Эти имена пока общие public и не являются новой независимой v2 областью. Их production существование неизвестно |
| Recovery RPC | public.le_recover_bank_order в той же migration | SECURITY DEFINER, service_role execute; атомарно меняет le_orders/effects И payment_orders. В v2 требуется отдельный RPC без legacy references. Наличие SQL не доказывает runtime использование/remote deployment |
| Polling | local pay:1026–1048 выбирает и le_orders, и payment_orders; header X-Poll-Token сравнивается с ALFA_CALLBACK_TOKEN | Общий polling затрагивает historical orders. Новый poller должен выбирать только свою очередь и иметь отдельный auth/budget |
| Cron | 20260902 migrations: lady-elka-payment-poll, каждые 2 минуты, pay?action=poll-payments. `supabase/sql/cod-delivery-cron.sql`: optional lady-elka-cod-delivery, каждые 5 минут, pay?action=retry-cod-delivery; Vault names в SQL | Remote jobs и их включённость неизвестны. Не применять эти файлы для v2, не перепланировать legacy jobs |
| Catalog/storage | local pay:1102/1173 читает trees/decor/promos CSV из le-catalog-feeds; catalog source публикует feeds и le-catalog-images из le_catalog_products/settings/promo_codes | Допустим только согласованный read-only источник. Цена должна иметь подтверждённую revision/freshness; новый pay не меняет общий bucket/catalog. Отдельный approved snapshot при будущем rollout |
| Bank/callback | local pay:529–567, 851+, 1286+: Alfa register/status; mdOrder/orderNumber/operation/status. PayKeeper hook через HOOK_SECRET; deploy doc описывает прежний PayKeeper | DEPLOY.md устаревший/неполный относительно local Alfa кода; remote provider и callback URL неизвестны. Отдельный URL сам не меняет bank callback ownership |
| Telegram | local pay:1483+ Telegram callback; 1566+ notifier; effects telegram:method:transactionId:recipient, recipients:method:orderId; TG_BOT_TOKEN/TG_CHAT_IDS | Общий бот имеет общую квоту и webhook ownership. Нельзя переключать его webhook на v2. Local old callback_data не содержит версии заказа |

`supabaseAdminRequest` (local pay:901+) использует service_role и default public REST. RLS не изолирует такой caller: отдельные имена таблиц сами по себе не ограничивают его права. Production grants, exposed schemas и роли не проверены.

## Предлагаемая конкретная v2 карта (ещё не реализована)

1. Handler `pay-v2`: явные create/status/provider-callback/internal-poll/internal-retry routes, contractVersion=2; отдельный fixture-only config. Legacy `pay`, frontend, callbacks и pending destination остаются прежними. Pending хранит API destination, contractVersion, неизменный business payload и отдельный capability.
2. Schema `le_checkout_v2`: orders, bank_queue, effects, admission_reservations, budgets. REST adapter явно задаёт schema profile; schema exposure/grants — отдельный будущий approved шаг. Если отдельная схема недоступна, вариант public.le_v2_* требует отдельного решения и ограниченной роли; не молчаливого fallback. Service-role в общем проекте остаётся shared trust boundary; строгая инфраструктурная изоляция потребует отдельного проекта/ограниченного DB доступа.
3. RPC `le_checkout_v2.reserve_order`, `claim_effect`, `consume_admission`, `recover_bank_order`: explicit search_path, qualified references, revoke PUBLIC/anon/authenticated, отдельная server role. Recovery транзакция меняет только v2 order/effect/bank_queue; ни одной ссылки на payment_orders/le_orders/le_order_effects. Unknown/running не освобождаются по TTL.
4. IDs: bank orderNumber с коротким префиксом LE2 и криптографически случайной частью, целиком в лимите provider (local handler ограничивает 32 символами); никакого slice после генерации. DB unique order_id/payment_id; versioned canonical fingerprint. Effects `v2:bank:<orderId>`, `v2:telegram:<method>:<transactionId>:<recipient>`, `v2:recipients:<method>:<orderId>`, отдельная таблица. Один bank payment принадлежит ровно одной namespace; DB unique в разных схемах не обеспечивает глобальную provider уникальность. Точный provider лимит ещё неизвестен и нуждается в согласованной проверке документации до активации.
5. Callback ownership: только exact v2 persisted mapping payment_id→order_id плюс проверенный provider status/amount/orderNumber и согласованная authenticity. Unknown/legacy payment никогда не захватывать, не auto-import и не notifier fallback. Если merchant умеет только один callback, отдельный callback relay/per-order callback или отдельный merchant требуют внешнего согласования; пока v2 card активация блокирована. Не менять legacy callback настройку ради v2.
6. Notification: собственный worker, неизменный recipient snapshot, per-recipient claims и общий/per-recipient budget, bounded queue. Предпочтителен отдельный v2 bot при будущей авторизации. Shared bot — только при доказанном routing через прежнего владельца webhook и общем бюджете обоих потоков; один бот не получает два независимых webhook. Callback data должна явно различать v2 сообщения. Общий merchant тоже делит bank quota, даже при отдельных таблицах.
7. Cron: только новые имена le-v2-payment-poll/le-v2-cod-delivery, отдельные auth secrets и Vault names, строго v2 routes/queue, ограниченные batch/time/effects; независимый kill switch. Не запускать старый retry SQL. Отмена v2 worker не отменяет legacy job; отключение create не прекращает обслуживание уже принятых v2 orders.
8. Limits: атомарный shared backend admission/request/replay budget и challenge до reserve/effects; отдельные internal/provider budgets, fail closed при недоступном store. Global provider budget должен учитывать legacy потребление либо иметь гарантированно выделенную квоту; отдельный process Map не распределённая защита. Production числа не выбирать без утверждённых объёмов/квот.

## Historical orders и rollback

Local notifyAlfaPayment (927–946) требует recipient snapshot для недоставленного card; payment_orders-only historical record его не имеет. Замена legacy handler может остановить уведомления старых заказов, даже при успешной оплате. Общая очередь также даёт гонку notified_at между двумя notifier; separate effects не предотвращают две внешние отправки из разных namespaces.

Старые записи/эффекты не копировать и не исправлять автоматически. Historical recovery — отдельная процедура с доказанными прежними адресатами/ownership/delivery evidence и разрешением; в этой задаче записей не читали. Rollback будущего v2: остановить новые create/admission, оставить bounded completion/status для принятых v2, сохранить unknown effects для review; не направлять их в legacy pay и не удалять queues. Не переключать pending old tabs по default endpoint.

## Unknown и следующий этап

Unknown: remote исходник pay v49; фактические schema/RPC/grants/RLS/storage policies; версии применённых migrations; enabled cron/auth/Vault; provider merchant/callback configuration; historical recipient snapshots; bank/Telegram quotas; catalog freshness; реальная атомарность Postgres/PostgREST/Edge. Метаданные списка функций этих вопросов не закрывают.

Допустимый следующий этап — отдельная локальная задача: новый pay-v2 scaffold, namespaced adapter/RPC draft и fake atomic admission store, synthetic fixtures с deny-by-default network. Проверить legacy endpoint/payload неизменность; отсутствие legacy table writes; concurrent IDs/replays; callback чужой namespace без effects; queue/retry ownership; missing schema/auth fail closed; bounded budgets; unknown-effect recovery; old pending compatibility. Fake/PGlite tests не доказывают реальную распределённую защиту.

Пока нельзя безопасно: deploy pay/v2, apply migrations/schema exposure/grants/RLS, менять secrets/cron/Vault/webhooks/merchant/бот, читать/переносить реальные заказы, делать bank/TG requests, активировать storefront/cutover, менять Timeweb/DNS/Taptop. Нужны concrete reviewable artifacts, подтверждённая ownership карта и отдельная авторизация на внешний rollout. Ничего из этого здесь не выполнено; Docker/Supabase runtime/install/build/test/commit/push не запускались. Изменён только этот новый документ, существующий dirty tree сохранён.
