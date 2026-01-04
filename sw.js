const CACHE_NAME = 'battleship-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './assets/hit.svg',
  './assets/miss.svg',
  './assets/ship1.svg',
  './assets/ship2.svg',
  './assets/ship3.svg',
  './assets/ship4.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
