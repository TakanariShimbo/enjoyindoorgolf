// オレオレ E.I.G — Service Worker
// アプリシェル(静的ファイル)のみキャッシュ。予約データ/ログイン/QR等の
// 動的APIは別オリジン(Cloudflare Worker)なので一切キャッシュしない。
const CACHE = "eig-v3";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "favicon.svg",
  "favicon-16.png",
  "favicon-32.png",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "icon-512-maskable.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 同一オリジン(GitHub Pages)のGETのみ扱う。別オリジンのAPIは素通し。
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // HTMLナビゲーションはネットワーク優先(新デプロイを反映)、オフライン時はキャッシュ。
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => {
        caches.open(CACHE).then((c) => c.put("index.html", res.clone()));
        return res;
      }).catch(() => caches.match("index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // その他の静的アセットはキャッシュ優先 + 裏で更新。
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
