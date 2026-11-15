# Browser QA поиска с карточками — 04.10.2026

Статус: **проверка завершена с двумя gaps, полного PASS нет**. Exact output /var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-search-catalog-cards-20261004-4iabm2k_/preview. Source/output автора read-only. Собственные runner/scenario/results/log/screens сохранены только integration-qa/search-cards/**. No install/commit/push/full suite/production. Checkout не отправлялся.

```sh
node integration-qa/search-cards/run.mjs \
  /var/folders/w9/j9rh714j5yz8_728686xln_80000gn/T/le-search-catalog-cards-20261004-4iabm2k_/preview
```

Штатный storefront/server.mjs --mode=preview --root=exact output, Google Chrome headless, новый профиль. GET exact loopback-only Fetch interceptor, dead proxy/DNS deny до navigation. Источники и цены не подменялись; bank mock не нужен. Процессы/profile закрыты. Итоговый runner exit0 означает завершение остальных checks с отдельно записанными gaps, не весь acceptance PASS.

## Подтверждено

12 actual Enter/button submissions: три запроса «Миранда», «ёлка», «Дарина» × две отправки × desktop1400/mobile390. После render и settling interval /search сохраняется, query совпадает, автоматического перехода на товар/catalog нет. Desktop header input в штатном CSS скрыт: путь кнопка-иконка шапки → /search → видимая search form. На mobile actual header form доступен через menu burger. Hidden input программно не заполняется, display/style не меняется. Поэтому прямой Enter из desktop header не заявлен — там нет видимого поля.

Карточки используют catalog product-card structure и serialized variants; visible Darina price меняется при выборе высоты230 на46000. Actual buy action и cart-up дают productId13, variantId13:Зелёная:230, quantity2, price46000; все поля сохраняются после F5. Explicit «Подробнее» даёт /tree/darina. Никакой checkout submit.

Empty query «Введите запрос» и zero-match «Ничего не найдено» проверены. «ёлка» даёт следующую страницу, query retained; /search/p/1 content совпадает после F5. Статья найдена по заголовку, explicit article link работает и direct page reload не даёт HTTP error.

Desktop/mobile карточки лежат в viewport bounds; document scrollWidth не превышает width+1, layoutGaps=[]. Screenshot mobile-results просмотрен: одна колонка, controls шириной контейнера, текст не обрезается по горизонтали. Vertical scrolling viewport нормально, это не обещание всех controls одновременно на экране.

External requests=[], runtimeErrors=[], HTTPerrors=[] (включая404), writeRequests=0 в итоговом проходе. Image decoding выполнялось для всех result images; единственный broken source вынесен в gap, а не проигнорирован. Не тестируется lightbox gallery на карточке поиска: shared catalog card содержит main image, не product-detail gallery. Порядок product gallery уже подтверждён отдельным accepted catalog QA; здесь проверен main image и variant binding.

## Конкретные gaps

1. **Пустое фото Весты выводится как сломанный img.** Trigger: desktop/mobile query «ёлка», Enter или button. Card «Настольная елка Веста» source photos пуст по legitimate accepted CSV. storefront/products/card-renderer.mjs:45 безусловно вставляет img src=imageFor(first), результат src=""; `.search-result__list [data-storefront-image] img` decode даёт EncodingError, alt отображается вместо фото. screenshot vesta-empty-photo.png. Четыре одинаковых observations в imageGaps (две отправки × два viewport). Не нужно менять Supabase фото или выдумывать image; нужен корректный no-photo renderer. Автор уведомлён до каких-либо source правок, дефект принят координатором.
2. **Body search статей не доказуем на этом output.** Обе article записи search-index.json имеют description="". Title search работает; bodyArticleDataAvailable=false/bodyVerified=false. Пользовательская проверка «статьи/bodysearch не потеряны» не может быть закрыта имитацией или предыдущими unit tests. Координатор передал автору legacy article body index исправление. Реальных source статьи/body data не изменял.

## Evidence и собственный harness

result.json содержит12 submissions/route results, cart, pagination/title flags, gaps и network/runtime totals; browser.log, desktop-results.png, mobile-results.png, cart.png, article-results.png, pagination.png. vesta-empty-photo.png/image-failure.log сохраняют исходный product defect. failure-state.json/header-before.png — диагностические материалы, не итоговый PASS.

Первый harness ошибочно ожидал видимое поле непосредственно в desktop header, исправлен только собственный сценарий на фактический icon→search path. Второй технический assert ошибочно сбрасывал tree height через отсутствующий size dimension; исправлена только QA selection loop, теперь обрабатывает существующие options. Это не дефекты product runtime. Реальный no-photo defect сохранён отдельно; последующий runner собирает decode failures без исключения, чтобы завершить независимые cases. Browser suite автора/общие тесты не запускались.

Ждём новый immutable output после renderer/body-index fix. Повторять требуется затронутые result image/body cases и зависимые product interactions; прежние результаты не переносить на новый output без сверки. Production/publication отдельно не разрешены.
