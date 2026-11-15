import test from 'node:test';
import assert from 'node:assert/strict';
import { interceptionLifecycle } from './browser-interception-lifecycle-helper.mjs';
const setup = () => {
 const sent = [], ws = { send: data => sent.push(JSON.parse(data)) };
 const requests = [], blocked = [];
 const lifecycle = interceptionLifecycle(ws, { origin: 'http://127.0.0.1:1234', requests, blocked, timeoutMs: 30 });
 const emit = data => ws.onmessage({ data: JSON.stringify(data) });
 const pause = (url = 'http://127.0.0.1:1234/a') => emit({ method: 'Fetch.requestPaused', params: { requestId: 'fetch1', networkId: 'net1', request: { url, method: 'GET' } } });
 return { sent, ws, lifecycle, requests, blocked, emit, pause };
};
test('matching cancellation permits stale interception; duplicate pause resumes once', async () => {
 const s = setup();s.pause();s.pause();assert.equal(s.sent.length, 1);
 s.emit({ method: 'Network.loadingFailed', params: { requestId: 'net1', canceled: true } });
 s.emit({ id: s.sent[0].id, error: { code: -32602, message: 'Invalid InterceptionId.' } });
 await s.lifecycle.drain();s.lifecycle.stop();
});
test('uncorroborated stale interception remains failure', async () => {
 const s = setup();s.pause();s.emit({ id: s.sent[0].id, error: { code: -32602, message: 'Invalid InterceptionId.' } });
 await assert.rejects(s.lifecycle.drain(), /Invalid InterceptionId/);s.lifecycle.stop();
});
test('other CDP errors remain failure even after matching cancellation', async () => {
 const s = setup();s.pause();s.emit({ method: 'Network.loadingFailed', params: { requestId: 'net1', canceled: true } });
 s.emit({ id: s.sent[0].id, error: { code: -32000, message: 'Unexpected failure' } });
 await assert.rejects(s.lifecycle.drain(), /Unexpected failure/);s.lifecycle.stop();
});
test('shutdown settles pending interception and ignores late responses/events', async () => {
 const s = setup();s.pause();s.lifecycle.stop();s.emit({ id: s.sent[0].id, result: {} });s.pause('https://example.test');
 await s.lifecycle.drain();await assert.rejects(s.lifecycle.command('Page.enable'), /closed/);assert.equal(s.sent.length, 1);
});
test('external request denied and timeout remains failure', async () => {
 const s = setup();s.pause('https://example.test/a');assert.equal(s.sent[0].method, 'Fetch.failRequest');assert.deepEqual(s.blocked, ['https://example.test/a']);
 await assert.rejects(s.lifecycle.drain(), /CDP timeout/);s.lifecycle.stop();
});
test('unexpected close rejects commands and fails harness', async () => {
 const s = setup();const p = s.lifecycle.command('Page.enable');s.ws.onclose();await assert.rejects(p, /closed/);assert.throws(s.lifecycle.check, /Unexpected CDP/);
});

