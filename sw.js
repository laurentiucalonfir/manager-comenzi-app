const CACHE = 'comenzi-wa-v107';
const ASSETS = [
  './manifest.json',
  './css/style.css',
  './js/data.js',
  './js/firebase-init.js',
  './js/sync.js?v=107',
  './js/app.js?v=107'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.action === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
    for (var i = 0; i < clientList.length; i++) { if (clientList[i].url && 'focus' in clientList[i]) return clientList[i].focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('script.google.com')) return;
  if (e.request.url.includes('firebaseio.com')) return;
  if (e.request.url.includes('firebase.googleapis.com')) return;
  if (e.request.url.includes('gstatic.com')) return;

  const isPage = e.request.mode === 'navigate' || e.request.url.endsWith('/') || e.request.url.endsWith('index.html');
  if (isPage) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match(e.request).then(c => c || new Response('Offline', { status: 503 })))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => new Response('', { status: 503 }));
    })
  );
});
