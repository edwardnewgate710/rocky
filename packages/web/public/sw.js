/**
 * Gambit service worker — minimal app-shell caching for PWA installability.
 *
 * Caches the core app shell (HTML, CSS, JS) on install and serves from
 * cache on fetch, falling back to network for everything else. This is
 * intentionally simple; a more sophisticated cache-first/network-first
 * strategy can be added in a later increment.
 */
const CACHE_NAME = 'gambit-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/src/style.css',
  '/src/main.ts',
  '/manifest.webmanifest',
];

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
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache same-origin GET responses for future offline use.
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index.html for navigation requests.
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    }),
  );
});
