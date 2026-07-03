/* PayQR service worker — makes the app installable (PWA) and serves a cached
   shell when offline. Network-first so live data (rates, on-chain reads) stays
   fresh; falls back to cache only when the network is unavailable. */
const CACHE = "payqr-v6";
const SHELL = ["/", "/login", "/dashboard", "/manifest.json", "/icon-192.png", "/icon-512.png", "/splash.png", "/logo-mark.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Only handle GET navigations/assets; let everything else (POST, RPC) pass through.
  if (req.method !== "GET") return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        // Cache successful same-origin responses for offline fallback.
        if (res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
  );
});
