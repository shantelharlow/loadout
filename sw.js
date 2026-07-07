const CACHE_NAME = "loadout-v15";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  // Skip waiting forces the new service worker to activate immediately
  // instead of waiting for you to close and reopen the app.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  // Claim all open tabs immediately so the new version takes effect
  // without needing a full app restart.
  self.clients.claim();
});

// Network-first strategy: always try to fetch fresh files from the
// server first. If the network is unavailable (offline), fall back
// to the cache. This means every time you push to GitHub Pages,
// the phone picks up the new version on next open — no reinstall needed.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Save a fresh copy in the cache while we're at it
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => {
        // Network failed — serve from cache (offline mode)
        return caches.match(event.request);
      })
  );
});

// Listen for a message from the app telling us to skip the wait
// and activate immediately (used when we detect a new version).
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
