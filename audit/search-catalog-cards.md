# Поиск с каталоговыми карточками — 04.10.2026

Поиск остаётся на странице результатов при любом количестве совпадений. Товары используют тот же renderer, вариантные данные и cart hooks, что каталог; статья или служебная страница представлена отдельной карточкой. Главный снимок не активирован, productionReady=false.

## Изменения и источник перехода

`storefront/products/card-renderer.mjs` выделен из прежнего catalog-cards без второго шаблона. `catalog-cards.mjs` и build-search вызывают общие cardHtml/decorCardHtml. Search index содержит build-owned HTML карточки и сериализованные варианты из текущего build feed; клиент не ходит к внешним CSV. Пустые/неактивные товары остаются доступны для поиска как недоступные страницы, без фиктивных цен/вариантов или покупки.

`public/search.js` физически заменяет obsolete title/path row rendering: товарные карточки вставляются из trusted build index, статьи/страницы создаются текстовыми DOM карточками. Count, empty/error, query normalization, 10 результатов на страницу, pagination и прямые F5 routes сохранены. Фото/неинтерактивная область карточки и «Подробнее» переходят на товар; selectors и buy используют существующие bindings. CSS отдельный, двухколоночный на больших экранах/одноколоночный на мобильных; старый список не прячется CSS.

`client/product-ui.js` умеет идемпотентно привязать добавленные карточки (WeakSet), `client/index.js` слушает products-added; existing cart/galleries/checkout implementations не переписывались. `public/search.html` очищен от старых captured result rows/controls; build-search продолжает поддерживать ожидаемые container IDs и stylesheet. Полный текст новых blog records сохраняется в description индекса для body search.

Reported условный редирект в текущем search.js и static search template не найден. Общий builder storefront/build.mjs:133–143 уже удаляет captured inline executable scripts, включая legacy fast-search; build-search дополнительно удаляет прежний search embed. `src/static` каталога нет; src/catalog содержит payment-return redirect guard, он не менялся. В site-runtime существовал переход пустого запроса на /search, а непустой использовал native form action. Теперь любой submit формы с search input явно ведёт только `/search?search=...`, без поиска совпадения или автоматического выбора товара. Unrelated pseudo-link/modal/payment redirects не затронуты.

## Targeted evidence

```sh
node --test storefront/tests/taptop-search-routes.test.mjs storefront/tests/blog-publication.test.mjs storefront/tests/catalog-media-preview.test.mjs
```

**8/8 pass**, fail/cancelled/skipped 0, exit0, ~21.39s. Лог `/tmp/le-search-cards-final-tests.log`. Обновлены targeted assertions для product kind/shared card HTML/variants/cart hooks/физического отсутствия прежних строк и article kind. Existing blog regression реально проверяет поиск заголовка и текста статьи, direct/reload/list; search/media regression проверяет build counts и default сохранность. Это ещё не browser QA новых товарных selectors/cart/mobile layout: отдельный browser чат получает итоговый output.

## Принятый isolated preview

[/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-search-catalog-cards-20261004-4iabm2k_/preview](/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-search-catalog-cards-20261004-4iabm2k_/preview/index.html)

Build exit0; 57 search records, 40 активных товарных карточек и 2 недоступные product pages (Камила/Грация). Explicit input: `2026-10-04-owner-confirmed/manifest.json`; media input: **новый candidate/media-manifest.json**, корректно закрепляющий новый manifest/provenance. Указанный в задании старый Oct3 media manifest имеет хеш старого candidate и не подходит для нового manifest; он не редактировался. Новый media proof reuse уже проверенных142 assets/1166 references, без image GET. Новая сборка автоматически ownerAccepted=true, productionReady=false; output не патчился.

```sh
node storefront/server.mjs --mode=preview --root=/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-search-catalog-cards-20261004-4iabm2k_/preview
```

Build log рядом: `/var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-search-catalog-cards-20261004-4iabm2k_/build.log`; команда и counts также `/tmp/le-search-cards-output.json`. Main build/default snapshot/manifests/app/backend/payment/server не изменены этим этапом. Внешний fetch в новой сборке программно запрещён. Нет publication/install/commit/push/production действий.

## Изменённые файлы и SHA256

| Файл | SHA256 |
|---|---|
| `storefront/public/search.js` | `062e8fb180b4d92168d484cc5e96f1b85e41538ddaadef7f8c5dd21c1a6a2857` |
| `storefront/public/search.html` | `33cb4949dd13e1f51ee541bc7d65f95f99428b7d2790bcb98f97eed0873a914b` |
| `storefront/public/search-cards.css` | `8ad10be725ffc7a6285a1f22661d3163b264890edcaab271dfc6ad0d2fa2d7b3` |
| `storefront/public/f/site-runtime.js` | `b2a3bdb0b8fd3e120cc670df2fd47ba73efe5e941b44837cb4f9bae1734bd596` |
| `storefront/build-search.mjs` | `f2effa88bab7aa3bb4bf54c929d76a6f54180c3a13ff8094a6e7d9e72317d1e7` |
| `storefront/products/catalog-cards.mjs` | `bd9405a724a7d6e6652eb81e8326415792e6f7702b1babfd991ea9e323440583` |
| `storefront/products/card-renderer.mjs` | `e07c83b5ee03a4e9323c08b1af298bdef77cca8ecbce6ce2f7bdbd3fa90e3484` |
| `storefront/client/product-ui.js` | `b97d9486fd4267dc228b4328ed7c674122ad6c8627241e9b29338b898f68c60b` |
| `storefront/client/index.js` | `97c75f6d04c6a18b16f10f9adb525da0b0737bf26041dfc3ff1cf63cbf93a98f` |
| `storefront/tests/taptop-search-routes.test.mjs` | `b084b39d60de39b4165f691911a5f9c3c773ddb2b48715441821ca2d4be8df01` |
| `storefront/tests/blog-publication.test.mjs` | `b6ef1e7ba7a17027e18022b8110fdd0d0b715c7a712808758d527a867cd8534e` |

После этого отчёта source/output фиксируются для браузерного QA.
