# Текущая публичная выгрузка каталога — 03.10.2026

Получена только публичными GET Supabase Storage: три CSV без credentials, redirects и изображений; timeout 15 секунд, максимум 2 MB каждый. Точные URL подтверждены src/catalog/config.js и app/server экспортом. Рабочие заказы/админские записи, секреты, функции оплаты/cron/TG и исходный сайт не запрашивались.

Кандидат: `storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json`. Полные raw CSV и `review.json` рядом. Не активирован: сборка и defaultManifest прежние, productionReady=false, freshness=unknown, dataAsOf=null.

| Feed | Получен UTC / МСК | HTTP | Строк | Товаров | Активных строк |
| --- | --- | --- | --- | --- | --- |
| trees | 2026-10-03T12:54:39.004Z / 15:54:39 | 200 | 248 | 36 | 234 |
| decor | 2026-10-03T12:54:39.124Z / 15:54:39 | 200 | 9 | 5 | 9 |
| promos | 2026-10-03T12:54:39.680Z / 15:54:39 | 200 | 10 | — | — |

Сохранены 14 неактивных tree rows: 5 вариантов Виты ID 15 «С освещением», 4 Камилы ID 18, 5 Грации ID 19. Decor: все 9 строк активны. Promos: 10 опубликованных включённых кодов; отсутствующие выключенные коды не сочинялись. Экспорт не содержит сроков, лимитов использования и дополнительных scopes — это не доказательство их отсутствия в бизнесе.

## Diff относительно производного снимка 01.10

- Ёлки: 236 → 248 строк; восстановлены 14 исходных variant rows, удалены две производные пустые строки `18::` / `19::`. Все 36 tree IDs и 5 decor IDs имеют сохранённые маршруты; новых product IDs нет.
- Из 234 совпавших tree variant IDs изменены photos в 234 строках (старый снимок сохранял локальную презентацию с неполной галереей), title в 4, price/offer в 2. Декор: 9 совпавших строк, цены неизменны; полный список полей в review.json.
- Дарина `13:Зелёная:150`: 13 000 → 22 000 ₽, offer 18 572 → 31 429 ₽; `13:Зелёная:230`: 28 000 → 46 000 ₽, offer 40 000 → 65 715 ₽. Это значения CSV на момент получения; автор/причина изменения и подтверждение владельца не установлены.
- Старый promos status=unavailable; новый содержит 10 строк. Это получение ранее отсутствовавшего входа, а не появление десяти новых бизнес-кодов.

## Фото и описания

Текущие raw photos: 1166 ссылок по вариантам, 731 имеют локальный файл, 435 отсутствуют. Уникальных URL 142, отсутствующих 75. Все 75 missing URLs перечислены ниже и с exact productId/variantId/index в review.json. Saved-route images проверены отдельно: отсутствующих 0; это не покрывает текущую публичную галерею.

Описание пустое/«-»/«Текст»: 47 variant rows, 19 уникальных товаров. В текущем feed placeholder «Текст» обнаружен также у Элизабет ID 17, помимо Каролины ID 34 и Мишель ID 35. Пустые tree IDs: 17, 20–33; decor IDs: 4d (сумка), 5d. Эти выводы по текущим raw descriptions; прежний список 17 товаров из derived snapshot не заменяет эту проверку.

## Что остаётся подтвердить владельцу

1. Дату действия каталога, цены/offer/discount и active всех вариантов; отдельно два отличающихся значения Дарины. Retrieval time/Last-Modified/checksum не дают бизнес-подтверждения и истории редактора.
2. Условия десяти промокодов и достаточность текущего экспортного контракта (сроки/лимиты/scopes не представлены).
3. 75 отсутствующих локальных фото: утверждённый полный набор и порядок по variantId; remote images не скачивались.
4. Пустые/placeholder описания по приведённым ID; не генерировать текст вместо утверждения.
5. Основной маршрут/alias ID 28: обе сохранённые формы URL оставлены; редиректы не применялись.

## Проверки и пределы

8/8 offline tests: malformed/schema/missing feed; checksum/count/status/traversal; duplicate variants/incompatible IDs; invalid finite money/active; promo errors; shared storefront acceptance и сохранение inactive rows; empty vs unavailable; bounded public GET на mock; отказ перезаписи существующего/внешнего output. Live evidence — отдельно три успешных публичных GET и чтение сохранённого кандидата. Фото проверены исключительно по локальным файлам, внешние images не запрашивались. Текущая сборка/checkout/providers не запускались и не объявлены проверенными.

Полные источники и checksum/records/receivedAt/ETag/Last-Modified сохранены в manifest. Никакой активации/деплоя/commit/push; файлы только в catalog-import и этот отчёт.

## Missing unique photo URLs

- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/b5bfba10-02a4-4996-9b5c-da38fb0e600d.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/206bfa3d-6199-4b74-8b24-a25ff8f2e867.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/0b5b3a49-1338-47e7-944b-00a2dda98af7.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/1c557ca7-7b46-4ea8-94b8-a729290cce25.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/741b65c8-ded4-427e-8a93-05274f48b0b6.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/1adfc32c-4ccf-4c33-a0ba-2c8143d993c6.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/7cb3f523-0a40-45c6-aa2a-e77ea4dd0dd4.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/f767fa80-8877-4a40-9338-af2292e4d7b5.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/8e3af3f8-9b23-46ab-abe7-04bf10e6fe22.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/c7767e78-a593-4fe7-a771-dee5ff0c7b0d.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/a6819a90-8029-4cef-8c60-d8361bb455c6.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/5e8c5a14-e0c4-4338-b77a-d2d004f1d105.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/cdaa0202-570a-4199-9fc2-cde78340899a.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/5dcf6c05-62a4-4e7f-a1f2-f22da2346a63.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/3479f158-94db-4c02-9fc5-98d8fdd08c94.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/14abdee1-f1b3-45b1-9795-bdbb5af04095.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/a5dd217c-52ea-4ef3-adb7-51de3ecb51f7.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/2e420355-b90c-4d98-9c6e-b708e2c0701f.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/2b6c1383-0bfb-4676-aaa4-30bcd5bcfa85.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/b6e31517-bbfc-4fe4-8dca-77da3e1bab5f.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/6ad30167-ab71-438c-b7df-68b416f5f501.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/afa49895-b5aa-4261-af17-c11a2ab28a0d.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/24a7c5bd-640c-4c06-987c-ef235ff419bf.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/b06f2dbf-07d1-4c52-94a3-aa93d0fa611d.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/5506b9a6-0df9-4aa0-a4d6-80c92830dcc5.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/fbb98f81-ba40-4339-99c2-3166b5d4beaa.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/d27af7ec-4d05-472f-8280-439e60a1591b.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/e085a4a0-dbec-4fb8-a051-281a630d58ff.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/49ef4505-f199-4f05-acd6-db4e8bfa03f1.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/234ccf5a-18b3-4522-9a07-9a675c985ba0.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/2d03590a-e41a-4cd9-9093-adadf26224cf.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/73d3e099-4246-49f4-be64-a84177e1ea4b.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/1ad98462-b630-4154-8fa4-4654222928e7.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/35e2d0e7-fb20-4db8-92e9-901f1e6ad713.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/cec0d20f-c588-42df-a755-000bdee1fba1.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/d897af4c-c7ea-4618-b367-a5b26b4d657b.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/6b8187fa-d17b-48fb-a236-1eece22cf91e.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/6082d751-f63c-4993-ac27-7eed8c7942fc.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/2735be09-d1a6-47e4-a6d8-990578065655.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/b945ce98-7ac8-46cb-8b20-d0ba173646c7.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/d4c110eb-140e-44d4-8ec0-1cbad87dbcb5.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/4e4e8dc2-dbe2-4019-a4c9-85d4686e178a.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/b2918672-1cb7-439b-8ca0-8a8082f60d14.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/05c00530-517c-4ba1-b34b-a17dc2b9fc86.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/4928e769-604e-4f11-95e3-48432dacac3c.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/5fc52e4f-2e93-4a6d-9cc7-0b14e65a9a44.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/89e6f610-c24f-4eef-aaff-634e70860518.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/7490d965-fb97-4bb4-bd72-0c52edd1d5ab.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/704370e7-0d01-4d15-bfa9-b25a7c8ee603.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/257ab2ab-ebcc-4c26-a67f-6780f3b9442d.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/f43298f9-2d30-48d2-8ca0-2cad78583050.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/ad007ff8-3d49-4ace-90ff-036d1d92f5e7.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/f1e7f190-3c78-405f-b64a-e75b18719631.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/d7929066-a3e6-42be-b111-d9d59867d254.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/cffaa153-743c-42bc-b6ce-6982e6b847c7.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/0534b264-b96a-427d-8446-7e8d0725a3fe.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/8ba1c5e8-dcf2-48d2-91f6-3686e1a943bb.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/a2dcf05a-fcf1-46b9-a7b8-bcc5765fdb27.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/d6670ffe-ae1b-4082-ba0b-94e883cd9014.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/c106f3ef-5980-4175-acff-89352e71c5d7.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/bfa2d5db-2058-41a7-85f1-4ab5fca77ba5.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/41698f15-f6ae-40cf-95b3-501d90b57280.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/63b5ff11-a5f0-4754-b3bf-bc8699a0c224.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/c120fc52-d822-4de8-8eaa-67deddb7c346.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/25365279-6cad-4ed1-a790-46ddcb1e4436.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/12e428e4-fabd-4e70-98c8-197b56d6dfdf.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/3a712b43-3f16-4381-86eb-4807c712ef78.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/f2a02f67-c55a-4f8a-bbed-61518a7d2d17.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/d8b85ea5-fb5c-42ba-99c4-f262c4c193b6.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/ec69bf8c-3645-4c4d-8583-02bdf74111fd.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/ecb8bb45-8c34-4b36-811c-a17935df3a2a.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/d5ba660d-a158-40dd-b207-f3138cc9ffe6.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/6ae788ba-213d-4999-8721-29369411aaf8.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/f0f356a4-3edf-4818-9ada-bebf556b6e01.webp`
- `https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-images/03c25f1d-1fbc-4aab-8f67-10558264dd8f.webp`
