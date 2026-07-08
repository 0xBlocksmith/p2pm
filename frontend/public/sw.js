/* PayQR service worker — makes the app installable (PWA), serves a cached
   shell when offline, and supports controlled OTA updates.

   OTA model: a NEW service worker does NOT auto-activate. It installs, then
   sits in the "waiting" state until the app tells it to take over (the app
   detects the waiting worker, shows an "update ready" prompt, and posts
   SKIP_WAITING when the merchant taps Refresh). This means a code push can't
   swap out the running app mid-sale — the merchant chooses when to apply it.
   Bump CACHE on every release so the activate step purges the old shell. */
const CACHE = "payqr-v7";
const SHELL = ["/", "/login", "/dashboard", "/manifest.json", "/icon-192.png", "/icon-512.png", "/splash.png", "/logo-mark.png"];

self.addEventListener("install", (e) => {
  // Precache the shell. NOTE: no skipWaiting() here — the new worker waits so
  // the app can surface an update prompt instead of activating silently.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The app posts { type: "SKIP_WAITING" } when the merchant accepts an update —
// the waiting worker activates immediately, then the app's controllerchange
// handler reloads the page onto the new version.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
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
