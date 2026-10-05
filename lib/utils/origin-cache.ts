/**
 * A shared cache in front of a slow read-only route.
 *
 * Why: the CDN caches per region. A region that has not seen a route since
 * the last deploy sends the visitor to the function, and the slow reads
 * take 4 to 14 seconds there (measured 2026-10-05). Warming from the
 * function's own region only helps that region. This cache lives beside
 * the function, so a cold region is answered from the last computed
 * payload in one store read.
 *
 * Same contract as the routes' `s-maxage, stale-while-revalidate` header,
 * one level down: fresh for `freshSec`; after that the stored payload is
 * served at once and recomputed behind the response; nothing older than
 * `maxStaleSec` is served.
 *
 * What it never does:
 *   - store anything but a 200 whose body does not report a failure, so an
 *     error is never replayed as data;
 *   - share a payload across callers it was not computed for: a request
 *     carrying a query parameter outside `params` goes straight to the
 *     handler (per-wallet reads, cache-busting, anything unforeseen);
 *   - turn a store failure into a failed read: the handler answers.
 */
import { after, NextResponse } from 'next/server';
import { getRedis } from '@/lib/db/cron-state-redis';
import { logger } from '@/lib/utils/logger';

export interface OriginCacheOptions {
  /** Stable name of the route; part of the key. */
  name: string;
  /** Seconds a stored payload is served without recomputing. */
  freshSec: number;
  /** Query parameters that select the payload. Any other parameter bypasses the cache. */
  params?: readonly string[];
  /** Further rule on the allowed parameters (e.g. which `action` values are pool-wide). Default: all. */
  eligible?: (query: URLSearchParams) => boolean;
  /** Oldest payload ever served, in seconds. Default one day, as the CDN header. */
  maxStaleSec?: number;
}

export interface OriginCacheEntry {
  body: string;
  storedAt: number;
  cacheControl: string | null;
}

export interface OriginCacheStore {
  get(key: string): Promise<OriginCacheEntry | null>;
  set(key: string, entry: OriginCacheEntry, ttlSec: number): Promise<void>;
  /** True when this caller may recompute; false when another one already is. */
  lock(key: string, ttlSec: number): Promise<boolean>;
}

export interface OriginCacheDeps {
  store: OriginCacheStore | null;
  now: () => number;
  /** Run work after the response is sent. */
  defer: (work: () => Promise<void>) => void;
}

const PREFIX = 'oc:';
const REFRESH_LOCK_SEC = 60;
export const ORIGIN_CACHE_HEADER = 'x-origin-cache';

function redisStore(): OriginCacheStore | null {
  const redis = getRedis();
  if (!redis) return null;
  return {
    get: async (key) => (await redis.get<OriginCacheEntry>(PREFIX + key)) ?? null,
    set: async (key, entry, ttlSec) => {
      await redis.set(PREFIX + key, entry, { ex: ttlSec });
    },
    lock: async (key, ttlSec) => (await redis.set(`${PREFIX}lock:${key}`, 1, { nx: true, ex: ttlSec })) === 'OK',
  };
}

/** The key for this request, or null when the request must not be cached. */
export function originCacheKey(opts: Pick<OriginCacheOptions, 'name' | 'params' | 'eligible'>, url: URL): string | null {
  const allowed = new Set(opts.params ?? []);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) return null;
  if (opts.eligible && !opts.eligible(url.searchParams)) return null;
  const query = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  return query ? `${opts.name}?${query}` : opts.name;
}

/** Some routes answer 200 with `success: false` or an `error` field. That is a failed read, not a payload. */
function reportsFailure(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return false;
    const o = parsed as Record<string, unknown>;
    return o.success === false || (typeof o.error === 'string' && o.error.length > 0);
  } catch {
    return true;
  }
}

function fromEntry(entry: OriginCacheEntry, state: 'HIT' | 'STALE', ageSec: number): NextResponse {
  return new NextResponse(entry.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(entry.cacheControl ? { 'Cache-Control': entry.cacheControl } : {}),
      [ORIGIN_CACHE_HEADER]: state,
      'x-origin-cache-age': String(Math.max(0, Math.round(ageSec))),
    },
  });
}

/**
 * Wrap a GET handler. The handler keeps its own rate limit, validation and
 * headers; it simply runs less often.
 */
export function withOriginCache<Req extends Request>(
  opts: OriginCacheOptions,
  handler: (request: Req) => Promise<Response>,
  deps: Partial<OriginCacheDeps> = {},
): (request: Req) => Promise<Response> {
  const maxStaleSec = opts.maxStaleSec ?? 86_400;
  const now = deps.now ?? Date.now;
  const defer = deps.defer ?? ((work) => after(work));

  return async (request) => {
    const store = deps.store !== undefined ? deps.store : redisStore();
    const key = store ? originCacheKey(opts, new URL(request.url)) : null;
    if (!store || !key) return handler(request);

    const save = async (response: Response): Promise<void> => {
      if (response.status !== 200) return;
      try {
        const body = await response.text();
        if (reportsFailure(body)) return;
        await store.set(key, { body, storedAt: now(), cacheControl: response.headers.get('cache-control') }, maxStaleSec);
      } catch (e) {
        logger.warn('[origin-cache] store failed', { key, error: e instanceof Error ? e.message : String(e) });
      }
    };

    let entry: OriginCacheEntry | null = null;
    try {
      entry = await store.get(key);
    } catch (e) {
      logger.warn('[origin-cache] read failed, computing', { key, error: e instanceof Error ? e.message : String(e) });
    }

    if (entry && typeof entry.body === 'string') {
      const ageSec = (now() - entry.storedAt) / 1000;
      if (ageSec <= opts.freshSec) return fromEntry(entry, 'HIT', ageSec);
      if (ageSec <= maxStaleSec) {
        defer(async () => {
          try {
            if (await store.lock(key, REFRESH_LOCK_SEC)) await save(await handler(request));
          } catch (e) {
            logger.warn('[origin-cache] refresh failed, stored payload kept', { key, error: e instanceof Error ? e.message : String(e) });
          }
        });
        return fromEntry(entry, 'STALE', ageSec);
      }
    }

    const response = await handler(request);
    if (response.status === 200) {
      const copy = response.clone();
      defer(() => save(copy));
      response.headers.set(ORIGIN_CACHE_HEADER, 'MISS');
    }
    return response;
  };
}
