# Cancellation boundary fixes — 04.10.2026

productionReady=false. Changed only http-auth.mjs, gateway.mjs and tests/http-auth.test.mjs, tests/http-integration.test.mjs, tests/runtime.test.mjs; added this audit. No transport/runtime/store/SQL changes, installs, commit/push, full suite, network/production operations.

## Change

http-auth dispatch rechecks signal and server deadline immediately after awaited session/private capability/callback/internal resolution. Cancelled or expired requests return fixed REQUEST_CANCELLED/504 and never enter gateway. No credential/error details are exposed.

Gateway checks abort/finite future deadline before api_gate, again after awaited gate before status, and after awaited contract/catalog validation immediately before entering create adapter admission. Late valid catalog quotes cannot start a new api_create adapter call after cancellation is observed. SQL quota and callback/payment evidence/recovery rules remain unchanged. Missing/expired gateway deadline now denies status as well as effect routes. Existing trusted direct callers must supply the deadline; HTTP always supplies it. Range validation is preserved.

## Targeted regressions

Command: `node --test local-backend-v2/tests/http-auth.test.mjs local-backend-v2/tests/http-integration.test.mjs local-backend-v2/tests/runtime.test.mjs`

Final result: 17 tests / 17 pass / 0 fail/cancelled/skipped. Earlier run before the additional direct-gateway regression: 16/16; final totals are 17/17. Only these affected targeted suites executed.

Auth unit regression proves deferred verification with expired deadline or abort never invokes the injected gateway. Runtime regression uses actual localhost HTTP, real auth/gateway/restrictedAdapter and disposable schema/roles PGlite fixture. Six scenarios independently defer session verifier, private store or catalog verifier, then finish only after HTTP 504 or runtime shutdown. After releasing dependencies, executor query count never grows; no api_status/api_create calls, zero orders and zero registration effects. Existing callback/internal paid dedup and SQL 429 regressions pass. Direct real gateway regression additionally rejects expired/aborted status before any restricted executor gate query.

Existing auth tests now give dispatch a live server deadline when testing successful forwarding/leak guards. Runtime fixture only adds query tracing for assertions. No fake gateway substitutes for the SQL admission scenario.

## Guarantee and limits

Guarantee covers cancellation observed at the dispatch and gateway checks before starting the next adapter operation. It blocks late authentication from starting gateway work, late gate completion from starting status, and late valid catalog completion from starting admission. Transport still determines the client-facing timeout/disconnect, and already finished responses are not written again.

No rollback/cancellation guarantee applies once an adapter operation has been entered. RestrictedAdapter performs an awaited identity query before its RPC; an operation already entered before cancellation can progress through that identity check and issue/commit its RPC later. In-flight SQL, provider effects and recovery can complete after abort, with existing durable claims/recovery semantics. Verifier/store/catalog interfaces are not forcibly terminated: a noncooperative dependency may remain pending. Shutdown cleanup ownership and bounded listener closure remain unchanged. Full suite and live provider behavior were not rerun; previous 223/223 stable snapshot predates these authorized changes.
