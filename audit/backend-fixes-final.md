# Backend fixes combined targeted acceptance — 2026-10-04

Result: **41 tests / 41 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**, exit code **0**. One requested combined command ran, duration ~12.59 seconds, 12:53:52–12:54:04 Europe/Moscow. Existing backend source/tests were read-only. New artifacts are confined to integration-qa/backend-fixes-final/ and this audit. No source corrections, broad offline suite, storefront browsers, dependency installs, commit/push, external network/production requests or secret reads. Tests use actual loopback HTTP as requested.

## Reproducible evidence

Command:

```sh
node --test local-backend-v2/tests/http-server.test.mjs local-backend-v2/tests/http-auth.test.mjs local-backend-v2/tests/http-integration.test.mjs local-backend-v2/tests/restricted-adapter.test.mjs local-backend-v2/tests/runtime.test.mjs local-backend-v2/tests/capability-store.test.mjs local-backend-v2/tests/capability-http-integration.test.mjs
```

Artifacts:

- integration-qa/backend-fixes-final/node-test.log — complete merged stdout/stderr from the single command.
- integration-qa/backend-fixes-final/result.json — exact command, UTC timestamps, exit code, counts and snapshot comparison.
- integration-qa/backend-fixes-final/sha256-before.json and sha256-after.json — per-file SHA256 for all 27 current local-backend-v2 .mjs/.sql sources/tests, including the three SQL drafts. Hash values and path inventory match exactly; changedFiles is empty.
- integration-qa/backend-fixes-final/acceptance.py — capture/snapshot runner used for this acceptance. It invokes only the specified node command once.

Historical acceptance 223/223 plus assembler 2/2 describes the older pre-fix snapshot. It was not repeated and is not presented as current full acceptance. The three input audits were read: backend-v2-revocation-fence.md, backend-v2-cancellation-fix.md and backend-v2-adapter-cancellation.md. The second-stage adapter audit supersedes the first cancellation audit's earlier gap at identity-to-RPC.

## Independent code reasoning and passing regressions

Per-call context is local: gateway.mjs:46 constructs a fresh {signal,deadline} inside each request invocation; lines 51,54,73 pass it to gate/status/create. restricted-adapter.mjs:6-12 receives context as a function argument and checks before identity SELECT and again after its awaited return immediately before executor.query(RPC). Neither singleton adapter nor executor stores a current request context. Its gate/create/status signatures forward that per-call value (lines 16-18). Concurrent regression in tests/http-integration.test.mjs:104-123 holds Alice's identity read while Bob on the same adapter completes; only Bob's order/registration remains. Cancellation of Alice does not poison Bob.

Delayed authentication is checked before gateway dispatch (http-auth.mjs:58-61). Gateway checks cancellation before gate, after gate, and after catalog validation before create admission (gateway.mjs:50-54,70-73). Adapter checks close the awaited identity-to-RPC boundary for both create/status and ingress gate (restricted-adapter.mjs:7-12). Passing HTTP/runtime regressions cover timeout and shutdown while verifier/store/catalog/real identity query completion is deferred; release creates no late api_create/api_status RPC or bank/order effect for cancelled admission. Context-free internal persistence/recovery operations are preserved; cancellation does not erase accepted effects.

Reissue guard is independently SQL-enforced after immutable owner verification and mapping row lock, before token mutation (capability-store-draft.sql:34-40). A revoked mapping raises SESSION_REVOKED. JavaScript exposes only the fixed issue error for exact P0001/SESSION_REVOKED (capability-store.mjs:13-21), and leaves other SQL details suppressed. Store tests verify direct SQL and JS refusal, retained tombstone/null token, concurrent issue/revoke fail-closed final state, and active rotation. No force-reissue path exists in the public provisioner methods.

New authenticated same-owner session identity is separate from revoked identity. Passing tests/capability-http-integration.test.mjs:112-127 reject same-session reissue, retain orders/effects/bank_queue, issue to a distinct new sessionId explicitly, read the previous order and exact-replay with one bank registration total; old session remains HTTP 401. Responses exclude private tokens. Existing HTTP scope/owner isolation, foreign/missing 404, rotation/expiry, callback/internal separation, paid delivery dedup, quotas, ACL and acknowledgement-loss regressions also passed in the requested seven files.

No failing assertion or new defect was found within this acceptance scope. No source edits were made to improve a result.

## Practical limits

These are local synthetic-auth/provider tests with real loopback HTTP and actual disposable PGlite SQL role/ACL/function evaluation. PGlite uses one physical session; identity switching is serialized in fixture code. This does not prove real PostgreSQL multiprocess contention, restricted login/pool provisioning or ambient production ACLs, disk/process restart durability, real bank registration/signatures/payment evidence, real browser-session verification, TLS/production ingress or actual notifier delivery. productionReady=false remains appropriate.

Cancellation guarantee ends at invocation of executor.query for the RPC (restricted-adapter.mjs:12): a later abort cannot unsend/rollback an entered SQL operation, and an executor internally delaying dispatch needs its own policy. Verifier/store dependencies and identity SQL are not forcibly terminated. Accepted external effects may complete and persist after client timeout/shutdown under existing claims/recovery rules.

Revocation fence assumes retained tombstones and the same HMAC key/session identity. Administrative deletion/writes or naive key replacement bypass that logical boundary. Key-version migration, operator operation journal/lost-ack recovery, authoritative session-policy coordination and cleanup retention remain documented blockers, not newly validated implementations. This acceptance does not establish that internal schedulers or production activation exist.
