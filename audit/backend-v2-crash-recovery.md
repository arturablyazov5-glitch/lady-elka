# Local backend v2 crash recovery — 2026-10-03

productionReady=false. No deployment, push, installation, production access, bank/Telegram transport or shared dist/data changes. Existing dirty work preserved. Changes: local-backend-v2/store.mjs, payment-adapter.mjs, tests/crash-recovery.test.mjs and this report. Router interface, worker, schema, contracts and browser runner unchanged.

## Reproduced defects and fixes

1. Registration returns confirmed, bind commits payment mapping and queue, then finish(succeeded) fails. The catch previously finished unknown and unconditionally changed status to pending_review. That removed the durable mapping from pollable(), whose predicate requires awaiting_payment. If callback had already proved paid while finish failed, the same catch also downgraded paid. Fault injection reproduced awaiting_payment → pending_review before the fix. The regression covers both bound awaiting_payment and concurrently recovered paid. sqlStore.status now preserves paid and allows pending_review only for unbound orders. Durable mapped orders remain pollable; effect stays unknown and registration never repeats.
2. paidEvidence accepted null paymentId when the supplied order also had null payment_id. The pure predicate regression failed before the fix and now requires a nonempty persisted string ID. This is defensive validation: existing callback lookup and poll queue exclude unbound orders, so the audit does not claim a demonstrated public-route false-paid exploit.

## Fault injection on PGlite

Eight new tests, using fresh in-memory SQL schema and reconstructed routers:
- Bind commits, finish acknowledgement fails; mapped pending and paid status preserved; no second registration.
- Queue insert trigger throws after order update in bind transaction: payment mapping rolls back, order enters pending_review, unknown registration never repeats after trigger removal/restart.
- Notification confirmed but all finish writes fail: durable running blocks subsequent create/internal retry.
- Reserve commits then acknowledgement throws; claim commits then acknowledgement throws: one durable order and running claim, no external call on restart. The claim-before-call gap deliberately fails closed.
- Worker returns at deadline while evidence adapter ignores cancellation and resolves later: no paid transition or notification.
- Incomplete unbound evidence rejected.
- Callback proves paid while poll holds a stale/incomplete reply; notifier throws after simulated send: paid persists, unknown delivery never repeats.
- Effect claim resolves after worker deadline: no send, pre-send claim safely becomes failed, later retry sends once.

Existing tests additionally cover concurrent callback/poll, missing/stale/conflicting evidence, unknown registration, running claims, admission rollback and closed-create recovery. Tests inject external-success/response-loss semantics with synthetic adapters; they do not contact actual providers.

## Validation

Before fixes: regression suite reproduced two assertion failures (bound order downgraded; null-ID evidence accepted).
After final changes: `node --test local-backend-v2/tests/*.test.mjs storefront/tests/api-v2-contract-local.test.mjs` — 31/31 pass: 14 existing router, 8 existing contract, 1 existing isolation and 8 new crash tests. Log: /tmp/le-crash-recovery-tests.log.
Unmodified browser-qa/run.mjs executed in a temporary copied backend/API workspace with installed node_modules read-only symlink: 10/10 scenarios, 2 synthetic registrations, 2 notifications, Chrome/154.0.8037.95. Owned Chrome, HTTP fixture, PGlite and temporary directories cleaned; shared browser evidence.json not written. `git diff --check` passed.

## Limits and unresolved external uncertainty

A confirmed registration whose bind did not commit cannot be safely reconstructed from an order ID alone with the current provider interface: its external payment ID is unknown. Running/unknown claims remain durable and are never reopened by age, budget rollover or router restart. Likewise, sent notification with lost acknowledgement remains running/unknown rather than being retried. This sacrifices automatic completion to avoid duplicate external effects; operator/provider reconciliation requires independently verified evidence and an explicitly reviewed recovery path.

A late confirmed send that began before the deadline is still external success; persisting its confirmed outcome is appropriate. Abort/deadline bounds are worker bounds, not general create/callback transport guarantees. SQL calls already in progress may commit after a worker timeout; no rollback of proven external success is attempted. PGlite and synthetic adapters cannot establish real multi-process PostgreSQL/provider exactly-once semantics. Production auth, provider transport, quota policy, cancellation integration and reconciliation remain activation blockers.
