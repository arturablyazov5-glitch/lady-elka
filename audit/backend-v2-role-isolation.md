# Backend v2 role isolation — 2026-10-03

productionReady=false. Local SQL DRAFT outside supabase/migrations. Changed only roles-draft.sql, tests/roles-isolation.test.mjs and this report. schema-draft.sql/store.mjs unchanged, including crash fixes. No remote access, secrets, providers, installs, deployment, commit or push.

## Permission map

Apply schema-draft.sql followed by roles-draft.sql only in a fresh disposable local database. New role names intentionally fail on collision; this is not an idempotent production migration.

| Role | Permitted RPC | Trust and output |
| --- | --- | --- |
| le_v2_owner | Owns only v2 schema, tables and functions | NOLOGIN, no superuser/BYPASSRLS/create-role/create-db; never granted to runtime |
| le_v2_create | api_create(capability,id,fingerprint,bankNumber,amount,method,recipients) | Trusted validated create gateway; fixed budgets, protected create_open policy; returns id/status |
| le_v2_status | api_status(capability,id) | Capability resolves owner in private table; returns only owned id/status/payment_url; foreign and missing IDs both empty |
| le_v2_callback | api_callback_lookup(paymentId), api_callback_recover(id,paymentId,bankNumber,amount,evidence) | Trusted callback adapter, exact stored card mapping; no effects RPC |
| le_v2_internal | callback RPC plus api_internal(op,json) | Trusted worker: get, bounded poll/pending (20), claim(bank/telegram), finish, atomic bind, guarded status |

All runtime roles: schema USAGE, enumerated EXECUTE only, no v2 table ACL, no private function EXECUTE, no capability provisioning/policy mutation/schema CREATE. No memberships or login grants. Existing public/anon/authenticated/service_role roles and grants are not changed. All v2 functions explicitly pin search_path=pg_catalog and qualify table/function references. Only api_* wrappers are SECURITY DEFINER; original helpers remain invoker functions, now owned by NOLOGIN owner and callable inside wrappers. PUBLIC EXECUTE revoked, owner default function EXECUTE revoked for future objects. Future objects created by a different migration role still need explicit ownership/revocation review.

Status capability cannot supply owner. Protected capabilities resolve purpose and SQL-clock expiry, independently of browser owner/clientId/IP/session settings. No GUC/JWT-claim impersonation mechanism. Status output excludes owner/fingerprint/recipients/payment_id/provider_result/evidence. Payment URL is supplied by trusted provider adapter; SQL alone does not validate redirect origins. Gateway must retain payment-adapter validation before binding/exposing it.

Create SQL accepts trusted price/fingerprint/recipient inputs: this role MUST NOT be handed to browser callers. Its capability is an owner boundary, not a catalog validator. Closure defaults false and fails closed on missing policy. Owned exact replay remains available when closed. No new admission is consumed for exact replay. Status and create consume fixed owner/request-scope policies; unauthenticated/pre-SQL global requests and internal/callback budgets remain gateway responsibilities.

Internal callbacks are separate from public status/create. Callback recovery checks persisted paymentId+bankNumber+amount+card method atomically. It does NOT authenticate the bank or prove evidence freshness/status/signature: a caller possessing callback credentials can assert evidence. Worker role is similarly trusted for effect results. Provider adapter must establish these facts before using its credentials. Callback-triggered notification must dispatch to the authenticated worker, never share internal credentials with the callback ingress.

## Local proof

