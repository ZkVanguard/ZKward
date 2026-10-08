/**
 * Response cache lifetimes for read routes. `s-maxage` is how long the CDN
 * treats a response as fresh; `stale-while-revalidate` is how long after that
 * it still answers at once while it refetches behind the visitor.
 *
 * A long stale window is what keeps a quiet site fast: with a window of only
 * twice the fresh time, the entry expired between visits and the next visitor
 * waited for the full computation (measured 3-14 s on 2026-10-05).
 */
export const CACHE = {
  /** Pool-wide and platform-wide reads: anyone may see them, a minute-old answer is fine. */
  poolWide: 'public, s-maxage=30, stale-while-revalidate=86400',
  /** Reads keyed by a wallet address: still public chain data, kept short. */
  perWallet: 'public, s-maxage=15, stale-while-revalidate=45',
  /** Never cached: errors and anything that must be read fresh. */
  none: 'no-store',
} as const;

/**
 * Sets `value` on a successful response and `no-store` on anything else, so a
 * failure is never served from a cache as if it were data.
 */
export function cacheFor<T extends Response>(response: T, value: string): T {
  response.headers.set('Cache-Control', response.status === 200 ? value : CACHE.none);
  return response;
}
