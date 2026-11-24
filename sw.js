// Sky Cam service worker: keeps the app shell offline and lets new deploys show up.
// Bump VERSION whenever the precache list changes; old caches are deleted on activate.
const VERSION = 'v2';
const SHELL = `skycam-shell-${VERSION}`;
const MEDIA = `skycam-media-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'app.js',
  'pwa.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'assets/cosmos-thumb.jpg',
  'assets/figure-vishwaroop-gargantua-thumb.jpg',
  'assets/figure-vishwaroop-thumb.jpg',
  'assets/sky-anantashayana-thumb.jpg',
  'assets/sky-anime-sunset-thumb.jpg',
  'assets/sky-aurora-thumb.jpg',
  'assets/sky-blackhole-thumb.jpg',
  'assets/sky-cosmic-ocean-thumb.jpg',
  'assets/sky-divine-foot-thumb.jpg',
  'assets/sky-gargantua-thumb.jpg',
  'assets/sky-milkyway-thumb.jpg',
  'assets/sky-nebula-thumb.jpg',
  'assets/sky-pastel-thumb.jpg',
  'assets/sky-ringed-planet-thumb.jpg',
  'assets/sky-starry-night-thumb.jpg',
  'assets/sky-storm-thumb.jpg',
  'assets/sky-two-moons-thumb.jpg',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('skycam-') && k !== SHELL && k !== MEDIA)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first: HTML, scripts and the manifest, so a new deploy is picked up on the next open.
async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) cache.put(fallbackUrl || request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(fallbackUrl || request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

// Cache first: images (sky paintings, thumbnails, icons) are fetched once, then served offline.
async function cacheFirst(request) {
  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) (await caches.open(MEDIA)).put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // e.g. ?art= / ?photo= links elsewhere
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, 'index.html'));
  } else if (req.destination === 'image' || /\.(webp|jpe?g|png)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});
