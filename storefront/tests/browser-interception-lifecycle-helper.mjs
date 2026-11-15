// CDP transport owned by the offline browser harness. Event callbacks never reject.
export function interceptionLifecycle(ws, { origin, requests, blocked, timeoutMs = 10000 }) {
 let sequence = 0, closing = false, failure;
 const pending = new Map(), interceptions = new Map(), cancelled = new Set(), events = new Set();
 const frames = new Map(), network = new Map();
 const transportOpen = () => ws.readyState === undefined || ws.readyState === 1;
 const obsolete = p => {
  if (p.networkId && cancelled.has(p.networkId)) return true;
  const frame = frames.get(p.frameId);
  const activeLoader = frame?.nextLoaderId || frame?.loaderId;
  return !!frame && (frame.detached || (p.loaderId && activeLoader && activeLoader !== p.loaderId));
 };
 const check = () => { if (failure) throw failure; };
 const sendCommand = (method, params = {}) => new Promise((resolve, reject) => {
  if (closing) return reject(new Error('CDP transport closed'));
  if (failure) return reject(failure);
  if (!transportOpen()) return reject(new Error('CDP transport is not open'));
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
  pending.set(id, { resolve, reject, timer });
  try { ws.send(JSON.stringify({ id, method, params })); }
  catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
 });
 const command = (method, params = {}) => {
  if (!['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest'].includes(method)) return sendCommand(method, params);
  const interception = interceptions.get(params.requestId);
  if (!interception) return Promise.reject(new Error(`Unknown Fetch interception: ${params.requestId}`));
  // Claim before sending, shared by every terminal operation on this ID.
  // Repeated callers receive the original outcome, never another CDP action.
  return interception.action ||= closing || obsolete(interception.pause)
   ? Promise.resolve()
   : sendCommand(method, params);
 };
 const stop = () => {
  closing = true;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP transport closed')); }
  pending.clear();
 };
 ws.onclose = () => { if (!closing) failure = new Error('Unexpected CDP transport close'); stop(); };
 ws.onerror = () => { if (!closing) failure = new Error('CDP transport error'); stop(); };
 ws.onmessage = e => {
  try {
   const m = JSON.parse(e.data);
   if (m.id) {
    const p = pending.get(m.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(Object.assign(new Error(JSON.stringify(m.error)), { cdpError: m.error })) : p.resolve(m.result);
   } else if (m.method === 'Network.requestWillBeSent') {
    network.set(m.params.requestId, { loaderId: m.params.loaderId });
   } else if (m.method === 'Page.frameStartedNavigating') {
    const p = m.params, frame = frames.get(p.frameId);
    if (frame && p.loaderId && p.loaderId !== frame.loaderId) frame.nextLoaderId = p.loaderId;
   } else if (m.method === 'Page.frameNavigated') {
    const p = m.params.frame;
    frames.set(p.id, { loaderId: p.loaderId });
   } else if (m.method === 'Page.frameStoppedLoading') {
    const frame = frames.get(m.params.frameId);
    if (frame) delete frame.nextLoaderId;
   } else if (m.method === 'Page.frameDetached') {
    const frame = frames.get(m.params.frameId);
    if (frame) frame.detached = true;
   } else if (m.method === 'Inspector.detached') {
    failure ||= new Error(`CDP target detached: ${m.params.reason}`);
    stop();
   } else if (m.method === 'Network.loadingFailed' && m.params.canceled) cancelled.add(m.params.requestId);
   else if (m.method === 'Fetch.requestPaused' && !closing) {
    const frame = frames.get(m.params.frameId);
    // Fetch may arrive without requestWillBeSent when the outgoing renderer's
    // request is destroyed during navigation. Document requests use the new
    // loader (their networkId); subresources still belong to the current one.
    const p = { ...m.params, loaderId: network.get(m.params.networkId)?.loaderId ||
     (m.params.resourceType === 'Document' ? m.params.networkId : frame?.loaderId) };
    if (interceptions.has(p.requestId)) return;
    interceptions.set(p.requestId, { pause: p });
    requests.push({ url: p.request.url, method: p.request.method });
    const allow = new URL(p.request.url).origin === origin && p.request.method === 'GET';
    if (!allow) blocked.push(p.request.url);
    // Do not dispatch a terminal action for an already cancelled/detached
    // request. A navigation can also invalidate it between this check and the
    // CDP response; only the exact stale-id error is benign in that case.
    const task = command(allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', allow ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' })
     .catch(error => {
      if (closing && !error.cdpError && error.message === 'CDP transport closed') return;
      if (error.cdpError?.code === -32602 && /^Invalid InterceptionId\.?$/.test(error.cdpError.message) && obsolete(p)) return;
      failure ||= error;
     }).finally(() => events.delete(task));
    events.add(task);
   }
  } catch (error) { failure ||= error; }
 };
 return { command, check, async drain() { await Promise.all([...events]); check(); }, stop };
}
