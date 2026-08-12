const CACHE = "workbuddy-classroom-v2.0";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./favicon.svg", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png"/*__PRECACHE_ASSETS__*/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

async function cacheSuccessfulSameOrigin(request, response) {
  if (!response.ok || new URL(request.url).origin !== location.origin) return response;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch {
    // A quota or storage failure must not replace a valid network response.
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  const isSupabaseTraffic = requestUrl.hostname.endsWith(".supabase.co")
    || ["/auth/v1/", "/rest/v1/", "/realtime/v1/", "/storage/v1/", "/functions/v1/"].some((path) => requestUrl.pathname.includes(path));
  if (isSupabaseTraffic) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => cacheSuccessfulSameOrigin(event.request, response)).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => cacheSuccessfulSameOrigin(event.request, response)).catch(() => Response.error())));
});
