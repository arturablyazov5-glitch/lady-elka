# Local HTTP transport — 2026-10-03

productionReady=false. Added only http-server.mjs, tests/http-server.test.mjs and this report. Gateway, SQL, other work, production services and dependency files were not changed. No commit, push, installs, real provider or database connection.

createServer({gateway, origins=[], maxBodyBytes=65536, timeoutMs=5000}) returns a Node HTTP server. Numeric-port and options-based listen calls default to 127.0.0.1; an explicit host is a trusted operator override. There is no automatic listener or production gateway composition.

Exact POST endpoints map to gateway routes:

- /v2/create → create
- /v2/status → status
- /v2/callback → callback
- /v2/internal/poll → internal-poll
- /v2/internal/retry → internal-retry

Queries, trailing slashes and capability/provisioning routes return 404. All routes use POST JSON objects. Other methods return 405 with Allow; unknown content type/encoding returns 415; malformed JSON, invalid UTF-8 or non-object envelopes return 400; streamed bytes over the configured limit return 413. No gateway call occurs on ingress rejection.

Authorization is passed unchanged as credentials (including absence); it is neither parsed nor minted. Body fields cannot replace credentials or server deadline. Authentication and role isolation remain the injected gateway's responsibility. Internal endpoints are routable but require gateway authentication; CORS is not authentication.

Origins are an exact configured allowlist, default empty. Disallowed Origin is rejected, absent Origin is permitted for server clients. Allowed preflight permits only POST and Content-Type/Authorization. Responses vary by Origin, use no-store and nosniff. Arbitrary gateway headers are dropped; only numeric positive Retry-After on 429 is passed, defaulting to 1. Gateway status/body are retained. Thrown failures yield generic 503 without error messages, stack, credentials or SQL details. No request logging or credentials response exists in this module. Trusted gateway bodies must themselves be safe for public disclosure; transport does not inspect or redact arbitrary application payloads.

Deadline starts at request ingress, includes body reading and gateway execution, and cannot be supplied by the client. Timeout aborts the gateway signal and responds 504 even for a noncooperative gateway. Client request abort, request error or premature response close aborts the same signal. Completed request-body close does not falsely cancel execution. Node header/request/socket timeout limits are also configured. Already-started gateway SQL/external operations may finish after cancellation; transport cannot roll them back. Body buffers are released at completion/rejection.

Validation: `node --test local-backend-v2/tests/http-server.test.mjs` — 7/7 passing. Tests use real loopback HTTP listeners and requests, with injected local gateway stubs: all route mappings and opaque forwarding, errors before dispatch, byte limit, closed CORS/preflight, 429/Retry-After, suppressed thrown secrets/extra headers, timeout of noncooperative gateway, disconnect during execution, and incomplete-body timeout. These tests do not prove real gateway auth, database isolation, provider cancellation, proxy configuration or production deployment. Slow header timing relies additionally on Node's HTTP timeout machinery, whose enforcement interval is not a precise per-request SLA. Production remains unactivated.
