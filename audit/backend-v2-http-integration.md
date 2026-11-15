# Local HTTP + auth + restricted gateway integration — 2026-10-03

productionReady=false. No production connections, packages, commits or push. Providers/notifier/session verification are synthetic trusted test dependencies. Auth, gateway, restricted adapter and SQL sources remain unchanged; unrelated dirty work preserved.

## Files and narrow transport bridge

Added local-backend-v2/tests/http-integration.test.mjs and this report. With explicit follow-up authorization, changed own http-server.mjs and its own http-server.test.mjs to bridge the HTTP authentication input. The existing opaque credentials value is still forwarded unchanged. Gateway input additionally contains server-owned request: {method,url,headers,rawBody}; rawBody is the original size-limited Buffer used for JSON parsing. No client body field constructs this object. This permits direct composition:

```js
const httpAuth = createHttpAuth(trustedAuthOptions);
const gateway = createGateway({...trustedGatewayOptions, auth: httpAuth.auth});
const server = createServer({gateway: input => httpAuth.dispatch(gateway, input)});
```

Before this narrow bridge, HTTP transport supplied credentials but no request, whereas http-auth verifiers required request. A trusted closure translating Authorization was possible for synthetic verifiers, but would omit callback byte/header context. The bridge supplies that context; no real signature format or verification is invented. Original transport unit test now asserts headers/method/raw bytes alongside unchanged credentials, but only the explicitly requested integration test was executed in this stage.

## Fixture and trust boundary

Each test creates a fresh disposable in-memory PGlite database, executes schema-draft.sql and roles-draft.sql, provisions finite budgets and private synthetic 256-bit random capabilities. Alice and Bob have distinct authenticated session records, each mapped privately to distinct create-only and status-only SQL capabilities. Browser Authorization selects a synthetic server session, never a SQL capability. Lookup is fresh on each request.

Executors run actual gateway/restrictedAdapter RPC SQL under le_v2_create/le_v2_status/le_v2_callback/le_v2_internal session identities. Because PGlite has one physical connection, the harness serializes identity switching and resets postgres outside application executors. The harness's privileged connection is used only to provision/read/mutate the disposable fixtures. This proves local SQL evaluation and request composition, not separate real PostgreSQL login connections or multi-process contention.

The server is listened on 127.0.0.1 and exercised with real fetch HTTP requests. No fake gateway substitutes for createGateway. Callback verifier checks original bytes parse into the exact forwarded JSON and selects a synthetic scope grant using test Authorization; internal uses its own verifier. http-auth single-use private proofs are consumed by the real gateway. Provider registration/evidence and Telegram delivery are deterministic synthetic methods with counters.

## Targeted validation

Command: `node --test local-backend-v2/tests/http-integration.test.mjs`

Result: 3 tests, 3 pass, 0 fail. No broader suite was executed in this stage.

- Four concurrent canonical HTTP create requests admit one order and one bank registration. Status resolves a different scoped capability. Alice/Bob ownership is persisted by SQL; foreign and missing status both return NOT_FOUND, even when body includes forged owner/session/capability. Bob creates his own order; Alice cannot read it. Changed canonical replay returns conflict without another effect.
- Unknown sessions, expired/revoked sessions, expired/revoked private records, mismatched session/owner and wrong capability scopes return 401. SQL independently rejects an expired SQL capability and a deleted (revoked) SQL capability despite an otherwise live private record. No additional bank registration occurs.
- Client sessions cannot call callback/internal. Callback grants cannot enter internal routes, internal grants cannot enter callback. Concurrent authenticated callback/internal poll with matching independent synthetic paid evidence produce one notification and terminal paid status. Internal retry does not repeat delivery. Exhausted actual SQL status/request budgets produce HTTP 429, preserve RATE_LIMITED and positive Retry-After, and stop new registration/delivery.
- Every HTTP response body and every response header is checked against all provisioned private capability values, including responses to malicious body fields. No capability appears in the responses. Raw client Authorization remains a synthetic session credential, not a capability.

## Remaining limits

Production remains unactivated. Real session storage/authentication, cookie CSRF rules, TLS/proxy ingress, real provider signature/replay verification, durable capability provisioning/rotation/revocation coordination, real PostgreSQL identity/pool isolation and production configuration are unverified. Raw bytes/header availability alone does not validate a bank signature. The synthetic callback credential deliberately does not model a real bank protocol. Timeout/disconnect behavior was covered by the prior transport unit stage, not rerun here. Already-started external/SQL operations can finish after cancellation. The transport/auth modules and dependency injection remain trusted server code; response privacy checks assert exact capability exclusion, not arbitrary malicious transformations.
