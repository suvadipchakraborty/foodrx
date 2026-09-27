// Bump this on every deploy that changes cached files — changing this
// string is also what makes browsers notice sw.js itself has changed,
// which is what triggers them to install the new worker at all.
const CACHE_NAME = "foodrx-v2";

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/css/styles.css",
  "/js/app.js",
  "/manifest.webmanifest",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never cache the API — always go to the network.
  if (request.url.includes("/api/")) return;
  if (request.method !== "GET") return;

  // Network-first, falling back to cache only when offline. This is the
  // opposite of cache-first: it means a fresh deploy is picked up on the
  // very next load instead of being masked indefinitely by old cached
  // files, while still giving an offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request))
  );
});
