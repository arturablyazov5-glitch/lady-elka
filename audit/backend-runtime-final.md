# Финальный локальный acceptance runtime — 03.10.2026

productionReady=false. Работа ограничена integration-qa/backend-runtime-final/** и этим отчётом. Все исходники read-only: ни transport/auth/gateway/runtime/store, ни SQL/runner/release assembler не менялись. Production/remote, секреты, реальные провайдеры, установки, commit/push/deploy не использовались. Browser release проверки отдельно не повторялись.

## Текущий результат

После явного подтверждения завершения capability HTTP integration выполнен ровно один запуск:

`node scripts/offline-suite-isolated.mjs --with-v2-browser`

PASS, exit 0: **223 tests / 223 pass / 0 fail / 0 cancelled / 0 skipped**, Node tests duration 92954ms. Это текущие totals, прежние 192/192 из audit/final-local-readiness.md не относятся к этому запуску. Лог: integration-qa/backend-runtime-final/offline-suite.log.

После Node tests успешно завершились встроенные runner stages: V2 browser **10 cases**, synthetic registrations=2/sends=2; checkout offline browser; ordinary preview build; search/routes browser с externalRequests=[], writes=0, headProbes=0. Ordinary preview остаётся 2026-10-01-derived-build, current prices UNVERIFIED, productionReady=false. Exit 0 относится ко всему runner, не только Node tests. Mock provider error messages в логе — ожидаемые тестовые сценарии; failed tests=0.

Discovery существующего runner включает все непосредственные *.test.mjs в local-backend-v2/tests, включая runtime, capability-store, capability-http-integration, http-auth/http-server/http-integration и restricted-adapter. На момент запуска 49 test files в пяти каталогах discovery; финальный список сохранён в discovery-final.json. Runner копирует соответствующие исходники в isolated TEMP и запрещает external fetch в тестовой стадии. Общий runner не менялся.

integration-qa/admin-release/assembler.test.mjs не входит в discovery/isolated copy, поэтому отдельно выполнена только отсутствующая targeted команда:

`node --test integration-qa/admin-release/assembler.test.mjs`

PASS, exit 0: **2 tests / 2 pass / 0 fail / 0 skipped**. Лог: integration-qa/backend-runtime-final/assembler.log. Проверены exact release file set/deterministic manifests/canonical modules/boundaries и соответствие release текущему app/public. Общие Node tests + этот отдельный targeted test = **225/225**, без добавления browser cases к числу Node tests.

## Snapshot

source-preparation.json/discovery-preparation.json отражают подготовку до сохранения capability HTTP test. Перед разрешённым запуском сохранены source-before.json и discovery-final.json; после завершения suite и assembler — source-after.json/source-delta.json.

Финальный snapshot содержит **32 files**: все существующие файлы local-backend-v2/**, scripts/build-admin-release.mjs и integration-qa/admin-release/*.mjs. Before/after SHA-256 идентичны; source-delta.json = {}. capability-http-integration.test.mjs входит в финальный before snapshot. Это доказательство стабильности именно перечисленных файлов, не всей dirty рабочей копии. Исходный preparation snapshot отдельно сохранён, его отсутствие нового теста не является drift финального интервала. result.json содержит actual exit codes/totals/sourceStable=true.

## Что локально подтверждено и что остаётся blocked

Новые runtime/store/auth/HTTP checks включены в текущий общий прогон: настоящие localhost HTTP requests с реальными gateway/restricted RPC и disposable PGlite, приватное разрешение capabilities, scope/owner/expiry/revocation/replay, fail-closed config/default create и bounded shutdown. Синтетические verifiers/providers/notifier и serialized SET SESSION AUTHORIZATION в одном PGlite connection не доказывают настоящие session credentials, отдельные PostgreSQL login/pools, multiprocess concurrency, provider authenticity или cancellation/reconciliation живой оплаты.

Live blog authenticated CRUD остаётся **blocked session**; source pay имеет **403**; publication не выполнена; catalog не принят владельцем. Это текущие blockers, сообщённые координатором и унаследованные из общего readiness context, а не live-проверки этого offline запуска. Локальный suite не устраняет их и не доказывает live blog/реальную оплату.

Дополнительный release blocker: current app/public содержит смешанные blog/payment изменения и не безопасен для публикации «только блог». Успех assembler доказывает воспроизводимое копирование current source set, но не согласованность scope публикации. Для «только блог» потребуется отдельно согласованный release source snapshot/artifact. Никакая публикация этим этапом не выполнялась.

До activation нужны real deployment dependencies из audit/backend-v2-runtime.md и capability-store audit: secure role-bound PostgreSQL/session provisioning, durable trusted capability lifecycle, реальные session/callback/internal verifiers, fresh accepted catalog, finite quotas, реальные providers/notifier, TLS/proxy/owned origins, cleanup/recovery и отдельная авторизация production rollout. create остаётся закрытым по умолчанию; local opt-in и локальные tests не равны production readiness.

## Evidence

integration-qa/backend-runtime-final/: offline-suite.log, assembler.log, result.json, source-preparation.json, source-before.json, source-after.json, source-delta.json, discovery-preparation.json, discovery-final.json. Предыдущие browser release результаты не переименованы и не присвоены этому этапу. Ошибок/drift в текущем запуске не было; чужие файлы не исправлялись.
