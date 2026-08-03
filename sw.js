// Service worker: cache-first for the app shell, so Pulsegrid is fully playable offline
// the moment it's been opened once. There is no network content — everything is
// generated at runtime — so "offline" is the normal case, not a degraded one.
//
// Bump CACHE when shipping: the old cache is deleted on activate.

const CACHE = 'pulsegrid-v1';

// On localhost the cache-first strategy below happily serves the module you edited
// thirty seconds ago, and you debug a file the page isn't running. Development gets
// network-first (cache only as an offline fallback); production keeps cache-first,
// which is the whole point of an offline game.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/core/math.js',
  './js/core/rng.js',
  './js/core/pool.js',
  './js/core/audio.js',
  './js/core/save.js',
  './js/core/input.js',
  './js/fx/particles.js',
  './js/fx/juice.js',
  './js/fx/render.js',
  './js/fx/face.js',
  './js/game/palette.js',
  './js/game/defs.js',
  './js/game/daily.js',
  './js/game/run.js',
  './js/game/characters.js',
  './js/game/voice.js',
  './js/ui/screens.js',
  './icons/favicon-64.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is atomic — one 404 rejects the whole install, which is what we want:
      // a half-cached shell that boots into a module error is worse than no cache.
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (DEV) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Navigations: serve the shell so deep links and the manifest shortcuts work offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req).catch(() => caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // Stale-while-revalidate: play instantly from cache, quietly pick up updates.
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
