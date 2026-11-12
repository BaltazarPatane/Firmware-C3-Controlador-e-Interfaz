// Lightweight custom service worker for the static-export PWA.
//
// Goal: the APP SHELL (HTML, JS, CSS, icons served from our own origin) must be
// usable offline after the first online visit, so the UI still opens without a
// network connection.
//
// This SW only ever caches same-origin app-shell assets. Printer communication
// uses Web Serial or WebSocket straight from the page context — it never goes through the
// service worker or the cache.

const VERSION = 'c3-ui-4.1.3-five-devices'
const CACHE = `impresora-cartesiana-${VERSION}`

// Minimal core precache. Hashed Next.js assets are cached at runtime on first
// load (stale-while-revalidate) since their names are not known at build time.
const CORE_ASSETS = [
  './',
  './manifest.webmanifest',
  './icon-192.png',
  './icon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Only ever handle our OWN origin. Anything cross-origin is ignored here and
  // hits the network directly, never cached.
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return

  // Navigations: network-first so updates are picked up online, with an
  // offline fallback to the cached app shell so the UI still renders.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
          return response
        })
        .catch(async () => {
          const cache = await caches.open(CACHE)
          return (
            (await cache.match(request)) ||
            (await cache.match('./')) ||
            Response.error()
          )
        }),
    )
    return
  }

  // Same-origin static assets: stale-while-revalidate. Serve from cache
  // instantly when present, and refresh the cache in the background online.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request)
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone())
          }
          return response
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})
