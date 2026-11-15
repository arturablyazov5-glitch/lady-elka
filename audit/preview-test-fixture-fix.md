# Preview server test fixture fix — 2026-10-03

Исправлен только `storefront/tests/candidate-preview-server.test.mjs`; этот документ — второй разрешённый файл.

Причина: тест собирал candidate, но обычный server без `--root` требовал отсутствующий `storefront/dist` в isolated suite (integration-qa/final-local/offline-suite.log:475–494).

Теперь тест создаёт независимую копию исходников через `isolatedWorkspace`, исключающую готовые dist. Cleanup зарегистрирован до первой сборки; ошибки сборок также явно очищают TEMP и сохраняют исходную ошибку. В копии последовательно собираются default preview и candidate preview. Candidate output находится в отдельном TEMP, поскольку build запрещает explicit output внутри repo. Пути канонизированы через realpath для macOS /tmp → /private/tmp. Оба сервера используют скопированный server: default без --root, candidate с --root. Shared dist основного проекта не изменяется. Fetch в build/server запрещён.

Build timeout 120 s; startup 10 s; shutdown 5 s с SIGKILL при превышении. Child error/exit и build errors не подавляются. Если candidate startup не удался, default также останавливается. Сохранены все прежние assertions: distinct feeds/prices, pinned media, CSP, HEAD, disabled payment, redirects, traversal, missing/tampered feed, invalid manifest и symlink escape.

Проверка окончательного файла: отдельный `node --test storefront/tests/candidate-preview-server.test.mjs` в чистой внешней TEMP-копии `/tmp/le-offline-suite-w2psqX` (отсутствие dist проверено до запуска), с offline-suite-equivalent localhost-only fetch guard: **2/2 pass, exit 0**, 10.224 s. TEMP удалена. Лог: `/tmp/le-preview-test-fixture-fix.log`.

Полный isolated suite самостоятельно не запущен: координатор подтвердил, что повтор выполнит final QA чат `01a10310-4889-7393-9ff6-c793392d1eef` после этого отчёта. Результат полного повтора здесь пока не заявляется.

Без Supabase, внешних запросов, платежей, push или deploy; server/build/scripts/другие tests не редактировались.
