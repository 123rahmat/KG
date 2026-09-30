import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/**
 * Runs the real public/sw.js against a small stand-in for the browser:
 * Cache Storage, the network, and fetch/install events.
 */
function serviceWorker({ network }) {
  const stores = new Map();
  const cacheFor = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    const key = request => (typeof request === 'string' ? request : new URL(request.url).pathname);
    return {
      put: async (request, response) => { store.set(key(request), response); },
      match: async request => store.get(key(request)),
      addAll: async paths => { for (const path of paths) store.set(path, await network(path)); }
    };
  };
  const caches = {
    open: async name => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    match: async request => {
      for (const name of stores.keys()) {
        const hit = await cacheFor(name).match(request);
        if (hit) return hit;
      }
      return undefined;
    }
  };
  const listeners = {};
  const self = {
    location: { origin: 'https://ai.example' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  const context = vm.createContext({
    self, caches, URL,
    Response: { error: () => page('NETWORK ERROR', 0) },
    fetch: async request => network(new URL(request.url).pathname)
  });
  vm.runInContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);

  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  return {
    stores,
    async install() {
      let done;
      listeners.install({ waitUntil: promise => { done = promise; } });
      await done;
    },
    /** Dispatch a fetch; returns the response, or null when the worker leaves it to the browser. */
    async request(path, { mode = 'cors', method = 'GET', origin = self.location.origin } = {}) {
      let responded = null;
      listeners.fetch({ request: { url: origin + path, method, mode }, respondWith: promise => { responded = promise; } });
      const response = responded ? await responded : null;
      await settle(); // let background cache writes finish
      return response;
    }
  };
}

// A same-origin ("basic") response, as the browser would hand the worker.
const page = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  type: 'basic',
  text: async () => body,
  clone() { return page(body, status); }
});

test('offline, the app shell stays the app even after another page or an error was visited', async () => {
  let online = true;
  const pages = { '/': 'APP', '/index.html': 'APP', '/policy.html': 'POLICY', '/app.js': 'JS-v2' };
  const sw = serviceWorker({
    network: async path => {
      if (!online) throw new TypeError('offline');
      if (path === '/broken') return page('ERROR', 500);
      return page(pages[path] ?? 'ASSET');
    }
  });
  await sw.install();

  assert.equal(await (await sw.request('/policy.html', { mode: 'navigate' })).text(), 'POLICY');
  assert.equal((await sw.request('/broken', { mode: 'navigate' })).status, 500);

  online = false;
  assert.equal(await (await sw.request('/', { mode: 'navigate' })).text(), 'APP', 'the policy page did not replace the app');
  assert.equal(await (await sw.request('/policy.html', { mode: 'navigate' })).text(), 'POLICY', 'each page is cached under its own path');
  assert.equal(await (await sw.request('/broken', { mode: 'navigate' })).text(), 'APP', 'an error page is never cached; the app is the fallback');
});

test('files are fetched fresh first, so a deploy never pairs new HTML with old scripts', async () => {
  let version = 'v1';
  let online = true;
  const sw = serviceWorker({ network: async () => { if (!online) throw new TypeError('offline'); return page(`JS-${version}`); } });
  await sw.install();
  version = 'v2';
  assert.equal(await (await sw.request('/app.js')).text(), 'JS-v2', 'online, the new release is served, not the cached one');
  online = false;
  assert.equal(await (await sw.request('/app.js')).text(), 'JS-v2', 'offline, the last good copy is served');
});

test('private API responses and other origins are never handled or cached', async () => {
  const sw = serviceWorker({ network: async () => page('PRIVATE') });
  await sw.install();
  assert.equal(await sw.request('/api/runs'), null, 'API requests go straight to the network');
  assert.equal(await sw.request('/api/runs', { method: 'POST' }), null);
  assert.equal(await sw.request('/x.js', { origin: 'https://cdn.example' }), null);
  for (const store of sw.stores.values()) {
    assert.ok(![...store.keys()].some(key => key.startsWith('/api/')), 'nothing under /api/ is cached');
  }
});
