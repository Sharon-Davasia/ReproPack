/**
 * ReproPack mobile companion — offline shell.
 * Caches the page and the report engine so a report can be written with no
 * network at all. Bump CACHE when the shell changes.
 */
var CACHE = "repropack-share-v1";
var ASSETS = [
  "./",
  "./index.html",
  "./share.js",
  "./manifest.webmanifest",
  "../lib/report.js",
  "../icons/icon128.png",
  "../icons/icon48.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS).catch(function () { /* partial cache is fine */ });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); }).catch(function () {});
        return resp;
      }).catch(function () {
        // Offline and uncached: fall back to the shell so the form still works.
        return caches.match("./index.html");
      });
    })
  );
});
