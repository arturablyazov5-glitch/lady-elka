# Persistent capability store through HTTP — 2026-10-03

productionReady=false. Created only tests/capability-http-integration.test.mjs and this audit. No existing modules, SQL drafts, HTTP tests, runtime.mjs or unrelated changes were edited. No installs, commits, push, environment/secrets reads, production access or real provider requests.

## Actual local path

The fixture applies schema-draft.sql, roles-draft.sql and capability-store-draft.sql to its own disposable PGlite database. Separate injected executors run under le_v2_create/status/callback/internal and le_v2_cap_resolver/provisioner. Every query is identity-bound; single-session PGlite identity switching is serialized in privileged fixture code, outside application SQL.

Trusted createCapabilityProvisioner issues random capabilities into real SQL. createCapabilityStore.resolve queries the private SQL mapping; there is no capability Map/fake store. createHttpAuth verifies a synthetic HTTP bearer session, resolves its real private capability, and dispatches through createGateway plus restricted SQL RPCs. createServer listens on ephemeral 127.0.0.1; tests make actual fetch POST requests. Catalog quoting and bank registration are injected synthetic adapters, and registration calls are counted. No external endpoint is contacted.

Each HTTP response body and all response headers are checked for every capability token issued in the test, including old tokens after rotation. Request-body owner/sessionId/credentials do not select authority. HTTP session verification remains a synthetic Map fixture; this test does not prove real bearer/session authentication.

## Targeted validation

Command: `node --test local-backend-v2/tests/capability-http-integration.test.mjs`

Result: 3/3 passing.

1. Before trusted issuance, HTTP create denies. After issuance, HTTP create/status succeed. Stop and reconstruct JS store/auth/gateway/server over the same database; the token and existing order/status survive, and exact replay performs no additional registration. Revoke using trusted provisioner while the synthetic verifier's session remains live. HTTP create/status both return 401, old token independently fails SQL cap_owner, its SQL capability row is gone, and refusal survives another server reconstruction.
2. Create-only and status-only capabilities enforce separate HTTP scopes. Bob cannot read Alice's existing order even with Alice's owner/session/token inserted into request body; existing foreign order and missing order share 404/NOT_FOUND. A verified synthetic session with Alice's sessionId but Bob's owner denies at store resolution. Independent Alice/Bob creation persists correct owners, and Alice cannot read Bob's order.
3. Rotate the capability after successful creation. Old capability fails independent SQL create authority. Four concurrent actual HTTP exact replay requests succeed with one order and one bank registration total; status remains unchanged. Privileged fixture expiry of the new SQL capability then causes HTTP 401 and independent SQL status refusal without another registration.

## Scope of evidence

This is actual local HTTP/auth/persistent-store/gateway/SQL integration evidence. Persistence means database-backed lookup after reconstructing JavaScript objects and HTTP server over the same live PGlite database. PGlite has one physical session; the fixture deliberately serializes identity switches. This does not establish disk persistence, process/database restart recovery, PostgreSQL multi-process concurrency, production pool isolation, real provider behavior or real session verification. Existing productionReady=false remains appropriate. No module defects were found; no corrective edits or broad test-suite reruns were needed.
