# Изолированный checkout pay-v2

Актуально на 13 октября 2026: **ACTIVE / admission open**, отдельный worker `lady-elka-v2-worker` каждые 2 минуты. Исправленный frontend подготовлен локально и не опубликован. Подробности и пределы проверки: [../payment-fix-2026-10-13.md](../payment-fix-2026-10-13.md).

`prepare-pay-v2.mjs` генерирует index.ts из canonical pay, добавляя isolatedStoragePath, V2 operations, собственные env names и HMAC admission gate. Generated файл вручную не править. `operations.mjs` содержит Alfa reconciliation/status/poll; `worker-auth.mjs` проверяет подпись, время и одноразовый nonce.

Старый pay bundle и cron сохранены. Merchant callback и Telegram webhook не переключались. У карточных сообщений сохраняется прежний контракт message-only status buttons; новые COD сообщения не содержат банковских/интерактивных status buttons.

Vault secret `lady_elka_v2_worker_token` соответствует Edge `LE_V2_WORKER_TOKEN`. SQL `20261012140000_pay_v2_worker.sql` подписывает два запроса; повторяемый секрет не хранится в cron command или pg_net queue. Edge storage allowlist допускает только le_v2 таблицы/RPC; worker ограничен проверкой и доставкой сохранённых V2 заказов. Диагностический счёт от 12 октября существует только в le_v2_payment_orders и не выбирается worker.

Первичная migration `20261012120000_pay_v2_isolated.sql` уже применена; общий `supabase db push` и повторное создание таблиц не нужны. Subsequent code deploy: только `pay-v2 --no-verify-jwt --use-api`. Скрипт `activate-pay-v2.mjs` проверяет отсутствие принятых V2 orders и предназначен для первоначальной активации, не для routine deploy существующей системы.

Безопасное закрытие новых заказов: отдельный `LE_V2_NEW_ORDER_ADMISSION` закрыть, сохранив `LE_V2_ADMISSION=enabled`, чтобы проверки оплат и worker продолжали работать для принятых заказов. `LE_V2_ADMISSION` закрывает все маршруты и годится только для полного аварийного отключения. Legacy env/secrets не менять.

Новые реальные платежи и Telegram сообщения 13 октября не создавались. Paid E2E использовал synthetic providers; после разрешённой frontend публикации ещё требуется live QA. Доказательства в JSON/log рядом с этим файлом.
