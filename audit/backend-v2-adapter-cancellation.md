# Restricted adapter cancellation boundary — 04.10.2026

productionReady=false. Changed only restricted-adapter.mjs, gateway.mjs, tests/restricted-adapter.test.mjs, tests/http-integration.test.mjs and this report. Store/SQL/HTTP/auth/runtime untouched. No installs, commit/push, production/network operations or full suite.

## Implementation

restrictedAdapter q accepts an optional per-call context {signal,deadline}, checks it before identity SQL and again after awaited SELECT session_user,current_user immediately before invoking the RPC executor. Abort, missing/expired contextual deadline fail with fixed REQUEST_CANCELLED/504. Wrong-role checks remain mandatory. Context is a function argument, never assigned to adapter/executor singleton state. Existing trusted calls without context retain their former behavior.

Context is exposed on gate(context), create(credentials,validated,bankNumber,recipients,context), status(credentials,orderId,context). Gateway constructs a fresh request-local context and supplies it to ingress gate for every route and to request-bound create/status. Late identity readback cannot initiate their quota/admission/status RPC after cancellation is observed.

## Accepted effects and recovery

Internal bookkeeping/lookup/claim/finish/bind/status and callback lookup/recover are unchanged and intentionally do not inherit admission context automatically. Worker gate calls after successful admission/recovery remain context-free. Already accepted work retains existing durable claim, verified evidence, outcome persistence and recovery rules; cancellation does not reset claims or erase payment mappings. Existing worker checks still bound beginning provider/notifier effects. Callback/internal request entry is context-gated, but accepted recovery/outcome persistence is not discarded solely because HTTP ends. Callback authenticity/body-bound proof and paid evidence checks remain required.

## Targeted verification

Command: `node --test local-backend-v2/tests/restricted-adapter.test.mjs local-backend-v2/tests/http-integration.test.mjs`

Final: **11 tests / 11 pass / 0 fail/cancelled/skipped**, duration ~8.44s. Only the two affected targeted suites executed. Scoped git diff --check passes.

New HTTP regression uses real auth/gateway/restrictedAdapter and disposable SQL/PGlite. Its executor wrapper delays only the return of a real identity SELECT, outside the fixture's serialized SQL queue. For both create/status, HTTP timeout and actual runtime shutdown occur while the second role identity lookup is pending (after ingress gate, immediately before admission/status RPC). Releasing the identity produces no api_create/api_status RPC, zero orders, zero bank/notification effects. Four scenarios covered.

Concurrency case holds Alice's create identity, lets a Bob request on the same singleton adapter complete normally, waits for Alice's HTTP timeout and releases her identity. Exactly one api_create and one registration remain, persisted owner Bob. Cancellation context from Alice cannot poison Bob. Additional real adapter regression aborts during gate identity lookup, proves no gate RPC dispatch, and verifies context-free trusted gate still works.

Existing restricted ACL, quota, callback/poll dedup, acknowledgement-loss/recovery and HTTP owner/privacy/429 regressions pass. First intermediate targeted run: 9/10, with existing missing-executor status fixture expecting 503 but omitting the server deadline required by the previous cancellation stage. Updated that permitted test input with a live deadline; final regression now checks the intended missing-executor failure again. No source workaround for that fixture was added.

## Limits

Cancellation is checked immediately before calling executor.query for the RPC. Once that call is entered, SQL may be queued/sent/committed despite later abort; there is no executor cancellation API or transaction rollback guarantee. An executor that internally delays actual dispatch after query invocation must implement its own cancellation policy. Identity SQL already in flight is not forcibly cancelled either. Outcome/recovery operations for accepted effects remain allowed as described above.

PGlite has one physical connection and the test harness serializes identity switching; this does not establish separate PostgreSQL login/pool isolation or real multiprocess concurrency. Providers/auth are synthetic, no live payment/signature behavior verified. Prior final 223/223 stable snapshot predates these changes and is not presented as current full acceptance.
