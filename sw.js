// Keeps the app and the OCR engine on the phone after the first visit,
// so it still opens without internet.
const CACHE = "visulex-v7";
const SHELL = ["./", "index.html", "style.css", "app.js", "paddle.js", "sample.jpg", "icon-192.png", "manifest.webmanifest"];  // models are cached the first time the app loads them

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin;
  const engine = /cdn\.jsdelivr\.net/.test(url.host);
  if (!sameOrigin && !engine) return;
  // Own files: network first so updates show up (models cache first, they
  // are large and do not change); engine files from the CDN: cache first.
  const model = sameOrigin && url.pathname.includes("/models/");
  if (sameOrigin && !model) {
    e.respondWith(
      fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
        const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
      }))
    );
  }
});
