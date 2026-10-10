/*
 * 離線快取（Service Worker）：讓從手機主畫面打開時不必每次重新下載。
 *
 * - 網頁本身（index.html）：先連網拿最新版，3 秒內沒回應或離線就用存好的。
 * - 程式與樣式（assets/ 檔名帶雜湊，內容不會變）：存好就直接用。
 * - 資料（data/*.json、圖示等）：先用存好的立刻顯示，同時在背景更新，下次打開就是新的。
 * - 開通碼清單、同步設定：先連網，失敗才用存好的（新增開通碼要馬上生效）。
 * - 其他網站（證交所、富果、Firebase、字型）：不經過這裡。
 */
const VERSION = 'v1';
const SHELL = `lplc-shell-${VERSION}`;
const ASSETS = `lplc-assets-${VERSION}`;
const DATA = `lplc-data-${VERSION}`;
const KEEP = [SHELL, ASSETS, DATA];
const LIMITS = { [ASSETS]: 60, [DATA]: 400 };
const NETWORK_FIRST = /\/(sim-codes|sync-config)\.json$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(['./', 'manifest.webmanifest', 'icon.svg']))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('lplc-') && !KEEP.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** 超過上限時刪掉最早存的。 */
async function trim(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const extra = keys.length - LIMITS[name];
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function put(name, request, response) {
  if (!response || !response.ok || response.type === 'opaque') return;
  const cache = await caches.open(name);
  await cache.put(request, response);
  if (LIMITS[name]) await trim(name);
}

/** 存檔以網址為準，忽略查詢字串（避免 ?t= 之類的參數讓同一份資料存很多份）。 */
const keyOf = (request) => {
  const url = new URL(request.url);
  url.search = '';
  return url.toString();
};

async function networkFirst(request, cacheName, timeoutMs) {
  const key = keyOf(request);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    await put(cacheName, key, response.clone());
    return response;
  } catch (e) {
    const cached = await caches.match(key);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request, cacheName) {
  const key = keyOf(request);
  const cached = await caches.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  await put(cacheName, key, response.clone());
  return response;
}

async function staleWhileRevalidate(event, cacheName) {
  const key = keyOf(event.request);
  const cached = await caches.match(key);
  const update = fetch(event.request)
    .then(async (response) => {
      await put(cacheName, key, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  const response = await update;
  return response ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL, 3000));
  } else if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(request, ASSETS));
  } else if (NETWORK_FIRST.test(url.pathname)) {
    event.respondWith(networkFirst(request, DATA, 4000));
  } else {
    event.respondWith(staleWhileRevalidate(event, DATA));
  }
});
