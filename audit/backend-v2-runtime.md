# Local backend runtime — 2026-10-03

productionReady=false. Added only local-backend-v2/runtime.mjs, tests/runtime.test.mjs and this report. Existing transport/auth/gateway/SQL and unrelated work remain unchanged. No new packages, environment/secrets reads, production connections, provisioning, commits, push or deployment.

## Composition and configuration

createRuntime(options) validates required dependency interfaces before creating a listener and connects createHttpAuth → createGateway → createServer. Required options: executors with query for all four roles (create/status/callback/internal), identity with explicit ownerEndpoint/apiVersion=2/fingerprintVersion=sha256-canonical-json-v1, verifyCatalog, verifySession, capabilityStore.resolve, verifyCallback, verifyInternal, provider.register/provider.evidence, notifier.send, nonempty recipients, explicit origins and paymentOrigins arrays. Missing interfaces or invalid configuration throw RUNTIME_CONFIG:<field> before listen. Transport independently validates body/time bounds.

Origins must be exact canonical HTTPS origins or HTTP origins on localhost/127.0.0.1/::1; wildcard, opaque, userinfo, paths, queries, trailing slashes and remote plaintext HTTP fail. Empty arrays are explicit closed allowlists. The owner endpoint is explicit HTTPS or local HTTP, with no userinfo/hash. No default endpoint exists. Runtime copies public identity fields only so unrelated private identity configuration is not serialized by create responses. Required interface checks do not prove executor role credentials, origin ownership or authoritative verifier correctness; those remain trusted provisioning responsibilities and gateway's role checks.

Create is blocked with CREATE_CLOSED/503 unless localCreateEnabled is exactly true. HTTP cannot change this flag. The runtime never changes SQL gateway_policy or provisions capabilities/budgets. Explicit local opt-in still requires SQL admission policy to be open independently. Status/callback/internal retain their mandatory authentication and SQL gates.

listen({port=0,host='127.0.0.1'}) returns the Node address after binding. Only 127.0.0.1 and ::1 are permitted: this runtime is a local assembly point. It listens once and cannot reopen after shutdown. No CLI entry point or automatic listen is introduced. No privileged fallback/pool, default providers, env secret resolution or authentication shortcuts are added.

## Shutdown ownership

shutdown() is idempotent and returns the same promise. It immediately stops admissions, aborts active gateway signals, destroys tracked sockets (including partial-body/header requests), closes the listener and optionally invokes cleanup({signal,deadline}). shutdownMs defaults to 1000 and bounds the combined wait; result is {timedOut:false}, {timedOut:true}, or {timedOut:false,cleanupFailed:true}. Hook exceptions are sanitized. On timeout the hook signal aborts; a noncooperative hook may continue, but its eventual failure is handled. Runtime never automatically closes executor/store/provider objects. Resource ownership and safe closure while outstanding operations unwind belong to the explicit cleanup hook.

Cancellation does not roll back SQL/external calls already started, and cannot force a noncooperative provider promise to settle. The listener and sockets are closed independently of those promises. Verifier/store dependencies retain existing auth signatures without an abort parameter; bounded HTTP/shutdown still disconnects clients and aborts the gateway signal, but cannot forcibly terminate those dependencies. No process signal handlers are installed.

## Example local assembly

Dependencies below are supplied by a local harness/operator, not loaded from env. executors must be restricted-role local connections, and capabilityStore only resolves already provisioned private records. Synthetic mock providers must return the existing gateway result/evidence shapes. The test file includes a complete disposable PGlite fixture plus synthetic session/store/provider dependencies.

```js
import {createRuntime} from './local-backend-v2/runtime.mjs';
const runtime = createRuntime({
  executors: localRestrictedExecutors,
  identity: {
    apiVersion: '2', fingerprintVersion: 'sha256-canonical-json-v1',
    ownerEndpoint: 'http://127.0.0.1:4176/pay-v2',
  },
  verifyCatalog: localCatalogVerifier,
  verifySession: syntheticSessionVerifier,
  capabilityStore: localPrivateCapabilityStore,
  verifyCallback: syntheticCallbackVerifier,
  verifyInternal: syntheticInternalVerifier,
  provider: mockPaymentProvider,
  notifier: mockNotifier,
  recipients: ['synthetic-recipient'],
  origins: ['http://127.0.0.1:4176'],
  paymentOrigins: ['https://mock-bank.invalid'],
  localCreateEnabled: true, // does not open the independent SQL admission gate
  timeoutMs: 5000, maxBodyBytes: 65536, shutdownMs: 1000,
  cleanup: async ({signal,deadline}) => localOwnedResources.close({signal,deadline}),
});
const address = await runtime.listen({port: 0});
// Local HTTP requests may now use address.port; shutdown also works before listen.
const result = await runtime.shutdown();
```

## Targeted validation

Command: `node --test local-backend-v2/tests/runtime.test.mjs`

Result: 3 tests, 3 pass, 0 fail (~1.9s). Only this targeted suite executed. Scoped git diff --check passes.

- Actual localhost HTTP create/status compose auth, real gateway and restrictedAdapter against schema-draft.sql/roles-draft.sql in disposable PGlite. One bank registration succeeds and status returns the safe mock URL without private capability text. Loopback binding, listener closure, no executor auto-close and rejection of restart are checked.
- Missing mandatory dependencies and unsafe origins reject synchronously. Default create returns 503 and admits zero SQL orders even though the fixture's SQL gate is open. Status still works. Shutdown before listen works, and a nonloopback listen attempt fails.
- A real SQL-admitted request reaches a noncooperative synthetic provider; shutdown aborts its observed signal and disconnects HTTP, closes the listener, calls explicit cleanup exactly once, aborts a noncooperative cleanup at the 80ms test bound, and returns timedOut. Repeated shutdown returns the same promise; injected executor close methods are never called.

PGlite has one physical session; the fixture serializes role switching around application SQL, using its privileged setup connection only outside injected executors. This does not prove real login/pool isolation, production ACLs or multi-process contention.

## Real deployment dependencies still required

Restricted PostgreSQL login/pool provisioning and ambient ACL review; durable session verification and private capability lifecycle/store; authenticated provider callback signatures/replay checks; internal authentication/rotation and scheduler; authoritative fresh catalog quote/revision source; real payment/notifier adapters and reconciliation of uncertain outcomes; TLS/reverse-proxy ingress, owned HTTPS origins, merchant/bot quotas, admission/budget policy, owned cleanup hooks and operational monitoring. All are unverified here. This local runtime has no production activation path; localCreateEnabled does not imply production readiness.
