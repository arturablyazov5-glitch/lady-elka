// Local composition only: no HTTP credential format, secret loading or mint API.
export const productionReady = false;
const denial = (code = 'UNAUTHORIZED', status = 401) =>
  Object.assign(new Error(code), {status});
const validText = x => typeof x === 'string' && x.length > 0;

export function createHttpAuth({verifySession, capabilityStore, verifyCallback, verifyInternal, now = Date.now} = {}) {
  const proofs = new WeakMap();
  function time() {
    const t = now();
    if (!Number.isSafeInteger(t)) throw denial('AUTH_UNAVAILABLE', 503);
    return t;
  }
  function live(record, scope) {
    return record && record.revoked === false && Number.isSafeInteger(record.expiresMs) &&
      record.expiresMs > time() && Array.isArray(record.scopes) && record.scopes.includes(scope);
  }
  async function resolve({route, request, body} = {}) {
    if (route === 'create' || route === 'status') {
      if (typeof verifySession !== 'function' || typeof capabilityStore?.resolve !== 'function')
        throw denial('AUTH_UNAVAILABLE', 503);
      let session, capability;
      try {
        session = await verifySession(request);
        if (!live(session, route) || !validText(session.sessionId) || !validText(session.owner)) throw denial();
        capability = await capabilityStore.resolve({sessionId: session.sessionId, owner: session.owner, scope: route});
      } catch { throw denial(); }
      if (!live(session, route) || !live(capability, route) || capability.sessionId !== session.sessionId ||
          capability.owner !== session.owner || !validText(capability.token)) throw denial();
      return capability.token; // Server-only; never put in an HTTP response, cookie or log.
    }
    const scope = route === 'callback' ? 'callback' :
      ['internal-poll', 'internal-retry'].includes(route) ? 'internal' : null;
    if (!scope) throw denial('ROUTE_NOT_FOUND', 404);
    const verifier = scope === 'callback' ? verifyCallback : verifyInternal;
    if (typeof verifier !== 'function') throw denial('AUTH_UNAVAILABLE', 503);
    let grant;
    try { grant = await verifier({request, body, route, scope}); } catch { throw denial(); }
    if (!live(grant, scope)) throw denial();
    const proof = Object.freeze(Object.create(null));
    proofs.set(proof, {grant, scope, body});
    return proof;
  }
  function consume(proof, scope, body) {
    const entry = proof && typeof proof === 'object' ? proofs.get(proof) : null;
    if (!entry || entry.scope !== scope || (scope === 'callback' && entry.body !== body)) return false;
    proofs.delete(proof);
    return Boolean(live(entry.grant, scope));
  }
  const auth = Object.freeze({
    callback: async (proof, body) => consume(proof, 'callback', body),
    internal: async proof => consume(proof, 'internal'),
  });
  // Preferred HTTP boundary: credentials never escape this closure into a response.
  async function dispatch(gateway, {route, request, body, signal, deadline} = {}) {
    try {
      if (typeof gateway !== 'function') throw denial('AUTH_UNAVAILABLE', 503);
      const credentials = await resolve({route, request, body});
      if (signal?.aborted || !Number.isSafeInteger(deadline) || deadline <= Date.now())
        return {status: 504, body: {error: 'REQUEST_CANCELLED'}};
      const result = await gateway({route, body, credentials, signal, deadline});
      // Fail closed even if an injected gateway accidentally echoes its capability.
      const serialized = JSON.stringify(result);
      if (typeof serialized !== 'string' || (typeof credentials === 'string' &&
          serialized.includes(JSON.stringify(credentials).slice(1, -1)))) throw denial('AUTH_UNAVAILABLE', 503);
      return JSON.parse(serialized);
    } catch (error) {
      const code = ['UNAUTHORIZED', 'AUTH_UNAVAILABLE', 'ROUTE_NOT_FOUND'].includes(error?.message)
        ? error.message : 'AUTH_UNAVAILABLE';
      return {status: code === 'UNAUTHORIZED' ? 401 : code === 'ROUTE_NOT_FOUND' ? 404 : 503, body: {error: code}};
    }
  }
  return Object.freeze({resolve, auth, dispatch});
}
