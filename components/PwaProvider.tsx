'use client';

import { useEffect } from 'react';

/**
 * Registers the ZKward service worker exactly once per page load.
 *
 * Why a dedicated provider component: registration MUST run client-side (there's
 * no navigator in SSR) and it's called from the root layout, which is a Server
 * Component. Wrapping in a small 'use client' component keeps the layout server-
 * side while still getting the SW mounted on hydration.
 *
 * Fails silently if the browser doesn't support service workers — nothing else
 * on the site depends on the SW being up.
 */
export function PwaProvider() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Wait until 'load' so we don't compete with critical bundles for bandwidth
    // on first paint.
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch(() => {
          /* PWA is progressive — never surface the failure to the user */
        });
    };
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);
  return null;
}
