/**
 * The browser's request helper when the connection is poor: it retries what
 * is safe to retry, gives up on a hung request, says when the server is out
 * of reach, and announces its return so interrupted work resumes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { getElementById: () => null });
const { api, state, waitForConnection, updateConnectionUI } = await import('../public/ui-core.js');

test('the live view is notified only when connection status changes', async () => {
  state.network.online = true;
  state.network.reachable = false;
  const seen = [];
  const listener = () => seen.push(state.network.online);
  globalThis.document.addEventListener('kindgleam:connection-state', listener);
  try {
    updateConnectionUI();
    updateConnectionUI();
    await Promise.resolve();
    state.network.reachable = true;
    updateConnectionUI();
    await Promise.resolve();
    assert.deepEqual(seen, [false, true]);
  } finally { globalThis.document.removeEventListener('kindgleam:connection-state', listener); }
});

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function serve(t, replies) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push({ path, method: options.method, key: options.headers['idempotency-key'], workspaceId: options.headers['x-workspace-id'] });
    const next = replies.shift();
    return typeof next === 'function' ? next(options) : next;
  });
  return calls;
}
const dropped = () => { throw new TypeError('fetch failed'); };
const events = name => {
  const seen = [];
  globalThis.window.addEventListener(name, () => seen.push(name));
  return seen;
};

test('a read survives a dropped connection, and the return is announced', async t => {
  state.network.reachable = true;
  const reconnected = events('kindgleam:reconnected');
  const calls = serve(t, [dropped, json({ ok: 1 })]);
  assert.deepEqual(await api('GET', '/api/runs/r1'), { ok: 1 });
  assert.equal(calls.length, 2);
  assert.equal(state.network.reachable, true);
  assert.equal(reconnected.length, 1, 'waiting work is told the server is back');
});

test('a write is retried only when it carries an idempotency key, and always with the same key', async t => {
  state.network.reachable = true;
  const once = serve(t, [dropped, json({})]);
  await assert.rejects(api('POST', '/api/runs/r1/advance', { a: 1 }), error => error.code === 'offline');
  assert.equal(once.length, 1, 'a write without a key could be done twice, so it is not retried');

  t.mock.restoreAll();
  const keyed = serve(t, [dropped, json({ id: 'run' }, 201)]);
  assert.deepEqual(await api('POST', '/api/runs', { goal: 'x' }, { idempotencyKey: 'k1' }), { id: 'run' });
  assert.deepEqual(keyed.map(call => call.key), ['k1', 'k1']);
});

test('a proxy error page or a restarting server is retried; a real refusal is not', async t => {
  state.network.reachable = true;
  const page = () => new Response('<html>Bad gateway</html>', { status: 502 });
  const calls = serve(t, [page, json({ fine: true })]);
  assert.deepEqual(await api('GET', '/api/x'), { fine: true });
  assert.equal(calls.length, 2);

  t.mock.restoreAll();
  serve(t, [page, page]);
  await assert.rejects(api('GET', '/api/x', undefined, { retries: 1 }), error => error.transient === true && error.code === 'server-unavailable');

  t.mock.restoreAll();
  const refused = serve(t, [json({ error: 'No', code: 'usage-policy' }, 400)]);
  await assert.rejects(api('GET', '/api/x'), error => error.code === 'usage-policy' && !error.transient);
  assert.equal(refused.length, 1);
});

test('a request that hangs is given up on, and the server is marked out of reach', async t => {
  state.network.reachable = true;
  serve(t, [options => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))]);
  await assert.rejects(api('GET', '/api/slow', undefined, { timeoutMs: 20, retries: 0 }), error => error.code === 'offline');
  assert.equal(state.network.reachable, false);

  // Waiting for the connection probes the server and resolves once it answers.
  t.mock.restoreAll();
  const probes = serve(t, [json({ ok: true })]);
  await waitForConnection();
  assert.equal(probes[0].path, '/api/health');
  assert.equal(state.network.reachable, true);
});

test('an expired session sends the person back to sign in', async t => {
  state.principal = { id: 'p' };
  const signedOut = events('kindgleam:signed-out');
  serve(t, [json({ error: 'Sign in', code: 'unauthenticated' }, 401)]);
  await assert.rejects(api('GET', '/api/runs'), error => error.status === 401);
  assert.equal(signedOut.length, 1);
  state.principal = null;
});

test('malformed successful responses fail instead of pretending a write succeeded', async t => {
  const calls = serve(t, [new Response('<html>proxy</html>', { status: 200 })]);
  await assert.rejects(api('POST', '/api/objects', { content: 'x' }), error => error.code === 'invalid-api-response' && error.status === 200);
  assert.equal(calls.length, 1);
});

test('a captured workspace is used even if the current view changed', async t => {
  state.workspaceId = 'new-workspace';
  const calls = serve(t, [json({ id: 'object' })]);
  await api('POST', '/api/objects', {}, { workspaceId: 'original-workspace' });
  assert.equal(calls[0].workspaceId, 'original-workspace');
  state.workspaceId = null;
});

test('null error bodies retain the HTTP failure; valid JSON values remain compatible', async t => {
  serve(t, [json(null, 400), json(['one']), json(null), json(3), new Response(null, { status: 204 })]);
  await assert.rejects(api('GET', '/api/x'), error => error.status === 400 && !error.transient);
  assert.deepEqual(await api('GET', '/api/x'), ['one']);
  assert.equal(await api('GET', '/api/x'), null);
  assert.equal(await api('GET', '/api/x'), 3);
  assert.equal(await api('DELETE', '/api/x'), null);
});

test('explicit retries cannot replay an unsafe write', async t => {
  const calls = serve(t, [json({}, 502, { 'retry-after': '0' }), json({ ok: true })]);
  await assert.rejects(api('POST', '/api/x', {}, { retries: 2 }), error => error.status === 502);
  assert.equal(calls.length, 1);
});

test('retry counts are bounded even when callers supply a huge budget', async t => {
  const replies = Array.from({ length: 7 }, () => json({}, 503, { 'retry-after': '0' }));
  const calls = serve(t, replies);
  await assert.rejects(api('GET', '/api/x', undefined, { retries: 100 }), error => error.status === 503);
  assert.equal(calls.length, 6);
});

test('invalid retry budgets use the safe default instead of looping forever', async t => {
  const calls = serve(t, Array.from({ length: 5 }, () => json({}, 503, { 'retry-after': '0' })));
  await assert.rejects(api('GET', '/api/x', undefined, { retries: NaN }), error => error.status === 503);
  assert.equal(calls.length, 4);
});

test('long numeric and HTTP-date Retry-After values surface the wait without an early retry', async t => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const calls = serve(t, [json({}, 429, { 'retry-after': '90' }), json({}, 503, { 'retry-after': new Date(now + 60_000).toUTCString() })]);
  await assert.rejects(api('GET', '/api/x'), error => error.status === 429 && error.retryAfterMs === 90_000);
  await assert.rejects(api('GET', '/api/x'), error => error.status === 503 && error.retryAfterMs === 60_000);
  assert.equal(calls.length, 2);
});

test('Retry-After survives an interrupted error body', async t => {
  const response = json({}, 429, { 'retry-after': '90' });
  t.mock.method(response, 'text', async () => { throw new TypeError('connection dropped reading the body'); });
  const calls = serve(t, [response, json({ ok: true })]);
  await assert.rejects(api('GET', '/api/x'), error => error.status === 429 && error.retryAfterMs === 90_000 && error.cause instanceof TypeError);
  assert.equal(calls.length, 1, 'known server wait must survive a body-reading failure');
});

test('a short HTTP-date Retry-After is honored before a safe retry', async t => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const calls = serve(t, [json({}, 429, { 'retry-after': new Date(now + 2_000).toUTCString() }), json({ ok: true })]);
  const pending = api('GET', '/api/x');
  // Drain response.text() and its promise continuations before advancing time.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  t.mock.timers.tick(1_999);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(calls.length, 2);
});