const frame = (s, loaderId = 'old') => s.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'frame1', loaderId } } });
const navigating = s => s.emit({ method: 'Page.frameStartedNavigating', params: { frameId: 'frame1', loaderId: 'new', navigationType: 'differentDocument' } });
const resource = (s, requestId = 'fetch1', networkId = 'net1', resourceType = 'Image') => s.emit({ method: 'Fetch.requestPaused', params: {
 requestId, networkId, frameId: 'frame1', resourceType, request: { url: 'http://127.0.0.1:1234/a', method: 'GET' }
} });
test('cancelled request is recorded but never continued when pause arrives late', async () => {
 const s = setup();s.emit({ method: 'Network.loadingFailed', params: { requestId: 'net1', canceled: true } });s.pause();
 assert.equal(s.sent.length, 0);assert.equal(s.requests.length, 1);await s.lifecycle.drain();s.lifecycle.stop();
});
test('outgoing renderer pause without Network event is invalidated at navigation start', async () => {
 const s = setup();frame(s);navigating(s);resource(s);resource(s);
 assert.equal(s.sent.length, 0);assert.equal(s.requests.length, 1);await s.lifecycle.drain();s.lifecycle.stop();
});
test('navigation between continue dispatch and response invalidates only the outgoing loader', async () => {
 const s = setup();frame(s);resource(s);navigating(s);
 s.emit({ id: s.sent[0].id, error: { code: -32602, message: 'Invalid InterceptionId.' } });
 await s.lifecycle.drain();assert.equal(s.sent.length, 1);s.lifecycle.stop();
});
test('new navigation Document is continued; invalid active interception still fails', async () => {
 const s = setup();frame(s);navigating(s);resource(s, 'document', 'new', 'Document');
 assert.equal(s.sent.length, 1);s.emit({ id: s.sent[0].id, error: { code: -32602, message: 'Invalid InterceptionId.' } });
 await assert.rejects(s.lifecycle.drain(), /Invalid InterceptionId/);s.lifecycle.stop();
});
test('committed loader invalidates old requests but permits new subresources', async () => {
 const s = setup();frame(s);s.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'net1', loaderId: 'old' } });
 navigating(s);frame(s, 'new');resource(s);resource(s, 'fetch2', 'net2');
 assert.equal(s.sent.length, 1);assert.equal(s.sent[0].params.requestId, 'fetch2');s.emit({ id: s.sent[0].id, result: {} });
 await s.lifecycle.drain();s.lifecycle.stop();
});
test('navigation cannot hide other protocol errors', async () => {
 const s = setup();frame(s);resource(s);navigating(s);
 s.emit({ id: s.sent[0].id, error: { code: -32000, message: 'Unexpected failure' } });
 await assert.rejects(s.lifecycle.drain(), /Unexpected failure/);s.lifecycle.stop();
});
test('detached frame invalidates its in-flight action and late pauses', async () => {
 const s = setup();frame(s);resource(s);s.emit({ method: 'Page.frameDetached', params: { frameId: 'frame1', reason: 'remove' } });
 s.emit({ id: s.sent[0].id, error: { code: -32602, message: 'Invalid InterceptionId.' } });resource(s, 'fetch2');
 await s.lifecycle.drain();assert.equal(s.sent.length, 1);s.lifecycle.stop();
});
test('target detach settles pending commands and fails the harness without sending again', async () => {
 const s = setup();const p = s.lifecycle.command('Runtime.evaluate');
 s.emit({ method: 'Inspector.detached', params: { reason: 'target_closed' } });
 await assert.rejects(p, /closed/);await assert.rejects(s.lifecycle.command('Page.enable'), /closed/);
 assert.throws(s.lifecycle.check, /target detached/);s.pause();assert.equal(s.sent.length, 1);
});
test('closing websocket prevents dispatch before its close event', async () => {
 const s = setup();s.ws.readyState = 2;s.pause();
 await assert.rejects(s.lifecycle.drain(), /not open/);assert.equal(s.sent.length, 0);s.lifecycle.stop();
});
test('continue, fulfill and fail share one terminal action per paused ID', async () => {
 const s = setup();s.pause();
 const first = s.lifecycle.command('Fetch.continueRequest', { requestId: 'fetch1' });
 const second = s.lifecycle.command('Fetch.fulfillRequest', { requestId: 'fetch1', responseCode: 200 });
 const third = s.lifecycle.command('Fetch.failRequest', { requestId: 'fetch1', errorReason: 'Aborted' });
 assert.equal(first, second);assert.equal(first, third);assert.equal(s.sent.length, 1);
 s.emit({ id: s.sent[0].id, result: {} });await first;await s.lifecycle.drain();s.lifecycle.stop();
 await s.lifecycle.command('Fetch.continueRequest', { requestId: 'fetch1' });assert.equal(s.sent.length, 1);
});
test('terminal action with an unknown ID is an error and never sent', async () => {
 const s = setup();await assert.rejects(s.lifecycle.command('Fetch.continueRequest', { requestId: 'missing' }), /Unknown Fetch/);
 assert.equal(s.sent.length, 0);s.lifecycle.stop();
});
