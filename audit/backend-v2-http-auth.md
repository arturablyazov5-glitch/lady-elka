# HTTP authentication boundary — 2026-10-03

productionReady=false. Local synthetic implementation only. Existing gateway, SQL, transport and unrelated dirty files were not edited. No secrets/env reads, dependency installs, commits, push or production operations.

## Integration contract

`createHttpAuth({verifySession, capabilityStore, verifyCallback, verifyInternal, now})` is trusted server composition. None of these dependencies or their options may come from an HTTP body. Keys, when required by a verifier, are supplied by server composition as arguments to that verifier; this module loads no keys and assumes no bank callback signature format.

```js
const httpAuth = createHttpAuth({verifySession, capabilityStore, verifyCallback, verifyInternal});
const gateway = createGateway({...gatewayOptions, auth: httpAuth.auth});
const response = await httpAuth.dispatch(gateway, {
  route, request, body, signal, deadline,
});
// HTTP server serializes only response.status / response.headers / response.body.
```

`request` is the server-owned authentication input. A verifier must authenticate it against authoritative server state; user-provided owner, clientId, sessionId or capability fields are never identities. Cookie/token parsing, CSRF/origin protection for cookie sessions, request/body limits, timeouts, TLS and route mapping belong to the transport. Keep raw callback bytes and required headers available in `request`; `verifyCallback({request, body, route, scope})` must authenticate the exact payload forwarded to gateway, using actual provider documentation. Do not mutate body between verification and gateway execution.

`verifySession(request)` returns a live record `{sessionId, owner, expiresMs, revoked: false, scopes}` or denies. Both scopes and expiry are mandatory. For create/status only, `capabilityStore.resolve({sessionId, owner, scope})` performs a fresh private lookup and returns `{sessionId, owner, token, expiresMs, revoked: false, scopes}`. Both session and capability must grant the requested create/status scope, match session and owner exactly, and remain live after lookup. Unknown/missing/revoked/expired records deny. `expiresMs` is an absolute Unix millisecond timestamp and expires at equality. No caller-supplied capability is used. Store/verifier failure denies; missing dependency returns AUTH_UNAVAILABLE.

Trusted provisioning stays outside this module: generate cryptographically random >=256-bit capabilities, persist their token/owner/expiry/create/status scope in the private SQL capability table, and associate them with the authenticated server session in the private store. No mint endpoint or provisioning function is exported. The SQL draft has no session association/revoked column: the private store maintains those fields; privileged revocation removes the SQL capability row as well as revoking the private record, and expiry/scope changes must be synchronized. Browser responses/cookies/local storage must contain no capability. This implementation deliberately does not add SQL lifecycle procedures or an in-memory production store.

`verifyCallback` and `verifyInternal` are independent mandatory verifiers. Each receives `{request, body, route, scope}` and returns `{expiresMs, revoked: false, scopes}`. Callback requires callback scope; internal-poll/internal-retry require internal scope. Their authoritative verifier must enforce revocation, expiry, replay policy and, for internal credentials, allowed operations. Passing true is insufficient. There is no shared client capability fallback.

Callback/internal resolution yields a private single-use object proof. `httpAuth.auth` consumes that proof in gateway's existing callback/internal checks; callback proof additionally binds the exact body object. Proofs from another module instance, wrong scope, replay or expiration fail. Resolve and dispatch authenticate each request afresh. The HTTP server must not expose resolve or accept a proof from clients.

`dispatch` is the preferred boundary: it keeps resolved credentials inside its server closure, forwards only gateway inputs, serializes the response, and rejects any response that includes the exact private capability (including a nested value or header). Authentication errors and thrown gateway errors have fixed sanitized response messages. `resolve` is exported for server adapters that need it; its string result is private and MUST NEVER be serialized/logged. Dispatch's leak guard catches exact/embedded capability text, not arbitrary transformations by a malicious gateway; injected gateway is trusted. Do not log request credentials, private store records, proof objects or exception details.

## Lifecycle and limits

Private lookup happens on every create/status request; no capability cache is introduced. Session and capability are checked before forwarding, and SQL independently checks capability expiry/scope/owner. Revocation after admission cannot undo an in-flight operation. Callback/internal proofs enforce expiry again at gateway consumption; authoritative revocation is evaluated by verifier at resolution, with no invented remote revocation protocol. A revocation racing after verification requires the verifier/store/SQL integration's chosen transactional policy. HTTP transport, persistent store, real session authentication, real callback signatures/replay detection, internal key rotation and actual PostgreSQL isolation remain unverified and necessary before activation.

## Validation

`node --test local-backend-v2/tests/http-auth.test.mjs` — 8/8 pass. Synthetic data only. Covers session and capability expiry/revocation, foreign session/owner, scopes, missing verifier/store, callback body binding/proof replay/expiry, internal separation, fresh revocation lookup, expiry during lookup, verifier exceptions and sanitized capability leak rejection. This is local module evidence, not HTTP end-to-end or production evidence.
