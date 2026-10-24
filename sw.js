// Service worker: guarda la app para que abra sin conexión.
const VERSION = 'asistente-v2';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'app.js', 'planner.js', 'parser.js', 'time.js', 'defaults.js', 'store.js',
  'learning.js', 'stats.js', 'ics.js', 'sound.js', 'voice.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Red primero (para recibir actualizaciones), caché si no hay conexión.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
