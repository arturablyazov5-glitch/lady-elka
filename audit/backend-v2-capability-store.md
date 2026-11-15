# Persistent private capability store — 2026-10-03

productionReady=false. New local-only files: capability-store.mjs, capability-store-draft.sql, tests/capability-store.test.mjs and this audit. No existing gateway, SQL, HTTP integration, package files or unrelated changes were modified. No environment/secrets reads, files containing tokens, new packages, commits, push or production operations.

## Composition and contract

Exports: `productionReady`, `createCapabilityStore(options)` and `createCapabilityProvisioner(options)`. Both require `{executor, sessionHashKey, now=Date.now}`; sessionHashKey is a Buffer of at least 32 bytes supplied by trusted server composition. It is copied internally. Use separate stable role-bound executors, never a shared administrator pool with application SET ROLE. Each call validates both session_user/current_user; SQL also verifies session_user inside the SECURITY DEFINER RPC.

```js
const capabilityStore = createCapabilityStore({
  executor: resolverExecutor, // le_v2_cap_resolver
  sessionHashKey,
});
const provisioner = createCapabilityProvisioner({
  executor: provisionerExecutor, // le_v2_cap_provisioner, operator/server only
  sessionHashKey,
});
await provisioner.issue({sessionId, owner, expiresMs, scopes: ['create', 'status']});
// issue returns {expiresMs, scopes}, never the token.
const httpAuth = createHttpAuth({verifySession, capabilityStore, verifyCallback, verifyInternal});
await provisioner.revoke({sessionId, owner}); // returns {revoked:true}
```

`resolve({sessionId,owner,scope})` accepts only create/status, and returns null if no live authorized mapping exists, otherwise `{sessionId,owner,token,expiresMs,revoked:false,scopes}` as required by http-auth. This result is server-private: use http-auth.dispatch, never serialize it to clients or log it. Malformed input/configuration and backend failure throw fixed errors without SQL details. SQL results are not cached. A reconstructed store object resolves the same persisted mapping with the same key and executor.

`sessionId` must be the server's authenticated session identity from verifySession, not an unverified body/header field. Prefer a non-bearer server session identifier. It is HMAC-SHA256 hashed with a domain separator before entering SQL, so the private mapping stores no plaintext session identifier/browser bearer token. Private capability tokens are randomBytes(32) hex (256-bit randomness) and necessarily stored in the existing capabilities table and private mapping. No key is loaded from filesystem/env. Keep the HMAC key stable across process recreation; changing it makes previous mappings inaccessible. Key migration/rotation is not implemented.

Trusted issue accepts only future safe-integer Unix ms expiry and nonempty unique create/status scopes. There is no user-supplied capability token argument in the JavaScript issuance API. SQL independently checks expiry, supported flags, identifier format and token length/format; it cannot prove entropy of a value supplied by its trusted provisioner role. Provisioner is a private operator/server object, not a public mint endpoint. Never grant its role to the runtime resolver or expose its methods as public RPC/HTTP. Issuance authentication/authorization policy belongs to trusted server composition.

## SQL lifecycle and least privilege

Apply capability-store-draft.sql only after schema-draft.sql and roles-draft.sql in a fresh isolated disposable database. It creates two new NOLOGIN restricted roles, one private session_capabilities table, and three fixed-search-path SECURITY DEFINER functions owned by existing le_v2_owner. Runtime has only cap_resolve EXECUTE; provisioner has only cap_issue/cap_revoke EXECUTE. Neither gets direct table privileges. PUBLIC EXECUTE/table privileges are revoked explicitly. Existing draft and existing role memberships/public ACLs are unchanged.

Mapping session_hash is unique; owner is immutable even after revoke. issue inserts/locks the mapping row, removes the previous token reference/SQL capability, inserts the new capability, then binds it and clears revocation in one function-call transaction. Token rotation therefore invalidates the old SQL capability. Repeated or concurrent issue operations serialize on the mapping row; the last committed issuance wins and only one capability remains for that session. Operations for different sessions retain separate tokens. One token may grant create, status or both.

revoke also inserts an owner-bound tombstone for an unknown session, locks the same row, marks revoked, clears the mapping and deletes the SQL capability in one transaction. Repeated revocation is idempotent; wrong owner always fails. Explicit later trusted issue can reactivate a revoked session. Racing issue/revoke are ordered by the row lock/commit order, with the last operation deciding authority. If the session itself must remain permanently closed, verifySession's independent revocation policy must reject it and the operator must not deliberately reissue it.

An exception at any mutation rolls back the entire RPC, including newly inserted mapping rows and removal of a previous capability. Resolver requires matching mapping owner and capability owner, live DB expiry and requested SQL flag. JavaScript independently checks live safe-integer expiry and requested flag. Existing cap_owner independently enforces owner/expiry/scope on subsequent gateway SQL admission. Revocation cannot undo an already admitted/in-flight transaction or external effect.

## Local evidence

Command: `node --test local-backend-v2/tests/capability-store.test.mjs` — 7/7 passing on installed PGlite. Tests apply real schema/roles/new draft in their own fixture and execute application queries under actual restricted session authorization. Covers durable lookup after object recreation, no plaintext session mapping, issuance response privacy, session/owner/scope isolation, immutable owner, module and SQL expiry, idempotent revoke and SQL token removal, twelve concurrent issuance requests, token rotation, ordered issue/revoke, explicit reissue, partial insertion error rollback (existing and new session), real runtime ACL denial for provisioning/direct table access/escalation, provisioner denial for resolver RPC, privileged executor rejection, input checks and changed-key denial.

PGlite has one physical session: fixture serializes every query's session-authorization switch; privileged postgres restores identity only in the test harness. This proves SQL ACL/function transaction evaluation and concurrent JavaScript requests, not real PostgreSQL multi-process lock contention or restart/disk durability. Store object recreation is verified against persistent database rows, not a process-memory Map.

## Remaining limits

No HTTP transport/integration files changed. Real login/pool provisioning, TLS/session verifier, HMAC key custody/rotation, operator authorization, PostgreSQL disk/restart durability and multi-process contention remain unverified. This draft must not be applied to an existing project/production; actual surrounding memberships/ambient ACLs require review. DB-backed capability authority must remain private and must never be exposed by PostgREST/public schema routes. Direct privileged writes outside these lifecycle RPCs can violate mapping consistency; trusted operators must use the defined lifecycle. Legacy manually provisioned capabilities have no session mapping and cannot be resolved by this store. Expired rows/tombstones are retained; no cleanup scheduler or destructive pruning policy is introduced.
