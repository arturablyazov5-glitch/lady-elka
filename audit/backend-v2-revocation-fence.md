# Revocation fence — 2026-10-04

productionReady=false. Scope: capability-store.mjs, capability-store-draft.sql, tests/capability-store.test.mjs, tests/capability-http-integration.test.mjs and this new audit only. Existing auth/gateway/runtime/HTTP and other SQL/audits are unchanged. No broad suite, installation, commits, push or production operations. Earlier acceptance (223/223 plus assembler 2/2) describes the snapshot BEFORE this correction; it has not been rewritten or claimed for this corrected snapshot.

## Corrected contract

capability-store-draft.sql cap_issue now checks saved.revoked immediately after locking the session mapping and verifying its immutable owner, before removing or inserting tokens. A revoked mapping raises SESSION_REVOKED. SQL independently enforces this even when the trusted provisioning role calls the RPC directly. No force-reissue parameter or alternative bypass was added.

capability-store.mjs maps only the exact SQL P0001/SESSION_REVOKED exception from issue to a fresh Error('SESSION_REVOKED'). Backend details and token values remain suppressed; other SQL/configuration failures retain CAPABILITY_UNAVAILABLE. Resolver/provisioner APIs and privileges are unchanged.

Renewal/rotation of an active nonrevoked mapping still works under trusted policy. Revocation is terminal for that session hash: later issue cannot remove its tombstone. Access restoration requires a distinct newly authenticated sessionId and explicit trusted issuance. Same stable owner can read existing orders and perform canonical exact replay under the new session; another owner receives no additional rights. Do not delete tombstones as routine cleanup or reuse session IDs.

## Race behavior

cap_issue and cap_revoke serialize on the same mapping row. If issue wins the lock first, revoke subsequently clears its capability; if revoke wins first, issue observes revoked and refuses. Once a successful revoke commits, later issuance for that identity cannot reopen it through these RPCs. Requests already admitted can still finish; this fence does not cancel transactions/payment effects or synchronize verifier snapshots with SQL admission.

This applies to mappings derived with the same sessionHashKey. A key change produces a different hash and is not cross-version revocation. Key rotation/migration and lost-operation acknowledgement journals remain separate blockers, not implementation scope here. Administrative table writes or tombstone deletion can bypass the invariant and must not be used as lifecycle operations.

## Targeted evidence

Command executed after resuming and verifying the saved edits:

`node --test local-backend-v2/tests/capability-store.test.mjs local-backend-v2/tests/capability-http-integration.test.mjs`

Result: 10 tests passed, 0 failed: store 7/7 and HTTP integration 3/3. Only these two test files ran; no broad suite.

Store tests now require JS and direct SQL refusal for revoke->issue, retained revoked/null-token mapping, zero old capability authority, fail-closed concurrent issue/revoke and reversed arrival, and successful explicit issuance for a different sessionId of the same owner. Existing active rotation, owner/scope, expiry, transactional rollback and least-privilege tests remain passing.

HTTP tests preserve the existing admitted order, bank queue and succeeded bank effect after revoke and rejected reissue. A distinct synthetic newly authenticated session with the same owner receives trusted issuance, reads the existing order, and exact-replays it without additional registration (bank count remains one); old session remains HTTP 401. Response bodies/headers continue to exclude issued tokens.

PGlite has one physical session; fixture identity switches are serialized. These results prove local SQL ACL/transaction behavior and actual loopback HTTP integration, not real PostgreSQL multi-process contention, production pool isolation, disk/process restart or real session/provider correctness. Earlier audits that describe deliberate same-session reissue reflect the old contract and are superseded by this document for that behavior; they were preserved under the approved editing scope.
