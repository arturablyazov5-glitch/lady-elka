# Capability operator lifecycle review — 2026-10-03

productionReady=false. Read-only source review; only this new audit was written. No tests, suite, production operations, secret reads, source edits, installs, commits or push. Existing PGlite results cited in earlier audits are historical local evidence; no real database/pool, disk restart or multi-process behavior was verified here. Paths below are relative to repository root and line numbers refer to the reviewed source snapshot.

## Authority and expiry

There are two independent authorities: verifySession controls browser-session identity/liveness; SQL capabilities control server-private create/status permission. http-auth.mjs:24-29 requires both records to be live with the requested scope. capability-store.mjs:26-32 and capability-store-draft.sql:18-22 resolve a matching live SQL capability. roles-draft.sql:23-26 rechecks SQL expiry/scope on gateway admission. Expiry is absolute Unix ms; equality is expired. Session expiry alone does not delete or expire the SQL capability, and changing a verifier record after it was returned is not a transactional revocation guarantee.

Current trusted provisioning calls are:

```js
await provisioner.issue({sessionId, owner, expiresMs, scopes});
await provisioner.revoke({sessionId, owner});
await capabilityStore.resolve({sessionId, owner, scope}); // private readback only
```

Use authenticated server sessionId and stable owner, never request-body identifiers. Use distinct role-bound resolver/provisioner executors and the same HMAC key. Never serialize/log resolve's token, key or raw browser bearer credential. The issuer receives metadata only. Runtime accepts a resolve-only store (runtime.mjs:17,23), and does not implement operator lifecycle policy.

For expiry: establish expiry in the authoritative session system; issue capability with expiresMs no later than min(session expiry, operator capability TTL) and only scopes authorized by that session. HTTP automatically denies once either authority expires. Leave orders/payment state intact. If session expiry is shortened or session scopes reduced, synchronize the SQL authority by trusted revoke or replacement issue while issuance is fenced; otherwise the old SQL capability remains independently usable until its own expiry. There is no automatic expiry cleanup or renewal in current runtime/store.

## Session revocation protocol

1. Durably mark the browser session revoked in the authoritative verifier system; stop accepting it on every verifier instance. Fence issue/renewal for this session and settle/cancel outstanding issuance operations. This coordination is an operator requirement, not implemented by the current module.
2. Call trusted provisioner.revoke with the original sessionId/owner and the key under which its mapping was issued. cap_revoke locks the mapping, clears token, writes a tombstone and deletes old SQL capability in one transaction (capability-store-draft.sql:49-54). Repeated revoke is idempotent absent competing issuance; unknown sessions receive an owner-bound tombstone.
3. Obtain a definitive committed acknowledgement or recover the operation's uncertain outcome as below. Keep the verifier session closed even if store/backend is unavailable. A null resolver read establishes only absence of live authority at that read, not a completed revoke transaction.
4. Do not automatically reissue the revoked browser session. Restoring user access requires explicit authenticated re-entry yielding a new server session identity, with the same stable owner only when authoritative identity verification establishes it. The new session may receive a fresh capability under operator policy. Retain the old tombstone.

A late issue can clear the tombstone (capability-store-draft.sql:40); row locks establish mutation order, not irrevocable session closure. A request that already passed cap_owner can continue SQL admission or external effects after revoke. Revoke is permission removal, not order cancellation or bank refund.

## Renewal and capability rotation

Renew only a freshly authenticated, currently live, nonrevoked session after checking authoritative owner, expiry, scope and renewal policy. Under a per-session issuance fence, call issue with desired scopes and bounded new expiry. issue replaces all scopes for that mapping (not an incremental grant), generates a new random token, atomically removes old SQL authority and binds the new one (capability-store.mjs:39-44; capability-store-draft.sql:33-40). Read back only through the private resolver and verify desired metadata; never return its token to the browser. Changing scope must not silently widen privileges.

Current issue does not independently know verifier revocation or session expiry. Therefore an HTTP 401, missing mapping, cleanup, changed HMAC key or failed readback is never a sufficient renewal trigger. No public mint route or automatic reissue is proposed. Already resolving requests can fail if their old token is rotated before SQL admission; a client with a live authorized session may retry status or the exact same canonical order after reauthentication/re-resolution. Keep the original orderId and fingerprint; do not create a new order merely because auth/transport failed.

