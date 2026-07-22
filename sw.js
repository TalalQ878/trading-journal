/* Service worker — Talal's Trading Journal PWA
   Shell: stale-while-revalidate (instant open, silent background update).
   Apps Script API: never intercepted (data freshness + auth handled by the app,
   which keeps its own localStorage fallback for offline viewing).
   Google Fonts: cached after first use so typography works offline. */
"use strict";
const VERSION = "tj-v5f"; /* v5f: quick-sell prefill + IBKR commission auto-include */
const SHELL = [
  "./",
  "./index.html",
  "./pwa.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Apps Script data/API calls: straight to network (app handles offline itself)
  if (/script\.google(usercontent)?\.com$/.test(url.hostname) || /googleusercontent\.com$/.test(url.hostname) || /docs\.google\.com$/.test(url.hostname)) return;

  // Google Fonts: cache-first after first use
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
    return;
  }

  // Same-origin shell: stale-while-revalidate, offline navigation falls back to index.html
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        }).catch(() => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined));
        return hit || net;
      })
    );
  }
});
