/* Service Worker: macht die App offline-fähig.
   Beim ersten Start (mit Internet) werden App und Texterkennung einmalig gespeichert. */
const SHELL_CACHE = 'kassenbon-shell-v5';      // bei App-Änderungen hochzählen
const VENDOR_CACHE = 'kassenbon-vendor-tess510'; // nur bei neuer Tesseract-Version ändern

const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'parser.js', 'kassenbuch.js', 'xlsx.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
];

const CDN = 'https://cdn.jsdelivr.net/npm/';
const VENDOR = {
  'vendor/tesseract.min.js': CDN + 'tesseract.js@5.1.0/dist/tesseract.min.js',
  'vendor/worker.min.js': CDN + 'tesseract.js@5.1.0/dist/worker.min.js',
  'vendor/core/tesseract-core-simd-lstm.wasm.js': CDN + 'tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js',
  'vendor/core/tesseract-core-lstm.wasm.js': CDN + 'tesseract.js-core@5.1.0/tesseract-core-lstm.wasm.js',
  'vendor/lang/deu.traineddata.gz': CDN + '@tesseract.js-data/deu@1.0.0/4.0.0_best_int/deu.traineddata.gz',
  'vendor/jsQR.js': CDN + 'jsqr@1.4.0/dist/jsQR.js'
};

const scope = () => self.registration.scope;

function cdnUrlFor(path) {
  if (VENDOR[path]) return VENDOR[path];
  const m = path.match(/^vendor\/core\/(tesseract-core[\w.-]*\.js)$/);
  if (m) return CDN + 'tesseract.js-core@5.1.0/' + m[1];
  return null;
}

// Antwort neu verpacken, damit sie als "eigene" Datei gilt (nötig für Web Worker)
async function fetchVendor(path) {
  const url = cdnUrlFor(path);
  if (!url) throw new Error('Unbekannte Datei: ' + path);
  const res = await fetch(url, { mode: 'cors', cache: 'reload' });
  if (!res.ok) throw new Error(res.status + ' bei ' + url);
  const type = path.endsWith('.gz') ? 'application/octet-stream' : 'text/javascript';
  return new Response(await res.blob(), { status: 200, headers: { 'Content-Type': type } });
}

async function broadcast(msg) {
  const all = await self.clients.matchAll({ includeUncontrolled: true });
  all.forEach((c) => c.postMessage(msg));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));

    const vendor = await caches.open(VENDOR_CACHE);
    const paths = Object.keys(VENDOR);
    let done = 0;
    for (const p of paths) {
      const key = new URL(p, scope()).href;
      if (!(await vendor.match(key))) await vendor.put(key, await fetchVendor(p));
      done++;
      broadcast({ type: 'setup-progress', done, total: paths.length });
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, VENDOR_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.href.slice(scope().length).split('?')[0];

  if (path.startsWith('vendor/')) {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const key = new URL(path, scope()).href;
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await fetchVendor(path);
      await cache.put(key, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') return cache.match('index.html');
      throw e;
    }
  })());
});
