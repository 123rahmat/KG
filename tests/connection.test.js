/**
 * The browser's request helper when the connection is poor: it retries what
 * is safe to retry, gives up on a hung request, says when the server is out
 * of reach, and announces its return so interrupted work resumes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = { getElementById: () => null };
const { api, state, waitForConnection } = await import('../public/ui-core.js');

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function serve(t, replies) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push({ path, method: options.method, key: options.headers['idempotency-key'] });
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
