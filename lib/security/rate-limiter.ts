/**
 * Rate Limiter — Distributed (Upstash Redis) + In-Memory Fallback
 * 
 * Two-tier architecture:
 * 1. When UPSTASH_REDIS_REST_URL is set → uses @upstash/ratelimit for
 *    globally consistent limits across all Vercel serverless instances.
 * 2. Fallback → in-memory sliding window with LRU eviction (per-instance).
 * 
 * All callers use the same `.check(request)` API regardless of backend.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ─── Upstash Redis singleton ────────────────────────────────────────
let _redis: Redis | null = null;
let _redisInitFailed = false;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (_redisInitFailed) return null;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token || !url.startsWith('https://')) {
    _redisInitFailed = true;
    return null;
  }
  try {
    _redis = new Redis({ url, token });
    return _redis;
  } catch {
    _redisInitFailed = true;
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────────

interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Key prefix for Upstash (namespace different tiers) */
  prefix?: string;
  /** Key extractor — defaults to IP address */
  keyFn?: (request: NextRequest) => string;
  /** Max unique keys to track in in-memory fallback */
  maxKeys?: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_KEY_FN = (request: NextRequest): string => {
  // The client address, as set by the platform edge. Never a header the
  // caller chooses: keying on `x-wallet-address` gave a fresh bucket to
  // anyone who changed it on each request.
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
};

// ─── In-memory fallback rate limiter ────────────────────────────────

function createInMemoryLimiter(config: RateLimitConfig) {
  const { maxRequests, windowMs, keyFn = DEFAULT_KEY_FN, maxKeys = 10_000 } = config;
  const windows = new Map<string, WindowEntry>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (entry.resetAt < now) windows.delete(key);
    }
  }, 60_000);
  cleanupTimer.unref();

  function evictOldest(): void {
    const evictCount = Math.max(1, Math.floor(maxKeys * 0.1));
    let removed = 0;
    for (const key of windows.keys()) {
      if (removed >= evictCount) break;
      windows.delete(key);
      removed++;
    }
  }

  return {
    check(request: NextRequest): NextResponse | null {
      const key = keyFn(request);
      const now = Date.now();
      const entry = windows.get(key);

      if (!entry || entry.resetAt < now) {
        if (!entry && windows.size >= maxKeys) evictOldest();
        windows.delete(key);
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return null;
      }

      windows.delete(key);
      entry.count++;
      windows.set(key, entry);

      if (entry.count > maxRequests) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        return NextResponse.json(
          { success: false, error: 'Too many requests', retryAfter },
          {
            status: 429,
            headers: {
              'Retry-After': String(retryAfter),
              'X-RateLimit-Limit': String(maxRequests),
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
            },
          }
        );
      }
      return null;
    },
    stats() {
      return { trackedKeys: windows.size, maxKeys, backend: 'in-memory' as const };
    },
  };
}

// ─── Distributed Upstash rate limiter ───────────────────────────────

function createUpstashLimiter(config: RateLimitConfig, redis: Redis) {
  const { maxRequests, windowMs, prefix = 'rl', keyFn = DEFAULT_KEY_FN } = config;

  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(maxRequests, `${windowMs}ms`),
    prefix,
    analytics: true,
  });

  return {
    check(request: NextRequest): NextResponse | null {
      const _key = keyFn(request);
      // Upstash ratelimit is async, but our API is sync for backwards compatibility.
      // Use a synchronous wrapper: fire the check and allow it through optimistically,
      // relying on the next request to catch violations. This avoids making every
      // API route async just for rate limiting.
      // 
      // For truly blocking async rate limiting, use checkAsync() below.
      // In practice, the in-memory limiter catches burst abuse per-instance,
      // while Upstash catches cross-instance abuse with eventual consistency.
      return null; // Handled by checkAsync
    },

    async checkAsync(request: NextRequest): Promise<NextResponse | null> {
      const key = keyFn(request);
      const { success, limit, remaining, reset } = await ratelimit.limit(key);

      if (!success) {
        const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
        return NextResponse.json(
          { success: false, error: 'Too many requests', retryAfter },
          {
            status: 429,
            headers: {
              'Retry-After': String(retryAfter),
              'X-RateLimit-Limit': String(limit),
              'X-RateLimit-Remaining': String(remaining),
              'X-RateLimit-Reset': String(Math.ceil(reset / 1000)),
            },
          }
        );
      }
      return null;
    },

    /** Raw check — returns success/reset without building a NextResponse */
    async checkRaw(request: NextRequest): Promise<{ success: boolean; reset: number }> {
      const key = keyFn(request);
      const { success, reset } = await ratelimit.limit(key);
      return { success, reset };
    },

    stats() {
      return { backend: 'upstash' as const };
    },
  };
}

