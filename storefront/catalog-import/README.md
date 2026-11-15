# Локальная приёмка каталога

Этот инструмент сохраняет кандидат, но не меняет активный manifest, сборку, storefront config или удалённые ресурсы. `productionReady=false`, `freshness=unknown`, `dataAsOf=null` обязательны. Время получения и HTTP Last-Modified не являются подтверждением владельца или датой действия цен.

Команды из корня проекта:

```sh
node --test storefront/catalog-import/tests/import.test.mjs
node storefront/catalog-import/import.mjs check storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json
node storefront/catalog-import/import.mjs import /absolute/path/manifest.json storefront/catalog-import/candidates/new-review
```

`import` принимает пакет из manifest + trees/decor/promos CSV. Manifest schemaVersion=1, productionReady=false; для каждой записи feeds: path, status (`available` или `empty`), records, sha256, source, receivedAt ISO. Локальные файлы проходят checksum, schema, row count, ID/variant, money, active, promo validation. Raw rows и неактивные варианты не фильтруются. `empty` означает header-only валидный CSV; отсутствующий/unavailable feed блокирует приёмку. Symlink/path escaping блокируются. Имеющийся output не перезаписывается. Товарные ключи и доступные варианты дополнительно проверяются существующими shared product rules. Negative discount_pct сохранён по реальному pricing contract; ID декора вроде `1d` валидны.

Разрешённая отдельно сетевая команда:

```sh
node storefront/catalog-import/import.mjs fetch
```

Она проверяет точные public Storage URLs в src/catalog/config.js; три последовательных GET без credentials, redirects, 15s timeout, максимум 2MB на ответ. Ошибка любого feed останавливает приёмку без активации. Загружаются только CSV; photo URLs лишь инвентаризуются, запросов к изображениям нет. Кандидат появляется только после проверки всех входов. Для повторного сетевого запуска нужно сохранять исходный предел разрешения на публичное чтение.

`review.json`: полный row-level diff с derived snapshot; фото по product/variant, URL и позиции; точные missing URLs; saved-route media inventory; feed description issues; route/product coverage. Все имена/URL/порядок фото сохранены. Diff photos включает разные представления URL и ограниченную галерею старого снимка, поэтому changed row не равен изменению бизнес-данных. Route description metadata отдельно от feed: отсутствие текста в product-routes само по себе не доказывает отсутствие описания товара. Нет заявленной atomic consistency трёх отдельных публичных GET.
