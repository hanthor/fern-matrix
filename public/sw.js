/* The build script injects only public app assets. Matrix requests and credentials are never cached here. */
const BASE = '__FERN_BASE_PATH__'
const VERSION = '__FERN_BUILD__'
const APP_ASSETS = __FERN_ASSETS__
const CACHE = `fern-shell-${VERSION}`
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_ASSETS)))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fern-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // Only this app's assets and shell; no Matrix /api, media, or remote homeserver responses.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(`${BASE}index.html`)))
    return
  }
  if (!url.pathname.startsWith(`${BASE}assets/`) && !APP_ASSETS.includes(url.pathname)) return
  event.respondWith(caches.open(CACHE).then(async cache => {
    const saved = await cache.match(request)
    if (saved) return saved
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  }))
})
