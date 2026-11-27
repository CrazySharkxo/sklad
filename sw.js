// Service worker: програма відкривається без мережі (дані — лише з інтернетом).
// Стратегія «спершу мережа»: оновлення застосунку доходять одразу, кеш — запасний варіант.
// Версія — одна на всю програму, у version.js (її ж перевіряє смужка «Є оновлення»).
importScripts('version.js');
const CACHE = `sklad-${self.APP_VERSION}`;
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'version.js',
  'js/app.js', 'js/api.js', 'js/core.js', 'js/util.js', 'js/scanner.js', 'js/config.js',
  'js/print.js', 'js/outbox.js', 'js/backup.js', 'js/nav.js', 'js/sortable.js',
  'js/views/stock.js', 'js/views/ops.js', 'js/views/kits.js', 'js/views/inventory.js', 'js/views/more.js', 'js/views/orders.js', 'js/views/users.js',
  'js/views/settings.js', 'js/views/shortage.js',
  'vendor/supabase.js', 'vendor/xlsx.full.min.js', 'vendor/qrcode.js', 'vendor/zxing.min.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — повз кеш браузера, щоб у запас не лягла стара копія
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
  // 'no-cache' — щоразу питаємо сервер (якщо файл не змінився, він відповідає коротким 304),
  // інакше браузер ще до 10 хвилин віддавав би стару версію зі свого кешу.
  // Запит переходу на сторінку не можна склонувати з параметрами — будуємо новий.
  const req = e.request.mode === 'navigate'
    ? new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(e.request, { cache: 'no-cache' });
  const isCheck = url.searchParams.has('check');
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && !isCheck) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
