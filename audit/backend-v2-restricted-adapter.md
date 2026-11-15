# Restricted RPC adapter — 2026-10-03

productionReady=false. Local-only implementation; no production SQL, provider requests, secrets, installs, push, deployment, Timeweb or scheduler changes. Existing dirty work preserved. Existing router.mjs/store.mjs/worker.mjs/payment-adapter.mjs and interfaces remain unchanged.

## Implementation and trust boundary

New restricted-adapter.mjs requires injected executors for distinct create/status/callback/internal identities. Before every RPC it checks both session_user and current_user equal the exact named restricted role. Missing configuration, a privileged executor, a mismatched identity or missing/denied RPC fails closed. There is no sqlStore/service_role fallback, role switching, capability provisioning, token minting or secret loading in the adapter.

New gateway.mjs exports createGateway({executors,identity,verifyCatalog,auth,provider,notifier,recipients,paymentOrigins,evidencePolicy}). Requests are {route,body,credentials,signal,deadline}. Credentials for create/status are already-provisioned opaque capabilities passed unchanged to SQL. SQL resolves immutable owner, scope and expiry; body/header/clientId do not establish ownership. Provisioning/revocation remains a separate trusted operator interface, absent from this gateway. Callback/internal credentials are validated by mandatory injected authenticators. Executors, authenticators, catalog verifier, provider and notifier are trusted server composition, never request inputs.

Create uses the existing contractValidator: shared envelope/endpoint/version validation, full canonical fingerprint and mandatory verified fresh revision/authoritative minor-unit quote. Only a successful api_create admission dispatches the returned exact order ID to the internal worker. Recipients come from trusted configuration and persisted orders. Public status invokes api_status only, preserves identical foreign/missing 404, and validates payment redirect origins before returning the existing paymentResponse envelope. Create retains the existing pure status response shape.

Callback uses callback-only lookup/recover RPCs after authentication and independent fresh paid provider evidence matching persisted payment ID, bank number and amount. Notification dispatch uses the separately bound internal executor. Callback ingress must remain behind this trusted gateway: its SQL role alone cannot authenticate a bank, and it has no internal effects privileges.

Internal adapter maps get/poll/pending/claim/finish/bind/status to api_internal and recovery to callback RPC. Durable claims prevent concurrent duplicate registration/delivery. Unknown/running effects never reopen by age. Bind remains one atomic SQL RPC, queue included. Existing SQL paid/pending_review guards preserve a durable payment mapping and terminal paid status after acknowledgement loss.

All effect-bearing requests require a finite future deadline, at most the existing timer range, and use pollPayments cancellation/deadline bounds. Provider/notifier receive signal/deadline. Late provider evidence cannot start recovery after worker cancellation. Claims returning after deadline are failed before sending. An external call already started can resolve/commit later; proven registration outcomes are persisted, not undone. SQL already in flight can commit after timeout. Status does not require an effect deadline. Internal batches remain 1..20.

Completion RPC errors propagate as failure rather than being hidden by worker per-order error handling. Evidence-provider uncertainty leaves queued orders unchanged. No activation of the old privileged router or production transport is introduced.

## Necessary SQL addition

roles-draft.sql adds only api_gate() and its explicit EXECUTE grants. Existing RPCs cannot consume global/pre-auth request and callback/internal counters without direct table/private-helper access. api_gate uses actual session_user to select fixed request plus callback/internal budgets; it accepts no caller-selected owner, budget or scope. Unknown session identities are rejected. All function ownership/search_path/PUBLIC revocations remain covered by the existing ownership block. No existing public ACL is changed.

Create/status authenticated counters and create closure remain protected in their existing SQL wrappers. Worker effect counters remain protected in api_internal. Request/owner/scope/admission/effect policies must all be provisioned with finite capacity, window_ms and owner_capacity; missing policy fails closed. Dispatches also consume internal gate counters.

## Local validation

Command: node --test local-backend-v2/tests/*.test.mjs storefront/tests/api-v2-contract-local.test.mjs
Result: 40/40 passing. Log: /tmp/le-restricted-full.log. git diff --check passes.

Five new tests cover the full gateway under SET SESSION AUTHORIZATION restricted identities:

- Eight concurrent canonical create/replay requests produce one registration; changed payload conflicts; wrong scope/expired capabilities fail; SQL create closure permits exact replay; stale catalog fails; private status excludes sensitive fields and rejects an unsafe stored redirect.
- Authenticated callback plus internal poll deduplicate paid delivery; mismatched evidence cannot pay; paid cannot downgrade; unknown bank/notification outcomes never repeat; a noncooperative evidence provider stops at the deadline.
- Every runtime session is denied SELECT/INSERT/DELETE on v2 and legacy/catalog/blog sentinel tables, direct order UPDATE, owner role escalation and cross-scope RPC execution. Wrong-role/admin/missing executors and missing RPC return failure without external effects.
- Zero request/ownerRequest/replay/create/bank/internal/telegram budgets stop external effects; exhausted status and missing callback policy fail closed.
- A successful finish whose acknowledgement is lost preserves bound awaiting_payment and polling; subsequent paid readback is terminal. Notification finish unavailability leaves a durable running claim, so restoring the adapter does not send twice.

PGlite has one physical session. The test harness serializes query execution and brackets each application query with SET SESSION AUTHORIZATION; it explicitly restores postgres only outside the injected executor. This is actual SQL ACL/SECURITY DEFINER evaluation, not a mock method allowlist. The harness's original connection is privileged so it can restore fixtures; it does not prove isolation of real transport credentials or multi-process PostgreSQL contention. Adapter application SQL itself never switches identity or accesses tables.

## Remaining activation limits

PUBLIC ambient ACLs in the actual database, existing privileged functions/memberships, real PostgreSQL multi-process behavior, login/pool/session provisioning, PostgREST schema exposure and deployment are explicitly unverified. Adapter identity checks do not replace secure connection provisioning; production must supply stable isolated identities and prevent arbitrary SQL/identity changes. Real provider authenticity, cancellation, aggregate merchant/bot quotas, capability lifecycle/storage and delivery reconciliation remain separately reviewed prerequisites. No service_role workaround is allowed. ProductionReady=false.
