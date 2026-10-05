/**
 * The shared cache in front of slow read routes: it answers from the stored
 * payload, recomputes behind the response when stale, and never stores an
 * error, shares a per-caller payload, or turns its own failure into a
 * failed read.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('next/server', () => {
  class NextResponse extends Response {}
  return { NextResponse, after: jest.fn() };
});
jest.mock('@/lib/db/cron-state-redis', () => ({ getRedis: jest.fn(() => null) }));

import { ORIGIN_CACHE_HEADER, originCacheKey, withOriginCache, type OriginCacheEntry, type OriginCacheStore } from '@/lib/utils/origin-cache';

const T0 = 1_790_000_000_000;
const req = (path: string) => new Request(`https://www.zkward.com${path}`);
const ok = (payload: unknown, cacheControl = 'public, s-maxage=30') => new Response(JSON.stringify(payload), { status: 200, headers: { 'Cache-Control': cacheControl } });

function harness(initial: Record<string, OriginCacheEntry> = {}) {
  const data = new Map(Object.entries(initial));
  const locks = new Set<string>();
  const deferred: Array<() => Promise<void>> = [];
  let clock = T0;
  const store: OriginCacheStore = {
    get: jest.fn(async (k: string) => data.get(k) ?? null),
    set: jest.fn(async (k: string, e: OriginCacheEntry) => { data.set(k, e); }),
    lock: jest.fn(async (k: string) => (locks.has(k) ? false : (locks.add(k), true))),
  };
  return {
    data, store, locks,
    deps: { store, now: () => clock, defer: (w: () => Promise<void>) => { deferred.push(w); } },
    advance: (sec: number) => { clock += sec * 1000; },
    flush: async () => { while (deferred.length) await deferred.shift()!(); },
  };
}

describe('originCacheKey', () => {
  const opts = { name: 'nav', params: ['window', 'bucket'] };
  it('is the same whatever the parameter order', () => {
    expect(originCacheKey(opts, new URL('https://x/api?window=30d&bucket=hour'))).toBe(originCacheKey(opts, new URL('https://x/api?bucket=hour&window=30d')));
    expect(originCacheKey(opts, new URL('https://x/api'))).toBe('nav');
  });
  it('refuses a request with a parameter outside the list', () => {
    expect(originCacheKey(opts, new URL('https://x/api?window=30d&user=0xabc'))).toBeNull();
    expect(originCacheKey({ name: 'status' }, new URL('https://x/api?_=123'))).toBeNull();
  });
  it('refuses what the route says is not pool-wide', () => {
    const pool = { name: 'pool', params: ['action'], eligible: (q: URLSearchParams) => [null, 'members'].includes(q.get('action')) };
    expect(originCacheKey(pool, new URL('https://x/api?action=members'))).toBe('pool?action=members');
    expect(originCacheKey(pool, new URL('https://x/api?action=quote'))).toBeNull();
  });
});

describe('withOriginCache', () => {
  it('computes once, stores the payload, then answers from the store', async () => {
    const h = harness();
    const handler = jest.fn(async () => ok({ n: 1 }));
    const GET = withOriginCache({ name: 'status', freshSec: 30 }, handler, h.deps);

    const first = await GET(req('/api/status'));
    expect(first.headers.get(ORIGIN_CACHE_HEADER)).toBe('MISS');
    expect(await first.json()).toEqual({ n: 1 });
    await h.flush();

    h.advance(10);
    const second = await GET(req('/api/status'));
    expect(second.headers.get(ORIGIN_CACHE_HEADER)).toBe('HIT');
    expect(second.headers.get('cache-control')).toBe('public, s-maxage=30');
    expect(await second.json()).toEqual({ n: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('serves a stale payload at once and recomputes behind the response', async () => {
    const h = harness({ status: { body: '{"n":1}', storedAt: T0 - 120_000, cacheControl: null } });
    const handler = jest.fn(async () => ok({ n: 2 }));
    const GET = withOriginCache({ name: 'status', freshSec: 30 }, handler, h.deps);

    const res = await GET(req('/api/status'));
    expect(res.headers.get(ORIGIN_CACHE_HEADER)).toBe('STALE');
    expect(res.headers.get('x-origin-cache-age')).toBe('120');
    expect(await res.json()).toEqual({ n: 1 });
    expect(handler).not.toHaveBeenCalled();

    await h.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.data.get('status')!.body)).toEqual({ n: 2 });
  });

  it('only one caller recomputes a stale payload', async () => {
    const h = harness({ status: { body: '{"n":1}', storedAt: T0 - 120_000, cacheControl: null } });
    const handler = jest.fn(async () => ok({ n: 2 }));
    const GET = withOriginCache({ name: 'status', freshSec: 30 }, handler, h.deps);
    await Promise.all([GET(req('/api/status')), GET(req('/api/status')), GET(req('/api/status'))]);
    await h.flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never stores or replays an error', async () => {
    const h = harness();
    const handler = jest.fn(async () => new Response('{"error":"db down"}', { status: 500 }));
    const GET = withOriginCache({ name: 'status', freshSec: 30 }, handler, h.deps);
    expect((await GET(req('/api/status'))).status).toBe(500);
    await h.flush();
    expect(h.data.size).toBe(0);
    expect((await GET(req('/api/status'))).status).toBe(500);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('a 200 that reports its own failure is not stored', async () => {
    const h = harness();
    for (const body of [{ success: false, data: null }, { enabled: true, error: 'connection timeout' }]) {
      await withOriginCache({ name: 'status', freshSec: 30 }, async () => ok(body), h.deps)(req('/api/status'));
      await h.flush();
    }
    expect(h.data.size).toBe(0);
    await withOriginCache({ name: 'status', freshSec: 30 }, async () => new Response('not json', { status: 200 }), h.deps)(req('/api/status'));
    await h.flush();
    expect(h.data.size).toBe(0);
  });

  it('a failed refresh keeps the stored payload', async () => {
    const h = harness({ status: { body: '{"n":1}', storedAt: T0 - 120_000, cacheControl: null } });
    const GET = withOriginCache({ name: 'status', freshSec: 30 }, async () => new Response('{}', { status: 500 }), h.deps);
    await GET(req('/api/status'));
    await h.flush();
    expect(h.data.get('status')!.body).toBe('{"n":1}');
  });

  it('nothing older than the limit is served', async () => {
    const h = harness({ status: { body: '{"n":1}', storedAt: T0 - 2 * 86_400_000, cacheControl: null } });
    const handler = jest.fn(async () => ok({ n: 2 }));
    const res = await withOriginCache({ name: 'status', freshSec: 30 }, handler, h.deps)(req('/api/status'));
    expect(await res.json()).toEqual({ n: 2 });
    expect(res.headers.get(ORIGIN_CACHE_HEADER)).toBe('MISS');
  });

  it('a request the cache must not answer goes straight to the handler', async () => {
    const h = harness({ pool: { body: '{"shared":true}', storedAt: T0, cacheControl: null } });
    const handler = jest.fn(async () => ok({ mine: true }));
    const GET = withOriginCache({ name: 'pool', freshSec: 30, params: ['chain'] }, handler, h.deps);
    const res = await GET(req('/api/pool?user=0xabc'));
    expect(await res.json()).toEqual({ mine: true });
    expect(res.headers.get(ORIGIN_CACHE_HEADER)).toBeNull();
    await h.flush();
    expect(h.store.set).not.toHaveBeenCalled();
  });

  it('a store that fails or is absent is not a failed read', async () => {
    const h = harness();
    (h.store.get as jest.Mock).mockImplementation(async () => { throw new Error('redis down'); });
    (h.store.set as jest.Mock).mockImplementation(async () => { throw new Error('redis down'); });
    const res = await withOriginCache({ name: 'status', freshSec: 30 }, async () => ok({ n: 1 }), h.deps)(req('/api/status'));
    expect(await res.json()).toEqual({ n: 1 });
    await expect(h.flush()).resolves.toBeUndefined();

    const none = await withOriginCache({ name: 'status', freshSec: 30 }, async () => ok({ n: 3 }), { ...h.deps, store: null })(req('/api/status'));
    expect(await none.json()).toEqual({ n: 3 });
  });
});
