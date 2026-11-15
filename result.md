Опубликовано: https://lady-elka.ru/

Точные URL:

- YouTube: https://youtube.com/@lady-elka?si=pS-B5WV2TfygvnP8
- Instagram: https://instagram.com/lady_elka.ru?exln=aG5teWx3ZGZ3enE0

Active SHA: `114773158a02fe6b278f4e7b8df345508325f0f5`. Timeweb app266305, deploy `dc0a87c5-bea4-4809-9dbf-96f14b60f1ac`: **success**, app **active**, exact SHA подтверждён повторно после ACK.
ACK / remote main: `d02f265e9f0ddc7ddbae5287f35d48f524bd9da3`. Оба push обычные. Второго deploy нет, auto deploy выключен. Publication lock удерживался до success, live proof и ACK, затем освобождён.

Начальная свежая проверка: remote main `60d0ea6c6ca6cfa422dee01a06e38e7b9b5388ac`, active `7a7ff8195c7f9f14b5f58ad2b528d0af45186047`; незавершённых deploy не было. Изолированный worktree использует shared Git objects, без clone/repack/dissociate/forcepush.

Изменены только общий генератор `storefront/build.mjs` и 86 generated HTML. Включены 404, pay-return и Instagram в юридических текстах. Всего заменено 176 href: 86 YouTube и 90 Instagram. Независимый HTML-разбор проверил все 89 HTML-файлов, включая служебную QA-страницу без социальных ссылок. Все прочие ссылки и атрибуты якорей, включая target/rel, сохранены. Полная offline production-сборка выполнена; каждый публикуемый HTML побайтно равен прежнему после только заданной замены href.

2066 прочих публичных файлов сохранены побайтно, включая фото, иконки, CSS/JS и service worker. Новые фото, отступы, меню, URLtype и lazy сохранены. Сборка пересчитала release digest service worker; для минимального релиза опубликованный sw.js/sw-kill.js сохранён. Старые assets и 12 прежних миниатюр оставлены для отката, удалений assets нет. ACK удалил только служебный catalog-state/pending.json, site tree и active snapshot не изменены.

Chrome: главная и каталог, 1440×1000 и 390×844 — локально и на полученном live HTML. Instagram/YouTube видимы, имеют точный href, проверка доступности клика (trial) проходит. Переходы в соцсети не выполнялись; ошибки JS: 0. Скриншоты локальной и live-фаз просмотрены визуально.

Live: ровно 2 GET сайта — / и /catalog/, HTTP 200, TLS проверен, HTML побайтно совпал с релизным. Live-скриншоты используют полученный production HTML и неизменённые локальные assets; повторных запросов assets к сайту нет. Внешние запросы браузера и API маршруты блокировались. Формы не заполнялись и не отправлялись; БД, DNS, quota, покупки, orders, payments, TG и логины не использовались. Секреты leadEnv не выводились. Исходный dirty worktree и пользовательские файлы сохранены. Субагенты не запускались.

Скриншоты:

- [live-home-desktop.png](/Users/rafael/Documents/Работа/Проекты/Lady Elka/.codex-work/lady-elka-release-2026-10-14/codex1-social-links/screenshots/live-home-desktop.png)
- [live-home-mobile.png](/Users/rafael/Documents/Работа/Проекты/Lady Elka/.codex-work/lady-elka-release-2026-10-14/codex1-social-links/screenshots/live-home-mobile.png)
- [live-catalog-desktop.png](/Users/rafael/Documents/Работа/Проекты/Lady Elka/.codex-work/lady-elka-release-2026-10-14/codex1-social-links/screenshots/live-catalog-desktop.png)
- [live-catalog-mobile.png](/Users/rafael/Documents/Работа/Проекты/Lady Elka/.codex-work/lady-elka-release-2026-10-14/codex1-social-links/screenshots/live-catalog-mobile.png)

Доказательства: /Users/rafael/Documents/Работа/Проекты/Lady Elka/.codex-work/lady-elka-release-2026-10-14/codex1-social-links/evidence/ — build-verification.json, all-page-links.json, release-scope.json, local-browser.json, live-browser.json, deployed.json, acknowledgement.json; финальная проверка: /Users/rafael/Documents/Работа/Проекты/Lady Elka/.codex-work/lady-elka-release-2026-10-14/codex1-social-links/final-verification.json.
