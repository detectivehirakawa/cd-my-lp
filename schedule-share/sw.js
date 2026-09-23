// 最低限のオフラインシェル用サービスワーカー。GASへのAPI通信はキャッシュしない。
// ネットワーク優先(常に最新を取りに行き、オフライン時だけキャッシュにフォールバック)。
// キャッシュ優先だと index.html/JS の更新が反映されない事故が起きるため、この方式にしている。
const CACHE = 'schedshare-v3';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // GAS等の外部APIはネットワークのみ
  e.respondWith(
    fetch(e.request).then((res) => {
      caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
