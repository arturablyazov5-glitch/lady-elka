# Каталог принят владельцем — 04.10.2026

Владелец прямо подтвердил: «все что есть в супербазе сейчас — уже актуальное». Источник подтверждения — задание из чата `01a0f78c-c588-7841-9486-9234a6e1bfaf`, дата 04.10.2026. Подтверждение распространяется на цены, active, описания, фото и промокоды. Supabase — authoritative source для этого каталога; вопросы Дарины, 14 неактивных строк, промокода raf и пустых описаний сняты и повторно не задаются.

## Новый сохранённый снимок

[Manifest](</Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/catalog-import/candidates/2026-10-04-owner-confirmed/manifest.json>) закрепляет три свежих публичных CSV. Получены штатными fetchPublic/accept из существующего importer: только три последовательных GET точных public Storage URLs, без credentials/redirects, до 2 MB и 15 секунд на feed. Интервал UTC: trees 12:07:16.552Z, decor 12:07:17.137Z, promos 12:07:17.444Z 04.10.2026 (15:07 МСК).

`ownerAccepted=true`, `freshness=current-fetch-owner-confirmed`, `dataAsOf=null`, `productionReady=false`. Время получения не подставлено как историческая дата действия, а metadata Storage не объявлена merchant revision. Три GET не доказывают атомарный единый снимок базы. [Provenance](</Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/catalog-import/candidates/2026-10-04-owner-confirmed/provenance.json>) содержит источники, UTC, owner confirmation, хеши и сравнение.

| Данные | Свежая выгрузка | Изменение с 03.10 |
|---|---|---|
| Ёлки | 248 строк, 36 товаров, 234 активные строки | Нет, CSV побайтово идентичен |
| Декор | 9 строк, 5 товаров, все активны | Нет, CSV побайтово идентичен |
| Промокоды | 10 строк | Нет, CSV побайтово идентичен |
| Фото | 142 сохранённых файла, 1166 ссылок | Все URL/порядок совпадают; новых missing media нет |

Дарина зелёная 150 см: price 22 000 ₽, offer 31 429 ₽; 230 см: price 46 000 ₽, offer 65 715 ₽. 14 неактивных вариантов, 47 строк с пустыми/служебными описаниями у 19 товаров, три пустых photos декора и все промокоды сохранены без исправлений. Это принятые владельцем исходные данные. Никаких новых промоусловий, складских остатков или текстов не добавлено.

## Media reuse и закреплённый preview

Новый `media-manifest.json` создан внутри нового candidate. Старый media manifest не менялся. Проверены все 142 asset bytes/SHA256 и размеры; сохранены их original provenance. Новая привязка candidateFiles проверяет новые manifest/review/CSV, 1166 raw references проверены по точному URL, варианту, active, индексу и localPath через существующий validatePreviewInput. Образы повторно не загружались и не редактировались; размеры/декодирование этого запуска не объявлены отдельной новой проверкой.

Изолированный preview: [/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-confirmed-20261004-4jsiqp3k/preview](/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-confirmed-20261004-4jsiqp3k/preview/index.html). Источники явно заданы CLI, output вне репозитория:

```sh
node storefront/build.mjs --mode=preview \
  --input-manifest=storefront/catalog-import/candidates/2026-10-04-owner-confirmed/manifest.json \
  --media-manifest=storefront/catalog-import/candidates/2026-10-04-owner-confirmed/media-manifest.json \
  --output=/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-confirmed-20261004-4jsiqp3k/preview
```

Build exit 0, 42 product pages, 142 assets и 1166 references. Выходные offline CSV/страницы закреплены на новом candidate. Генератор неизменно выводит generic ownerAccepted=false и сообщение prices UNVERIFIED для любого candidate: исходник не менялся. Поэтому только в изолированном output build-manifest аннотирован ownerAccepted=true с owner confirmation и хешем исходного generated manifest; оригинал сохранён в `integration-qa/catalog-owner-review/generated-build-manifest.json`. Дополнительный output `owner-acceptance.json` закрепляет подтверждение и хеш input manifest. Это не production-ready/activation и не изменение default.

[Таблица владельца](</Users/rafael/Documents/Работа/Проекты/Lady Elka/integration-qa/catalog-owner-review/index.html>) обновлена: каталог принят, блокирующих вопросов нет. Прежняя таблица, расчёт и текст приёмки сохранены отдельно как `historical-oct3-owner-review.html`, `historical-oct3-comparison.json`, `historical-owner-acceptance.md`; historical evidence не переписаны. В таблице нет внешних запросов, изображений и checkout.

## Фактические targeted-проверки

```sh
node storefront/catalog-import/import.mjs check storefront/catalog-import/candidates/2026-10-04-owner-confirmed/manifest.json
node --test storefront/catalog-import/tests/import.test.mjs storefront/tests/catalog-media-preview.test.mjs
```

Importer check exit 0; targeted **12/12 pass**, fail/cancelled/skipped 0. Существующие tests проверяют importer и прежний candidate/default; новый candidate отдельно проверен readCandidate + validatePreviewInput и явным новым build. Это не заявление о browser QA нового preview: браузер не запускался. Логи, command/output pointer и verification сохранены в `integration-qa/catalog-owner-review/`.

Контрольные суммы прежнего candidate, старого media/default manifest, build-feed/build source и shared build report остались неизменны. Главные manifests/default snapshot, main dist, backend/app не менялись. Новые файлы только в разрешённом candidate, своей QA зоне и этом audit, плюс явно разрешённый isolated output вне main.

Каталог принят; готовность оплаты, реальная интеграция, permission push/deploy/publication — независимые gates и не разрешены этим подтверждением. Нет SQL/records/secrets/payment function access, writes Supabase, feed повторного refresh, новых пакетов, full suite, commit/push или publication.