## Cleanup of expired mappings

No existing runtime/provisioner interface enumerates expired mappings or prunes rows. Runtime cleanup (runtime.mjs:55) is a shutdown resource hook, not a session garbage collector. SQL mapping has no session expiry/revocation timestamps (capability-store-draft.sql:4-8). Current safe default is to retain rows, including tombstones; expiration already denies permission.

A future dedicated bounded maintenance RPC should use an independently restricted maintenance role and server DB time. Select a bounded candidate batch, lock mapping rows in stable order, and re-read referenced capability expiry under those locks before any mutation. For a still-expired token: clear mapping.token first (FK at capability-store-draft.sql:7), delete that exact capability second, retain owner-bound mapping/tombstone; perform all steps in one transaction. Do not delete a token renewed while the batch waited. For zero-token tombstones, do not infer age from NULL token. Physical mapping deletion requires authoritative evidence that the session is permanently retired, all outstanding issue operations are fenced, and session IDs cannot be reused; otherwise preserve owner binding. Add lifecycle timestamps/generation before any retention policy.

Never remove orders, bank_queue, effects or their idempotency evidence for session cleanup. Never bulk-delete capabilities before clearing mapping references. Legacy unbound SQL capabilities require a separate explicit policy; a mapping cleanup must not treat every unreferenced token as disposable by default. No maintenance RPC/scheduler or cleanup SQL was executed in this review.

## Rotation of sessionHashKey

Current implementation uses a copied single key and one unversioned HMAC session_hash (capability-store.mjs:5-10; capability-store-draft.sql:5). Replacing the key makes old mappings unreachable; it does not revoke their SQL tokens. The hash cannot be reversed to recover sessionId, and issuing under the new key can create another independent mapping/token for the same browser session. Revoking only under the new key will not revoke old-key authority. Current code has no seamless migration protocol.

Conservative current-contract plan for a deliberate disruptive rotation: fence all issuance/renewal, close old browser sessions in session authority, reconcile outstanding operator transactions, and retain the old key under controlled custody while revoking every known old session. If only hashes remain, use a separately reviewed privileged maintenance path to lock old mapping rows and clear/delete their tokens transactionally; provisioner.revoke cannot enumerate hashes from its JavaScript API. Verify old authority is removed before discarding the old key. Recreate resolver/provisioner/runtime with the new key and admit only newly authenticated server sessions under explicit trusted issuance. Do not resume old browser sessions via automatic issue. Existing order/payment data remains untouched. This is a proposed operator protocol with currently missing enumeration/maintenance support, not an executable validated procedure.

For future gradual rotation, add key version to mapping identity plus operator migration/revocation across all versions. The session authority must supply the stable authenticated ID for computing both old/new digests; atomically transfer or revoke the old binding, enforce one logical session generation, and prevent old workers from issuing into retired versions. Merely trying multiple keys in resolve does not coordinate provisioning or revoke all versions.

## Lost acknowledgement recovery

A fixed CAPABILITY_UNAVAILABLE exception (capability-store.mjs:13-18) does not distinguish rollback, uncommitted query, successful commit with lost response or identity/config failure. Timeout/disconnect is not proof of rollback. Recover only on trusted server channels; do not log tokens.

For issue: fence further issue/renewal for the session, determine whether the original database operation has settled using a future operation journal or trusted executor diagnostics, and read the mapping privately. A live record matching owner/desired expiry/scopes establishes current acceptable authority, but cannot prove that specific issue committed if another operation produced identical metadata. A null result may mean expiration, revocation, failure, changed key or a still-pending transaction; it must not trigger automatic issuance. With the current API, after original operation is definitively settled and the session remains freshly authenticated/live, an explicitly approved trusted issue can replace authority with another random token. That is a new rotation, not an idempotent retry. If session is revoked, keep it closed and recover revoke instead.

For revoke: keep session verifier closed and issuance fenced. After settling any prior issue, repeat trusted revoke and wait for definitive acknowledgement; it is idempotent for that mapping. If acknowledgement is lost again, null resolve alone still cannot distinguish expired live mapping from revoked tombstone, nor prevent a delayed issue. Reconcile through a future privileged metadata-only operation status/tombstone read. Do not use issue to probe or recover revoke.

