# Isolated v2 browser QA

Run from repository root: `node local-backend-v2/browser-qa/run.mjs`.

Uses already installed Node WebSocket, esbuild, PGlite and Chrome. No installs or shared dist writes. It imports the read-only real v2 contract, router, SQL store and draft schema. The UI, transport, owner capabilities, catalog, bank and notifier are synthetic test adapters; this does not integrate the storefront checkout.

Chrome owns a temporary profile/process group. Deny proxy + DNS are configured at process launch; CDP allowlist + service worker bypass are enabled before first navigation; local responses have restrictive CSP. Mock HTTPS bank navigation is fulfilled inside CDP without a remote request. Only allowlisted loopback routes reach HTTP. Browser request evidence is in evidence.json, which is written only on a successful scenario run. Fixture POST accepts only create/status, maximum 32768 bytes, and test capability in header. Callback/poll are invoked internally through the router, never exposed as browser-authorized HTTP routes.

Commands, startup, scenario polling and process cleanup are bounded. Fetch interception rejections are recorded and fail the suite. The suite signals only its detached Chrome process group, closes HTTP connections/PGlite and removes its temporary profile. `V2_QA_FAIL_AFTER_START=1 node local-backend-v2/browser-qa/run.mjs` deliberately exits nonzero after Chrome setup, while still completing cleanup. Prior successful evidence.json is retained on intentional failure; it is not a report of that failed run.

Pending storage helpers are test-only: verified sessionStorage write/readback precedes create; reload restores exact envelope; unresolved/legacy/expired pending is retained. Synthetic confirmation does not clear pending or claim a deployed integration. Payment URL validation imports the real response adapter. Return test loads a loopback mirror of `/spasibo?oid=...` at the ephemeral fixture port; persisted payload URLs keep the shared contract's permitted localhost:4176 identity, and no request is made to that fixed port.

Unified source discovery and sequential TEMP-only verification:
`node scripts/offline-suite-isolated.mjs --with-v2-browser`.
Without the flag, v2 Node tests still run; its extra Chrome fixture is opt-in.
The fixture uses finite request/owner/status/replay/callback/internal budgets with explicit window_ms/owner_capacity. Its SQL clock is synthetic and changes only in fixture SQL. Ten scenarios retain the original eight and add status/replay 429 with Retry-After and unchanged pending/ID, then rollover recovery with durable paid-effect deduplication. HTTP forwards router response headers unchanged. This does not set production policy values.
