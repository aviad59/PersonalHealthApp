// Service worker for the Health PWA.
//
// Strategy:
// - Pre-cache the next/static immutable assets and the meta files on install
//   so the app shell boots fast.
// - For HTML navigations: network-first, fall back to the cached shell when
//   offline so the user always sees SOMETHING.
// - For Next.js build assets (/_next/static/...): cache-first, immutable.
// - For all API requests (/api/...): network-only, no caching. Personalised
//   data should never be served from a stale cache.
// - For meal photo bytes (/api/meals/:id/photo): network-first with cache
//   fallback so old meal thumbnails still appear offline.
//
// We do NOT yet implement an offline meal-save queue here — that's a deliberate
// next step (IndexedDB + Background Sync). This SW is the minimum to make the
// app installable and feel native on Android.

const VERSION = "health-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const PHOTO_CACHE = `${VERSION}-photos`;

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Tolerate individual misses so install doesn't fail wholesale.
      Promise.all(
        PRECACHE_URLS.map((u) =>
          cache.add(new Request(u, { cache: "reload" })).catch(() => null),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache POSTs/PATCHes etc

  const url = new URL(req.url);

  // Cross-origin? Let the browser handle it normally.
  if (url.origin !== self.location.origin) return;

  // Meal photos — survive offline so the meal list isn't empty squares.
  if (url.pathname.startsWith("/api/meals/") && url.pathname.endsWith("/photo")) {
    event.respondWith(networkFirstWithCache(req, PHOTO_CACHE));
    return;
  }

  // Other API routes — always live, never cached (personalised data).
  if (url.pathname.startsWith("/api/")) return;

  // Next build assets — content-hashed, safe to cache forever.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // HTML navigations — network first, shell fallback when offline.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(networkFirstHtml(req));
    return;
  }

  // Same-origin static (icons, manifest, etc.) — cache first.
  event.respondWith(cacheFirst(req, SHELL_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return hit || Response.error();
  }
}

async function networkFirstWithCache(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    return hit || Response.error();
  }
}

async function networkFirstHtml(req) {
  try {
    const res = await fetch(req);
    // Cache the shell every time the user lands on home so the offline
    // fallback stays current with whichever build is live.
    if (res.ok && new URL(req.url).pathname === "/") {
      const cache = await caches.open(SHELL_CACHE);
      cache.put("/", res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match(req)) ||
      (await cache.match("/")) ||
      new Response("Offline — please reconnect to continue.", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }
}