Minimal robust future protocol: operationId + per-session generation/fence + durable operation result journal written in the same SQL mutation transaction; replay returns the original result, and revoke advances a generation that stale issues cannot reopen. Expose metadata-only operator status, never capability values. This is not implemented or tested here.

## Accepted orders and unfinished payments

orders stores stable owner/fingerprint/payment data, with no capability/session FK (schema-draft.sql:3-15). cap_revoke modifies only mapping/capabilities. A newly authenticated distinct session for the same verified owner can obtain status permission and read existing orders (roles-draft.sql:57-61); another owner gets no access. Same-owner exact create replay returns the stored order, changed fingerprint conflicts (schema-draft.sql:60-64). Bank/notification claims reject running/unknown/succeeded effects (schema-draft.sql:77-83); keep those rows to preserve duplicate protection.

Authenticated bank callback and internal polling/retry use their own verifiers and restricted roles, not the browser session (http-auth.mjs:32-52; gateway.mjs:72-92). Bound awaiting_payment orders remain in bank_queue and can recover with fresh matching provider evidence through those paths (roles-draft.sql:80-82; schema-draft.sql:86-92). Revoking browser access neither invalidates a bank payment URL already received nor cancels bank-side payment. Accepted/paid notification retries operate from persisted orders under internal auth (roles-draft.sql:83-90). None of these capabilities imply that a scheduler or real provider is configured/running.

Unbound received card orders are a separate recovery limitation: internal poll selects only bound awaiting_payment, and internal retry selects accepted/paid. If creation is interrupted after reservation but before registration, session cleanup must retain the order/effects. A later explicitly authenticated same-owner exact create replay can reach its registration path; otherwise a separately reviewed operator reconciliation path is needed. Unknown/running registration effects must never be reset merely due to session age or shutdown. Runtime shutdown aborts signals but cannot roll back started SQL/provider work (runtime.mjs:49-56; gateway.mjs:29-37).

## Uncovered operational work

| Source | Consequence | Minimal subsequent change |
|---|---|---|
| capability-store.mjs:39-43; http-auth.mjs:24-29 | Issuance trusts caller expiry/scopes and has no atomic link to session authority; verifier-only expiry/revoke leaves SQL authority alive. | Trusted session-policy operator service bounding TTL/scopes; durable revoke coordination with issuance fence. |
| capability-store-draft.sql:33-40,49-54 | Late issue reopens revoked mapping; row serialization alone does not make revoke terminal. | Session generation/fence checked by issue, advanced by revoke; new authenticated session for restored access. |
| capability-store.mjs:13-18,42-49 | Lost reply cannot identify a committed operation; issue retry rotates again. | Durable operation IDs/results + metadata-only recovery/status RPC. |
| capability-store-draft.sql:4-8,59-63 | No timestamps, expired-row enumeration or maintenance grant; tombstone deletion loses owner binding. | Bounded least-privilege cleanup RPC, lifecycle metadata, explicit retention/no-reuse policy. |
| capability-store.mjs:5-10; capability-store-draft.sql:5 | Single unversioned key prevents seamless migration and leaves old authority after naive key replacement. | Key-version mapping + atomic cross-version migration/revoke + retired-version issuance fencing. |
| roles-draft.sql:23-26; http-auth.mjs:24-29 | Revocation races with already verified/admitted requests; no strict global cutoff. | Document admission cutoff; if required, transactional generation checks at admission with coordinated locks, without claiming external-effect rollback. |
| roles-draft.sql:80-84; gateway.mjs:66-69 | Unbound received card orders are outside internal poll/retry selection after interrupted create. | Restricted operator registration reconciliation using persisted order/effect identity and provider outcome evidence. |
| runtime.mjs:13-23,55 | Runtime validates interfaces only; no authoritative session system, operator worker or owned cleanup protocol. | Explicit dependency composition, resource ownership and bounded maintenance service; do not place destructive session GC in shutdown cleanup. |
| capability-store.mjs:15-17; capability-store-draft.sql:2-3 | Checks do not provision isolated real login/pools or prove ambient ACL safety. | Separate restricted connection provisioning and real DB/pool/ACL acceptance; still unverified. |

No implementation changes are included. Findings describe current source contracts and proposed follow-up scope; they are not claims of production readiness.
