// ZKward service worker.
// Purpose: satisfy Chrome's PWA install-eligibility rules (registered SW with a
// fetch handler) and provide a minimal offline fallback.
// Strategy: network-first for HTML documents; passthrough for everything else.
// We keep the cache footprint small on purpose — a heavy runtime cache would
// mask fresh deploys, and users of a live financial dashboard should NEVER see
// stale numbers. Only the app shell is cached.

const CACHE_NAME = 'zkward-shell-v1';
const APP_SHELL = ['/', '/logo-official.svg', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GETs. Never touch API calls, wallet RPCs, POST bodies.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/_next/data/')) return;

  // Network-first for HTML navigations. Fall back to cached shell only when
  // fully offline — never cache successful HTML responses to avoid stale UI.
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(req).then((r) => r || caches.match('/'))
      )
    );
    return;
  }

  // Static assets (_next/static, images, fonts): cache-then-network, so repeat
  // visits are fast without risking stale JS bundles (each build gets a new
  // hash so old bundles are naturally unreachable).
  if (
    url.pathname.startsWith('/_next/static/') ||
    /\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy).catch(() => {}));
          }
          return res;
        });
      })
    );
  }
});
