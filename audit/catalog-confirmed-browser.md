# Browser QA принятого каталога — 04.10.2026

**PASS для нового штатного preview** /var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/preview. Snapshot 2026-10-04-owner-confirmed, ownerAccepted=true; checkout не отправлялся. Исходники/оба output read-only; изменены только собственные integration-qa/catalog-confirmed-browser/** и этот audit. Без production, внешних API, install, commit/push/full suite.

## Запуск и границы

```sh
node integration-qa/catalog-confirmed-browser/run.mjs \
  /var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/preview
```

Runner использует существующий candidate-preview-server-browser helper как основу, запускает именно штатный node storefront/server.mjs --mode=preview --root=<exact root> с портом 0 и настоящее установленное Google Chrome headless в отдельном временном профиле. До первой navigation включён CDP Fetch intercept: только GET на точный localhost origin разрешён; внешний origin отклоняется. Dead proxy, DNS deny, disable background networking дополняют запрет. Network response statuses и runtime exceptions собираются. Navigation/F5 ждут нового Page.loadEventFired, не старый DOM. Profile, Chrome и server закрыты после проверки. Собственный static server не используется.

## Результат

Exit 0. Проверены 5 product routes и **34 активных варианта**: Miranda 18, Darina 6, Vita 10. Каждый выбор сравнивает видимую цену, main image и точный secondary order с embedded variant; photo arrays дополнительно сверены с соответствующей строкой bundled CSV, без выдуманного fallback. Для каждого выбранного варианта gallery images decode успешно. Product routes проверены после F5, открытие/закрытие gallery работает.

Дарина зелёная 150 см: **22 000 ₽**, 230 см: **46 000 ₽**. Реально выбран вариант 230 см, добавлен через product buy UI, quantity увеличено кнопкой корзины до 2. Storage содержит productId=13, variantId=13:Зелёная:230, price=46000, quantity=2. После F5 все поля/изображение/вариант сохранены; корзина визуально показывает 2 шт. и **92 000 ₽**. Checkout submit/промокод/платёж не выполнялись.

Карточки каталога отрисованы (19 product roots на проверенной странице), поиск «Дарина» дал /tree/darina. Непринятые active=false варианты не появляются в offer model/выборе: у Vita отсутствуют пять «С освещением», но 10 действующих вариантов остаются доступны; у Camila/Gracia ноль selectable вариантов и buy aria-disabled=true. Всего 14 inactive строк для этих трёх товаров проверены по соответствующей bundled CSV. Вита целиком не объявляется неактивной.

**External requests=0, runtime exceptions=0, HTTP errors (включая 404)=0, write requests=0** в успешном финальном запуске. Отчёт result.json и browser.log. Скриншоты catalog.png, search.png, miranda.png, darina.png, inactive-18.png, inactive-19.png, cart.png, cart-reload.png; catalog и cart-reload просмотрены инструментом изображения, карточки и сохранённая корзина видны.

SHA-256 build-manifest после QA: 94a05c4e3a658657738583527b611424cd8f41ddc10080f4c6e63f4813cae73e — совпадает с audit/catalog-owner-build-status.md. Manifest не редактировался. Это browser proof нового output; отсутствие ручного patch и generator metadata относится к отдельному build audit, не выводится только из браузера.

## Сохранённая история отказа

Старый вручную аннотированный output le-owner-confirmed-20261004-4jsiqp3k/preview штатный старый server отклонил с Invalid candidate preview build manifest: прежняя storefront/server.mjs:36 требовала ownerAccepted=false, ошибка :38. Browser тогда не запускался. Исходный результат/отчёт сохранены как initial-refusal.json и initial-refusal.md; старый output не исправлен и не переименован в PASS.

Первая попытка собственного нового runner прошла variant checks, но остановилась в setup корзины: он предполагал category select у Дарины, тогда как category единственная и select отсутствует. Это harness TypeError, сохранён в first-run-harness-error.log. Исправлен только собственный runner, добавлена проверка наличия select и ожидание actual navigation load. Финальный отдельный профиль дал описанный PASS, без изменения исходников сайта. Полный suite не запускался.

## Что это не доказывает

Проверка локальная: bundled CSV/media, локальный preview endpoint, isolated browser. Она не подтверждает production deployment, реальные payments/providers, актуальное live CRUD или готовность production checkout. Catalog принят владельцем; publication/payment gates независимы и остаются productionReady=false. Прежний ручной output не заменяет новое generator evidence. QA не меняла данные источника/active/цены/описания/promos.
