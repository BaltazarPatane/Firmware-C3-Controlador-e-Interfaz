'use client'

import { useEffect } from 'react'

/**
 * Registers the app-shell service worker (public/sw.js) so the UI is available
 * offline after the first online visit. Registration failures are non-fatal:
 * the app still works normally online. Renders nothing.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Ignore: service worker is a progressive enhancement.
      })
    }

    if (document.readyState === 'complete') {
      register()
      return
    }
    window.addEventListener('load', register, { once: true })
    return () => window.removeEventListener('load', register)
  }, [])

  return null
}