// ─── Hybrid limiter: Upstash + in-memory ────────────────────────────

function createHybridLimiter(config: RateLimitConfig) {
  const redis = getRedis();
  const { keyFn = DEFAULT_KEY_FN } = config;
  const memLimiter = createInMemoryLimiter(config);
  const upstashLimiter = redis ? createUpstashLimiter(config, redis) : null;

  // Cache of last-known distributed state — makes sync check() globally aware
  // When Upstash says a key is over-limit, subsequent sync checks block it too
  const _distBlocked = new Map<string, number>(); // key → resetAt timestamp

  return {
    /**
     * Synchronous check — in-memory + cached distributed state.
     * Returns NextResponse (429) if limited, null if allowed.
     * Background-fires Upstash check and caches the result for future calls.
     */
    check(request: NextRequest): NextResponse | null {
      // In-memory limiter always runs (fast, catches per-instance bursts)
      const memResult = memLimiter.check(request);
      if (memResult) return memResult;

      const key = keyFn(request);

      // Check cached distributed block state (set by previous background checks)
      const blockedUntil = _distBlocked.get(key);
      if (blockedUntil && blockedUntil > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
        return NextResponse.json(
          { success: false, error: 'Too many requests', retryAfter },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      }
      if (blockedUntil) _distBlocked.delete(key); // Expired, clean up

      // Fire Upstash check in background and cache the result
      if (upstashLimiter) {
        upstashLimiter.checkRaw(request).then(({ success, reset }) => {
          if (!success) {
            _distBlocked.set(key, reset);
          } else {
            _distBlocked.delete(key);
          }
          // Periodic cleanup of expired entries
          if (_distBlocked.size > 5000) {
            const now = Date.now();
            for (const [k, v] of _distBlocked) { if (v < now) _distBlocked.delete(k); }
          }
        }).catch(() => {});
      }

      return null;
    },

    /**
     * Async check — uses both in-memory AND Upstash for globally consistent limiting.
     * Use this in routes where strict distributed enforcement is critical
     * (money-moving operations, heavy compute).
     */
    async checkDistributed(request: NextRequest): Promise<NextResponse | null> {
      // In-memory fast check first
      const memResult = memLimiter.check(request);
      if (memResult) return memResult;

      // Upstash distributed check — gracefully fall back to in-memory if Redis is down
      if (upstashLimiter) {
        try {
          return await upstashLimiter.checkAsync(request);
        } catch {
          // Redis unavailable — in-memory protection still active
          return null;
        }
      }

      return null;
    },

    stats() {
      return {
        inMemory: memLimiter.stats(),
        distributed: upstashLimiter ? upstashLimiter.stats() : { backend: 'none' as const },
        distributedBlockedKeys: _distBlocked.size,
      };
    },
  };
}

export { createHybridLimiter as createRateLimiter };

// ─── Pre-configured limiters for different route types ──────────────

/** Mutation endpoints (hedge execute, settlement, etc.) — 20 req/min */
export const mutationLimiter = createHybridLimiter({
  maxRequests: 20,
  windowMs: 60_000,
  prefix: 'rl:mutation',
});

/** Read-only endpoints (prices, status, etc.) — 120 req/min */
export const readLimiter = createHybridLimiter({
  maxRequests: 120,
  windowMs: 60_000,
  prefix: 'rl:read',
});

/** Heavy computation endpoints (ZK proofs, analysis, chat) — 10 req/min */
export const heavyLimiter = createHybridLimiter({
  maxRequests: 10,
  windowMs: 60_000,
  prefix: 'rl:heavy',
});

/** Admin/internal endpoints — 60 req/min */
export const adminLimiter = createHybridLimiter({
  maxRequests: 60,
  windowMs: 60_000,
  prefix: 'rl:admin',
});
