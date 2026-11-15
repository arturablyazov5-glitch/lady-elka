import {createHmac, randomBytes} from 'node:crypto';
export const productionReady = false;
const fail = (code = 'CAPABILITY_UNAVAILABLE') => {throw new Error(code);};
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
function composition({executor, sessionHashKey, now = Date.now} = {}, role) {
  if (!Buffer.isBuffer(sessionHashKey) || sessionHashKey.length < 32 || typeof executor?.query !== 'function' || typeof now !== 'function') fail();
  const key = Buffer.from(sessionHashKey);
  const hash = sessionId => {
    if (!text(sessionId)) fail('INVALID_SESSION');
    return createHmac('sha256', key).update('le-v2-session\0').update(sessionId).digest('hex');
  };
  const clock = () => {const value = now(); if (!Number.isSafeInteger(value)) fail(); return value;};
  const query = async (sql, args, allowRevokedCode = false) => {
    try {
      const identity = (await executor.query('SELECT session_user,current_user')).rows?.[0];
      if (identity?.session_user !== role || identity?.current_user !== role) fail();
      return (await executor.query(sql, args)).rows;
    } catch (error) {
      if (allowRevokedCode && error?.code === 'P0001' && error?.message === 'SESSION_REVOKED') fail('SESSION_REVOKED');
      fail();
    } // Never propagate SQL details containing tokens/identifiers.
  };
  return {hash, clock, query};
}
export function createCapabilityStore(options) {
  const {hash, clock, query} = composition(options, 'le_v2_cap_resolver');
  return Object.freeze({async resolve({sessionId, owner, scope} = {}) {
    if (!text(owner) || !['create', 'status'].includes(scope)) fail('UNAUTHORIZED');
    const rows = await query('SELECT * FROM le_checkout_v2.cap_resolve($1,$2,$3)', [hash(sessionId), owner, scope]);
    const record = rows?.length === 1 ? rows[0] : null;
    const expiresMs = Number(record?.expires_ms);
    if (!record || !/^[a-f0-9]{64}$/.test(record.token) || !Number.isSafeInteger(expiresMs) || expiresMs <= clock() ||
      !(scope === 'create' ? record.can_create === true : record.can_status === true)) return null;
    return {sessionId, owner, token: record.token, expiresMs, revoked: false,
      scopes: [...(record.can_create === true ? ['create'] : []), ...(record.can_status === true ? ['status'] : [])]};
  }});
}
// Trusted server/operator composition only. Never mount these methods as public RPC/HTTP routes.
export function createCapabilityProvisioner(options) {
  const {hash, clock, query} = composition(options, 'le_v2_cap_provisioner');
  return Object.freeze({
    async issue({sessionId, owner, expiresMs, scopes} = {}) {
      if (!text(owner) || !Number.isSafeInteger(expiresMs) || expiresMs <= clock() || !Array.isArray(scopes) ||
        !scopes.length || scopes.some(scope => !['create', 'status'].includes(scope)) || new Set(scopes).size !== scopes.length) fail('INVALID_CAPABILITY');
      await query('SELECT le_checkout_v2.cap_issue($1,$2,$3,$4,$5,$6)',
        [hash(sessionId), owner, randomBytes(32).toString('hex'), expiresMs, scopes.includes('create'), scopes.includes('status')], true);
      return {expiresMs, scopes: [...scopes]}; // No token is returned, even to the issuer.
    },
    async revoke({sessionId, owner} = {}) {
      if (!text(owner)) fail('INVALID_CAPABILITY');
      await query('SELECT le_checkout_v2.cap_revoke($1,$2)', [hash(sessionId), owner]);
      return {revoked: true};
    },
  });
}
