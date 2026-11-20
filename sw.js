// 앱 화면 파일을 저장해 두어 인터넷이 없어도 열리게 합니다. (데이터 동기화는 Firebase가 따로 처리)
// 앱 파일을 고쳐서 다시 올릴 때는 아래 버전 숫자를 올려 주세요.
const CACHE = 'todo-app-v5';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'app.js', 'dates.js', 'recur.js', 'gcal.js', 'store-local.js', 'store-firebase.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isFirebaseSdk = url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  if (e.request.method !== 'GET' || (url.origin !== self.location.origin && !isFirebaseSdk)) return;
  if (isFirebaseSdk) { // 버전이 고정된 SDK 파일은 저장본 우선
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const c = res.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return res; })));
    return;
  }
  // 항상 서버에 새 버전이 있는지 확인(변경 없으면 저장본 사용) → 수정이 바로 반영됨
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    const c = res.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
