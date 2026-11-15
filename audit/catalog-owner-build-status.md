# Статус принятого каталога в build и server — 04.10.2026

Генератор самостоятельно воспроизводит owner acceptance; сервер проверяет подтверждение перед запуском. Ручная аннотация output больше не нужна. `productionReady=false`, `dataAsOf=null`; подтверждение каталога не означает готовность оплаты или разрешение публикации.

## Изменения

- `storefront/products/owner-confirmation.mjs`: единая проверка local metadata. Accepted требует ownerAccepted/accepted=true, точную source kind/current Supabase authority, непустые source/quote, валидную календарную дату, полный набор prices/active/descriptions/media/promos, null historical date, freshness current-fetch-owner-confirmed, совпадение confirmation и feed source/receivedAt/SHA256 с provenance. Получение feed относится к дате подтверждения; историческая dataAsOf не выводится из fetch. Частичные/невалидные metadata отвергаются.
- `storefront/products/build-feed.mjs`: provenance читается с regular-file/realpath containment, проходит проверку и SHA256; candidate/media byte pinning сохранён.
- `storefront/build.mjs`: правильный ownerAccepted, ownerConfirmation, human catalogNotice и descriptor owner-provenance формируются из проверенного input; исходный provenance копируется побайтово в `__offline/catalog/owner-provenance.json`. Оба candidate статуса всегда preview only. Принятый вывод: «Каталог принят владельцем 2026-10-04: текущие публичные данные Supabase подтверждены. Историческая дата действия не установлена. Готовность оплаты и публикации не подтверждена.»
- `storefront/server.mjs`: для accepted artifact проверяет contained provenance file, размер/SHA256, совпадение с descriptor, полные metadata и согласованное human notice. Одного true недостаточно. Непринятый unsigned Oct3 candidate совместим; сочетание false с accepted metadata отвергается. Endpoint payment остаётся null; POST и внешние fallback не включены.

Новые targeted tests: `storefront/tests/catalog-owner-build-status.test.mjs`. Existing tests/source вне этих build/server touchpoints не менялись. Старые snapshots, main output, app/backend/payment и исторические отчёты не изменены.

## Проверка

```sh
node --test storefront/tests/catalog-owner-build-status.test.mjs storefront/tests/catalog-media-preview.test.mjs storefront/tests/candidate-preview-server.test.mjs
```

**9/9 pass**, fail/cancelled/skipped 0, exit0, ~9.05s. Лог: `/tmp/le-owner-build-server-targeted.log`. Проверены complete accepted metadata, старый candidate false, missing/invalid metadata, точная fetch date, independent payment false/dataAsOf null, fresh build без patch, штатный startup и HTTP page/CSV 200, POST405. Startup отказывает при tampered accepted/source/date/scope, отсутствии proof, false marker с accepted metadata и повреждении provenance. Existing candidate/default asset/path/symlink/CSV proof regressions прошли. Промежуточные 7/7 до добавления server проверок не подменяют итог9/9.

## Новый неизменённый output для browser QA

[/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/preview](/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/preview/index.html)

Build выполнен один раз для итогового output, external fetch запрещён программно. Exit0; snapshot id `2026-10-04-owner-confirmed`; 142 media assets / 1166 references; ownerAccepted=true; ownerConfirmation и исходные UTC feed времена сохранены. Build manifest после генератора не редактировался, sidecar patch отсутствует. Старый preview, который проверял другой чат, не затронут.

```sh
node storefront/server.mjs --mode=preview --root=/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/preview
```

Полный build command/log сохранён в `/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/build.log`; CLI использовал explicit input/media и isolated output. Локальное owner metadata — доверенные входные файлы, не цифровая подпись или доказательство production auth. Здесь browser QA не заявлена: следующий чат получает этот exact output.

## Фактические SHA256

| Файл | SHA256 |
|---|---|
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/build.mjs` | `c45af4c3f16cc5d6d5731b6ca5b3bee4c656c101de9d50ccd3f609f6e3c96e68` |
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/server.mjs` | `44faf2cd404b28028425ed46958815e5a01eb06b70aa97420e07661af0861cb2` |
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/products/build-feed.mjs` | `c2f759248c1154e29e9c32cb5f46f679bd0010a4cda3ce086286136677e9db54` |
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/products/owner-confirmation.mjs` | `acf47c7c9bb0184d6d72ff625dead52bbb274e36aac1e698fe380477f38eeae0` |
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/tests/catalog-owner-build-status.test.mjs` | `0ce1b6dc476615240bd6b4c83f23d7e78527ce56dfc090151870a3bc1ae3b676` |
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/catalog-import/candidates/2026-10-04-owner-confirmed/manifest.json` | `b62b63f7ea6898c65e753f4b02a893413538473c8410511e3b1c8da9085bf98e` |
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/catalog-import/candidates/2026-10-04-owner-confirmed/provenance.json` | `be91d25d568846d3a34e0566aedbb94466e77493477c3a74afc6c9c8a720c6cc` |
| `/Users/rafael/Documents/Работа/Проекты/Lady Elka/storefront/catalog-import/candidates/2026-10-04-owner-confirmed/media-manifest.json` | `78b0dc57b0fca550c20e01d444fd0a174857b9febab91db6bfb9edc6102e6420` |
| `/private/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/preview/build-manifest.json` | `94a05c4e3a658657738583527b611424cd8f41ddc10080f4c6e63f4813cae73e` |
| `/private/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-owner-build-native-20261004-rm0_yalj/preview/__offline/catalog/owner-provenance.json` | `be91d25d568846d3a34e0566aedbb94466e77493477c3a74afc6c9c8a720c6cc` |

Старый candidate/media/default manifest и shared build report сверены с сохранёнными хешами и не изменены. Source изменения только указанные build/server modules плюс новые tests/audit. Нет live fetch, writes Supabase, installs, full suite, commit/push, publication или production действий. Исторические отчёты с ручным patch остаются историей предыдущего output; этот output создан новым генератором без поправок.
