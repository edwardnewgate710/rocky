/**
 * Gambit service worker — app-shell caching for PWA installability.
 *
 * Strategy:
 * - Precache: a build-injected asset list (APP_SHELL) is cached on install.
 *   In production, the build step replaces the dev placeholder with actual
 *   hashed asset URLs from dist/.
 * - Navigations: network-first (always try the network, fall back to cached
 *   index.html for offline support).
 * - Static assets (hashed): cache-first (immutable, safe to serve from cache).
 * - API (/v1/) and WebSocket: NEVER cached — always go to network.
 *
 * The cache is versioned by CACHE_VERSION so deploys invalidate old caches.
 */

// Build-time injection point: the build replaces this array with the actual
// list of production asset URLs (hashed JS/CSS from dist/assets/).
// In dev, only the manifest and index.html are precached.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
];

const CACHE_VERSION = 'gambit-v2';
const CACHE_NAME = CACHE_VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // NEVER cache API responses or WebSocket upgrades.
  if (url.pathname.startsWith('/v1/') || url.protocol === 'ws:' || url.protocol === 'wss:') {
    return; // Let the browser handle it directly.
  }

  // Navigations: network-first, fall back to cached index.html offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((response) => {
          // Cache the latest index.html for offline use.
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Same-origin static assets: cache-first (hashed assets are immutable).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return response;
        }).catch(() => new Response('Offline', { status: 503, statusText: 'Offline' }));
      }),
    );
  }
});
