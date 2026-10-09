// Offline support for the app shell only. API responses (private data) are
// never cached. Files are fetched fresh first so a deploy never pairs new
// HTML with last release's scripts; the cache is the offline fallback.
const CACHE = 'kindgleam-ui-64';
const STATIC = ['/', '/index.html', '/app.css', '/app.js', '/app-settings.js', '/app-actions.js', '/app-attachments.js', '/attachment-selection.js', '/app-account.js', '/app-settings-window.js', '/governance-controls.js', '/execution-context.js', '/ui-core.js', '/thread-view.js', '/workspace-sources.js', '/app-projects.js', '/terminal.js', '/artifact-preview.js', '/static-html-preview.js', '/table-preview-model.js', '/adaptive-workspace.js', '/work-progress-panels.js', '/markdown.js', '/math-text.js', '/manifest.webmanifest', '/kindgleam.svg', '/kindgleam-192.png', '/kindgleam.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE && /^(kindgleam|general-ai|professor)-ui-/.test(key)).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const navigate = request.mode === 'navigate';
  event.respondWith(
    fetch(request)
      .then(response => {
        // Only a good response replaces what is cached, and each page is
        // cached under its own path: an error page or /policy.html must never
        // become the offline app.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(navigate ? url.pathname : request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(navigate ? url.pathname : request);
        if (cached) return cached;
        if (navigate) return (await caches.match('/index.html')) ?? Response.error();
        return Response.error();
      })
  );
});
