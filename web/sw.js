/* 宸阳书院报销系统 · 网页版 Service Worker
 * 策略：同源 GET 走 network-first（部署后自动更新），离线回退缓存。
 * /api/ 共享数据接口完全不拦截（必须实时、绝不缓存）；云同步的跨域 POST 也不拦截；
 * file:// 协议下不会注册本脚本。
 */
var CACHE = 'cy-web-v5';
var ASSETS = [
  './', './index.html', './app.js', './zip.js',
  './manifest.webmanifest', './icon.svg',
  './多端使用方案.html'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
      .catch(function () { /* 个别资源缺失不阻断安装 */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var u;
  try { u = new URL(e.request.url); } catch (err) { return; }
  if (u.origin !== self.location.origin) return;
  if (u.pathname.indexOf('/api/') === 0) return;   // 共享数据接口实时走网络，绝不缓存
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { return c.put(e.request, copy); }).catch(function () { });
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (r) { return r || caches.match('./index.html'); });
    })
  );
});
