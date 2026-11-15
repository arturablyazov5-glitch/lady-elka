# Backend v2 — isolated real-browser recovery QA, 2026-10-03

`productionReady=false`. New files only in `local-backend-v2/browser-qa/**` and this report. Real v2 contract/router/store/draft SQL imported read-only. Existing storefront checkout, admin/blog, legacy fixtures, package/config and backend implementation untouched. No remote service, production bank/Telegram/Supabase/Timeweb/DNS/Taptop access, secrets, installs, Docker, deployment, commit or push.

## Evidence

`node local-backend-v2/browser-qa/run.mjs` passes **8 scenario groups** in installed **Chrome/154.0.8037.95**, with synthetic trusted catalog/auth/provider/notifier and real PGlite execution of the draft schema. Evidence: `local-backend-v2/browser-qa/evidence.json`; source/reproduction boundaries: its README.

- Storage write/readback failure stops before any create POST. Successful pending is actually persisted/read back in browser sessionStorage before HTTP create.
- Card and COD: router accepts create, fixture destroys the readable HTTP response, pending remains. Actual CDP `Page.reload` is proved by changed `performance.timeOrigin`; raw stored envelope remains identical. Browser replay posts exact original ID and every payload field. SQL asserts one durable order; one bank registration for card and one notification for COD. Closed create still permits exact existing replay; a fresh ID is denied. Private status rejects other owner and unauthenticated capability.
- Browser validates mock payment URL from private status. Different origin, suffix impersonation, credentials, HTTP and hash are rejected by the real allowlist adapter. Mock bank document navigation is fulfilled locally by CDP and recorded as intercepted; it never reaches a bank/server. Return page uses query oid to read private status; mock fresh verified evidence and concurrent callback + two poll passes confirm paid. Assertions show one card notification, zero remaining bank_queue rows and exactly two succeeded card effects (bank + notification); paymentURL becomes null. Browser pending is preserved.
- Unknown registration survives actual reload and replay as pending_review with exactly one registration and no new bank register. Legacy v1 raw pending and expired v2 pending survive reload; no silent migration/new create.
- Legacy public.payment_orders/public.le_orders sentinel rows remain unchanged. These are synthetic local tables, not production checks.

Network containment is installed before first browser navigation: deny proxy, DNS mapping denial with only 127.0.0.1 exemption, exact CDP origin/path/method allowlist, CSP worker/frame/connect restrictions, Network.setBypassServiceWorker. Disallowed loopback and external.invalid probes fail even when CSP is temporarily bypassed to exercise CDP independently. Existing user browser/profile is not used. Own detached process group and temp profile only; command/startup/reload/interception/cleanup waits are bounded; event failures are surfaced.

Injected post-start failure (`V2_QA_FAIL_AFTER_START=1`) exits **1** with original Injected startup failure preserved, cleanup completes, and no owned Chrome process/profile remains. Successful evidence is intentionally retained, not rewritten as failed-run evidence. Explicit SIGTERM cancellation was also exercised: exit 1, QA cancelled preserved, no owned browser/profile remains. SIGINT/SIGTERM cancel pending commands and enter cleanup; startup remains bounded. Normal run also cleans HTTP connections, browser process group, PGlite and temp directory. No shared dist writes.

Read-only regression check: `node --test local-backend-v2/tests/router.test.mjs storefront/tests/api-v2-contract-local.test.mjs` — **20/20 pass**.

## Limits and activation blockers

This UI and HTTP adapter exist only inside test scope. This **does not prove existing storefront checkout uses v2**, and no activation was performed. Return navigation is to the ephemeral loopback mirror of /spasibo with the same oid; persisted payload return URLs retain the shared contract's localhost:4176 allowed identity, without navigating to fixed port 4176. Callback/poll concurrency executes through the real router inside the fixture process, while browser subsequently reads status; it does not prove live callback transports.

Auth capability/issuance/expiry/revocation and secure production transport, verified real provider evidence/authenticity, provider limits and shared distributed quotas, restricted database roles/grants/schema exposure/PostgREST, fresh authoritative catalog and cross-version ownership registry remain unimplemented/unverified. PGlite is not proof of real PostgreSQL/Edge/multi-process crash recovery. Synthetic verified evidence is fixture-owned and cannot be supplied through browser HTTP. No production readiness claim is made.

Rollback/activation boundaries from backend-v2-recovery remain: close new create while servicing accepted own replay/status/callback/poll, preserve unknown/running and mappings; do not reset effects, regenerate IDs, import legacy pending or redirect to legacy.