Installed PGlite supports real PostgreSQL CREATE ROLE, SET ROLE and SET SESSION AUTHORIZATION.
Four meaningful tests plus existing regressions: 35/35 passed with:
node --test local-backend-v2/tests/*.test.mjs storefront/tests/api-v2-contract-local.test.mjs
Log: /tmp/le-v2-role-tests.log.

- SET ROLE for each runtime role: SELECT/DELETE/INSERT denied on public.payment_orders, public.le_orders, catalog/blog sentinels and private v2 orders/effects/capabilities/budgets; direct effects UPDATE, private budget helper and schema CREATE denied with SQLSTATE 42501.
- Capability expiry/scope/wrong token denied; own status succeeds; foreign/missing order empty with the same projection; create/status/callback/internal route RPC separation enforced.
- Internal claim/bind and callback mapping/recovery execute under definer owner without table access. Foreign payment denied. Paid cannot be downgraded by internal pending_review; direct paid setter rejected. Legacy sentinel unchanged.
- Non-superuser session authorization cannot SET ROLE owner/create/internal/callback or become superuser. Roles have no login/superuser/BYPASSRLS and no memberships.
- Closed policy blocks new reservation while owned exact replay works.
- Catalog checks confirm wrapper SECURITY DEFINER, all function ownership and pinned search_path. Previous router/budget/crash/contract regressions pass with untouched original store.

PGlite superuser SET ROLE retains postgres session_user, so that alone cannot prove inability to escalate; the independent SET SESSION AUTHORIZATION test explicitly changes session_user. These are real local SQL ACL checks, not production PostgreSQL/PostgREST/network authentication evidence. Existing regression routers use the old privileged local executor; they do not demonstrate end-to-end use of the new restricted RPC surface.

## Required trusted gateway/capability adapter

Concrete future adapter: separate least-privilege DB connection identities for create/status/callback/worker, each mapped only to its named NOLOGIN role after a separately reviewed login/membership configuration. A pool must not connect as superuser, service_role or a role able to switch among all route roles. Separate pools/credentials enforce route isolation; never fallback to shared service_role when unavailable.

Provisioning service outside request SQL owns capability lifecycle. Authenticate a caller using a reviewed session or opaque checkout capability protocol, generate >=256 random bits server-side, bind to server-derived immutable owner and explicit create/status scope/expiry; provision through separately protected administration. No public mint RPC is included. Browser clientId, owner fields, headers and SQL settings never establish identity. Store tokens privately, redact logs, define revocation/rotation and transport protections. Plaintext token table here is draft-only; production should review digest-based lookup and token storage. Fixture strings are synthetic test credentials, not production auth.

Create gateway validates shared envelope and endpoint/version, fresh trusted catalog revision, authoritative minor-unit amount, whole-payload fingerprint, server recipients, namespaced ID and safe return URLs. It verifies capability, enforces pre-auth/global route budgets/body limits and invokes api_create; worker receives only authenticated work for an admitted owned order. Status invokes only api_status and validates origin-safe redirect before emitting the shared payment contract. Worker translates existing store methods to api_internal/callback RPCs, validates provider outputs/evidence and preserves transaction/deadline/outcome semantics. No such adapter is implemented here; store.ready/get/UPDATE currently cannot run as these roles. Runtime activation with old sqlStore is prohibited.

Callback gateway checks bank authenticity/replay controls and route budget, looks up exact persisted v2 payment, obtains independently authenticated provider evidence, checks fresh paid status/exact amount/number/id, then calls recover. Worker authenticates its jobs, enforces internal budgets/deadlines, uses immutable recipients and durable effect claims; uncertain outcomes remain running/unknown. Distinct limited callback role cannot send/finish effects.

## Deployment prerequisites and limits

1. Explicit authorization and reviewed production migration. No instructions here authorize applying this draft.
2. Audit actual PostgreSQL/PostgREST support for custom login/membership, schema exposure, pooling/reset and transaction boundaries. NOLOGIN role definitions alone do not create usable isolated transport credentials.
3. Audit ALL inherited PUBLIC privileges, existing SECURITY DEFINER functions, schemas, role memberships and database CREATE/TEMP privileges. PostgreSQL has no negative grant: if legacy tables or powerful public RPCs are granted to PUBLIC, new roles inherit access. This draft neither removes nor overrides those grants. Local sentinels use default private table ACLs; denial there does not prove current production ACLs. Resolve any ambient privilege path under separately approved review or use a separate database/project. Do not bypass isolation with service_role.
4. Implement/review the concrete gateway/capability/worker adapter above and end-to-end restricted-role regressions, real multiprocess PostgreSQL tests and deployment HTTP contract tests.
5. Configure finite SQL budgets, create policy, capability expiry/rotation, operator provisioning and operational recovery. Validate provider authenticity, origin policy, catalog freshness and cancellation.
6. Shared merchant/bot quotas, bank callback topology and deployment remain independent blockers; v2 counters do not bound legacy aggregate traffic.

This provides local limited-role SQL boundaries, not production auth, provider evidence, isolated infrastructure or production readiness.
