# Исправление checkout и подтверждения оплаты — 13 октября 2026

**Backend исправлен и развёрнут; frontend опубликован на техническом домене предыдущим разрешённым релизом. Lead CORS/claim/retry проверены 13 октября; real paid и SSL apex/www остаются незакрытыми. Домен пока не переключать.**


### Узкая актуализация lead — 13 октября, 09:16 МСК

Lead v8: technical origin добавлен только в handler, все configured origins/apex/www сохранены; применён только reviewed `20261008125000_lead_claim_backoff.sql`, атомарные backoff/attempt cap. Существующий retry enabled=true/cron6 active=true включён после 32/32 synthetic tests и проверки пустой очереди под lock. Два live scheduled cron runs succeeded; итог pending/failed/lease/unknown=0. Non-lead function metadata, RPC hashes/grants и все прочие cron неизменны.

Единственная QA `b168bf8f-d541-4cb0-ad7b-03401ba76c9f` доставлена за одну попытку. Личный ACK message_id=218 и групповой ACK=296 получены в 09:13:20–21 МСК **до уточнения пользователя о запрете групповых QA**, обработанного в 09:14:36. После уточнения нет новых отправок/повторов/удаления сообщений. Private-only QA route не добавлялся и не проверялся; дополнительная QA запрещена. Глобальные recipients/tokens не менялись. Проверка cron после уточнения только read-only и без сообщений.

Полный узкий результат, снимки и откат: `/Users/rafael/Documents/lady-elka-release-2026-10-13/codex1-leads-fix/result.md`, `rollback.md`, `evidence/`. Этот прогон не выполнял Git push, frontend deploy, банковских действий, DNS/binding или изменений pay/webhook. Ниже артефакты подготовки payment релиза описывают исходное состояние; публикация уже подтверждена `codex1-handoff` и текущим exact-byte smoke 8 frontend файлов.

## Что исправлено

- Production frontend обращается к отдельному `pay-v2`. COD оформляется и сохраняется без регистрации банковского счёта. Повтор принятого заказа не создаёт второй счёт/уведомление. Сохранённый pending привязан к конкретному endpoint; неопределённый заказ прежней версии нельзя повторно зарегистрировать через новый backend.
- `pay-v2` ACTIVE, admission open. Изолированные таблицы `le_v2_*`; старый `pay` и его очереди не заменены. `NEW_ORDER_ADMISSION` и авторизация worker имеют отдельные V2 env names.
- Собственный cron `lady-elka-v2-worker` каждые 2 минуты проверяет карточные заказы через Alfa getOrderStatusExtended и повторяет доставку COD. В банке не менялись merchant/static callback и настройки PayKeeper.
- Перед paid проверяются номер, payment ID, сумма в копейках и непротиворечивое банковское состояние. Авторизация и неоплаченный счёт не становятся paid. Проверка доступна только по точному сохранённому payload заказа; по одному номеру нельзя запросить банк или получить данные покупателя.
- Paid сохраняется до доставки Telegram. Неудачная доставка не скрывает оплату. Повторы не рассылают сообщения успешным получателям; definite failures имеют backoff и максимум 5 попыток, unknown/running автоматически не повторяются. Неоплаченные заказы старше 48 часов не опрашиваются бесконечно; подтверждённые paid повторяют доставку без нового запроса банка. Диагностическая запись прошлого тестового счёта не считается пользовательским заказом.
- Worker использует HMAC подпись action/time/nonce. В HTTP-очередь не попадает reusable secret; nonce одноразовый, подпись ограничена временем. Vault secret доступен только серверу. Replay/wrong-action/unsigned запросы проверены на live endpoint.
- `/spasibo` и `/pay-return` проверяют оплату после банковского возврата. Корзина и форма сохраняются при отмене/ошибке; очищается только корзина, соответствующая оплаченному заказу. Добавленные позднее товары не удаляются. F5 после подтверждения снова проверяет сохранённый receipt и не дублирует уведомление. Ошибка возврата без данных заказа сохраняет безопасный заголовок «Оплата не завершена».
- Старый Telegram webhook остаётся у `pay`: карточные кнопки используют совместимый прежний message-only контракт; COD не содержит ссылки на несуществующую банковскую операцию. Кнопок изменения статуса для новых COD сообщений нет.

