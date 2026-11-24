// Service worker: програма відкривається без мережі (дані — лише з інтернетом).
// Стратегія «спершу мережа»: оновлення застосунку доходять одразу, кеш — запасний варіант.
const CACHE = 'sklad-v5';
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/api.js', 'js/core.js', 'js/util.js', 'js/scanner.js', 'js/config.js',
  'js/views/stock.js', 'js/views/ops.js', 'js/views/kits.js', 'js/views/inventory.js', 'js/views/more.js', 'js/views/orders.js',
  'vendor/supabase.js', 'vendor/xlsx.full.min.js', 'vendor/qrcode.js', 'vendor/zxing.min.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // запити до бази й фото не кешуємо
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
