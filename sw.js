const CACHE = 'comenzi-wa-v142';
const ASSETS = [
  './manifest.json',
  './css/style.css',
  './js/data.js',
  './js/firebase-init.js',
  './js/sync.js?v=142',
  './js/app.js?v=142'
];

importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyA1gDoHZVARzLSR7EjOdMj2BVXkXD_LkS0',
  authDomain: 'comenzi-corina-caffe.firebaseapp.com',
  databaseURL: 'https://comenzi-corina-caffe-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'comenzi-corina-caffe',
  storageBucket: 'comenzi-corina-caffe.firebasestorage.app',
  messagingSenderId: '820994532115',
  appId: '1:820994532115:web:f5a13771b57ec0a27530e6'
});

const fbMessaging = firebase.messaging();

fbMessaging.onBackgroundMessage(function(payload) {
  var d = payload.data || {};
  incrementBadge();
  var title = d.title || 'Comanda noua';
  var opts = { body: d.body || '', icon: './icon-192.png', badge: './icon-192.png', data: { url: d.clickUrl || '/' } };
  self.registration.showNotification(title, opts);
  try {
    clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function(clientList) {
      clientList.forEach(function(c) {
        c.postMessage({ type: 'newOrder', title: title, body: d.body });
      });
    });
  } catch (e) {}
});

var _badgeCount = 0;
function incrementBadge() {
  _badgeCount++;
  try { navigator.setAppBadge(_badgeCount); } catch (e) {}
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(function() {
      _badgeCount = 0;
      try { navigator.setAppBadge(0); } catch (e) {}
      return self.skipWaiting();
    })
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