## Проверки

- 7/7 финальных V2 tests: реальный Deno entry + PostgreSQL fixture, COD/card, статус, worker, частичный отказ Telegram и повтор, изоляция/права и HMAC/replay.
- 8 сквозных Chrome сценариев текущих frontend модулей + текущий V2 entry + PostgreSQL: неоплаченный/paid/cancelled возврат, банк недоступен, F5, изменённая корзина, неизвестный заказ и legacy pending. Банк/Telegram в этом сценарии синтетические.
- Полная production HTML/CSS/JS проверена при 390 и 1440 px: paid интерфейс, очистка корзины, отсутствие overflow. Все внешние запросы перехвачены тестом. Screenshots находятся в каталоге релиза.
- 15 Chrome сценариев корзины; 131 форма на 52 адресах, 131 сохранённая заявка и синтетическая доставка. Дополнительная регрессия: основной прогон 184/185; найденная ошибка заголовка исправлена, соответствующий тест повторно прошёл 1/1. Ошибка в первой проверке полной страницы оказалась ошибкой тестового сервера, исправлена и перепроверена.
- Production build завершён. Старые 736 immutable assets технического домена проверены SHA256 и сохранены для открытых вкладок. Source patch включён вместе с /site: автоматическая пересборка каталога сохранит новый endpoint и возврат.
- Live: подписанный worker HTTP 200, replay 409, wrong action/unsigned 401; CORS apex/www/technical 204, чужой origin 403; неизвестный заказ 404 без банковского вызова. Три последние реальные cron runs succeeded; оба исходных HTTP задания 200, очереди пустые.
- Read-only банк 13 октября: существующий тестовый счёт 100 ₽, HTTP 200/errorCode=0, orderStatus=6 (отклонён/истёк), номер/сумма совпали. Новых счетов, списаний и сообщений в этой проверке нет.
- Код legacy `pay` совпадает по SHA256 с исходным, прежние cron commands/schedules/active flags совпадают. Supabase повысил номер legacy функции 52→53 после добавления новых project secrets; это не замена её bundle.

Доказательства: `pay-v2/operations-tests-final-2026-10-13.log`, `payment-return-browser.json`, `payment-return-artifact-browser.json`, `forms-final-2026-10-13.log`, `return-route-regression-2026-10-13.log`, `activation.json`, `live-operational-checks-2026-10-13.json`, `final-deployment-2026-10-13.json`, `bank-readonly-2026-10-13.json`, `previous-live-assets-complete.json`.

## Подготовленный релиз

- Артефакт: `/Users/rafael/Documents/lady-elka-release-2026-10-13/final-site`.
- Отдельный Git worktree: `/Users/rafael/Documents/lady-elka-release-2026-10-13/repository`, ветка `codex/payment-launch-fix`, база remote main `b999f2b`.
- Только 5 исходных frontend файлов изменены относительно remote main; также подготовлены generated /site и pending metadata; существующий immutable snapshot сохранён, его CSV совпали побайтно с проверенными данными. Исходный checkout `/Users/rafael/Documents/lady-elka-cloud-preview` с чужим dirty README сохранён.
- `publication-plan.json` содержит порядок: non-force push согласованного релиза → один Timeweb deploy → live exact-byte/checkout QA → подтверждение active pointer только после успешного deployment. Pending и pointer пока существуют только локально.

## Что остаётся до домена

Frontend опубликован предыдущим разрешённым релизом; lead CORS/atomic claim/retry закрыты текущей узкой проверкой (с фактической QA доставкой до отзыва групповой авторизации, см. выше). Успешная реальная оплата и её автоматическое уведомление ещё не проверены: сквозной paid сценарий использовал имитацию банка/Telegram. Привязка apex/www и SSL на Timeweb остаются отдельными пунктами проверки запуска. Дополнительных QA отправок нет.

DNS, существующий frontend на домене lady-elka.ru, webhook банка/Telegram и старые cron не менялись. Это разрешение на подготовку релиза, а не заключение о готовности переключения домена.
