/**
 * service-worker.js — PWA: cache dell'app shell, rete per API/servizi OGC, cache limitata delle tile di base.
 * Aggiornare CACHE_VERSION a ogni rilascio per invalidare le risorse statiche.
 */
const CACHE_VERSION = 'catasto-map-v1.0.6';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;
const TILE_MAX_ENTRIES = 400;

const SHELL = [
  './', './index.html', './manifest.json',
  './css/style.css', './vendor/ol/ol.css', './vendor/ol/ol.js',
  './js/config.js', './js/app.js', './js/map.js', './js/catasto.js', './js/catasto-core.js', './js/geocoder.js', './js/ui.js', './js/api.js',
  './data/comuni.json', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' salta la cache HTTP del browser (GitHub Pages invia max-age=600):
  // altrimenti una nuova versione del service worker potrebbe precaricare file vecchi.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'reload' }).then((r) => { if (r.ok) return c.put(u, r); throw new Error('precache ' + u + ' ' + r.status); }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

const isTile = (url) => /tile\.openstreetmap\.org|tile\.openstreetmap\.fr|arcgisonline\.com\/.*\/tile\//.test(url.href);
const isDynamic = (url) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/proxy/') || /nominatim|photon|geoserver|regione\.fvg/.test(url.hostname) || /REQUEST=/i.test(url.search);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isDynamic(url)) return; // sempre rete: dati vivi, mai cache offline

  if (isTile(url)) {
    event.respondWith(staleWhileRevalidate(req, TILE_CACHE, TILE_MAX_ENTRIES));
    return;
  }

  if (url.origin === location.origin) {
    // app shell: cache-first con aggiornamento in background; index/config: network-first
    if (/\/(index\.html)?$|config\.js$/.test(url.pathname)) { event.respondWith(networkFirst(req, SHELL_CACHE)); return; }
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req)) || (await cache.match('./index.html'));
  }
}

async function staleWhileRevalidate(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req).then(async (res) => {
    if (res.ok) { await cache.put(req, res.clone()); trimCache(cache, maxEntries); }
    return res;
  }).catch(() => null);
  return hit || (await network) || new Response('', { status: 504 });
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}
