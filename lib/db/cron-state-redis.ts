/**
 * Redis-backed cron_state store — same API surface as lib/db/cron-state.ts
 * (Postgres impl) so callers can switch backends behind an env flag.
 *
 * Why: Aiven Postgres has a hard 20-conn plan cap shared across every
 * Vercel instance. Every cron tick + health probe + dashboard read
 * eats a slot. This file moves the write-side metadata (heartbeats,
 * halt keys, alert ring buffer) off Postgres onto Upstash Redis which
 * has no such cap and better fits key-value + list workloads anyway.
 *
 * Rollout via env flags in lib/db/cron-state.ts:
 *   CRON_STATE_REDIS_WRITE=1  → dual-write (both backends)
 *   CRON_STATE_REDIS_READ=1   → reads come from Redis (Postgres still receives writes as fallback)
 *
 * Migration completes when Aiven is retired (Phase 5 of the hackathon
 * plan) — at that point cron-state.ts becomes a thin re-export of
 * this file and lib/db/postgres.ts gets deleted.
 */

import { Redis } from '@upstash/redis';
import { logger } from '@/lib/utils/logger';

// ─── Redis singleton (same pattern as lib/security/rate-limiter.ts) ────────

let _redis: Redis | null = null;
let _redisInitFailed = false;

export function getRedis(): Redis | null {
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
  } catch (e) {
    logger.warn('[CronStateRedis] init failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    _redisInitFailed = true;
    return null;
  }
}

// Test-only: reset the singleton so unit tests can re-init after clearing env.
export function _resetRedisForTest(): void {
  _redis = null;
  _redisInitFailed = false;
}

// ─── Key namespace ─────────────────────────────────────────────────────────
// Namespace every key so we don't collide with rate-limiter keys or future
// unrelated Redis usage. Postgres key names map 1:1 to `cs:<key>` here.
const NS = 'cs:';
const nk = (key: string): string => `${NS}${key}`;

// ─── Core Helpers ──────────────────────────────────────────────────────────

/**
 * Get a value from the cron state store.
 * Returns null if key doesn't exist or Redis is unavailable.
 */
export async function getCronState<T = unknown>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    // Upstash's Redis client already JSON-parses when the value looks like JSON,
    // so we get back the original shape without an extra JSON.parse here.
    const v = await redis.get<T>(nk(key));
    return (v as T) ?? null;
  } catch (error) {
    logger.warn(`[CronStateRedis] get "${key}" failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Get with a default fallback (never returns null). */
export async function getCronStateOr<T>(key: string, defaultValue: T): Promise<T> {
  const value = await getCronState<T>(key);
  return value ?? defaultValue;
}

/** Set (upsert) a value in the cron state store. */
export async function setCronState<T = unknown>(key: string, value: T): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    // Upstash SDK auto-serializes objects. Passing the raw value keeps
    // parity with Postgres impl which JSON.stringify's on write.
    await redis.set(nk(key), value as unknown);
  } catch (error) {
    logger.warn(`[CronStateRedis] set "${key}" failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Delete a key from the cron state store. */
export async function deleteCronState(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(nk(key));
  } catch (error) {
    logger.warn(`[CronStateRedis] del "${key}" failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get multiple keys matching a prefix.
 * Uses SCAN (safe for prod) rather than KEYS (blocks the server).
 */
export async function getCronStateByPrefix<T = unknown>(prefix: string): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  const redis = getRedis();
  if (!redis) return result;
  try {
    const match = `${nk(prefix)}*`;
    let cursor: string | number = 0;
    const collected: string[] = [];
    // Cap iterations to keep worst-case bounded (Upstash SCAN cost per call).
    for (let i = 0; i < 50; i++) {
      const scanResult: [string | number, string[]] = await redis.scan(cursor, { match, count: 200 });
      const nextCursor: string | number = scanResult[0];
      const batch: string[] = scanResult[1];
      collected.push(...batch);
      cursor = nextCursor;
      if (nextCursor === 0 || nextCursor === '0') break;
    }
    if (collected.length === 0) return result;
    const values = await redis.mget<T[]>(...collected);
    collected.forEach((namespaced, i) => {
      const v = values[i];
      if (v !== null && v !== undefined) {
        // Strip the NS prefix so callers see the same key shape as Postgres.
        result.set(namespaced.slice(NS.length), v as T);
      }
    });
  } catch (error) {
    logger.warn(`[CronStateRedis] scan prefix "${prefix}" failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

// ─── Typed Convenience Helpers ─────────────────────────────────────────────

export async function getTimestamp(key: string): Promise<number> {
  return getCronStateOr<number>(key, 0);
}

export async function setTimestamp(key: string, ts: number = Date.now()): Promise<void> {
  return setCronState(key, ts);
}

export async function getNumber(key: string, defaultValue: number = 0): Promise<number> {
  return getCronStateOr<number>(key, defaultValue);
}

export async function setNumber(key: string, value: number): Promise<void> {
  return setCronState(key, value);
}

// ─── CAS-based singleton + halt helpers ────────────────────────────────────
// Postgres uses `UPDATE ... WHERE value = $prev` for atomic CAS. Redis needs
// WATCH/MULTI/EXEC, but Upstash's REST API doesn't support pipelined WATCH.
// The safe alternative is SET NX with a short lock key + read-then-write —
// that's how the reference impl below claims run windows.
//
// Fails CLOSED on any Redis error (same as the Postgres impl): when in doubt
// we skip the run rather than risk a duplicate hedge.

/**
 * Atomically claim the next cron run window. Returns true ONLY if
 * `now - lastRun >= minIntervalMs` AND the claim lock was acquired.
 *
 * Uses a short-lived SET NX EX lock keyed off the cron id so only one
 * fleet instance can pass the gate at a time. Then reads current lastRun,
 * compares against interval, updates, and releases the lock.
 */
export async function tryClaimCronRun(
  cronId: string,
  minIntervalMs: number,
  now: number = Date.now(),
): Promise<{ claimed: boolean; lastRunMs: number; reason?: string }> {
  const redis = getRedis();
  if (!redis) return { claimed: false, lastRunMs: 0, reason: 'redis-unavailable' };
  const lastRunKey = nk(CronKeys.cronLastRun(cronId));
  const lockKey = nk(`lock:${CronKeys.cronLastRun(cronId)}`);
  // Lock TTL bounds worst-case orphan-lock time if the process dies mid-claim.
  // Keep well below cron interval so a crashed instance doesn't block the next tick.
  const lockTtlSec = Math.max(2, Math.min(30, Math.floor(minIntervalMs / 1000 / 4)));

  try {
    // NX = only set if not exists; EX = TTL seconds. Returns 'OK' on success, null on collision.
    const acquired = await redis.set(lockKey, '1', { nx: true, ex: lockTtlSec });
    if (!acquired) {
      const prev = (await redis.get<number>(lastRunKey)) ?? 0;
      return { claimed: false, lastRunMs: Number(prev), reason: 'lock-held' };
    }
    try {
      const prev = Number((await redis.get<number>(lastRunKey)) ?? 0);
      if (prev > 0 && now - prev < minIntervalMs) {
        return { claimed: false, lastRunMs: prev, reason: 'rate-limit' };
      }
      await redis.set(lastRunKey, now);
      return { claimed: true, lastRunMs: now };
    } finally {
      // Best-effort release; if this fails the TTL handles it.
      await redis.del(lockKey).catch(() => {});
    }
  } catch (error) {
    logger.warn('[CronStateRedis] tryClaimCronRun failed — failing closed', {
      cronId, error: error instanceof Error ? error.message : String(error),
    });
    return { claimed: false, lastRunMs: 0, reason: 'redis-error' };
  }
}

export async function setCronHalt(
  cronId: string,
  untilMs: number,
  reason: string,
): Promise<void> {
  await Promise.all([
    setNumber(CronKeys.cronHaltUntil(cronId), untilMs),
    setCronState(CronKeys.cronHaltReason(cronId), reason),
  ]);
}

export async function getCronHalt(
  cronId: string,
  now: number = Date.now(),
): Promise<{ untilMs: number; reason: string } | null> {
  try {
    const [until, reason] = await Promise.all([
      getNumber(CronKeys.cronHaltUntil(cronId), 0),
      getCronStateOr<string>(CronKeys.cronHaltReason(cronId), 'unspecified'),
    ]);
    if (until <= now) return null;
    return { untilMs: until, reason };
  } catch (error) {
    logger.warn('[CronStateRedis] getCronHalt failed — returning short synthetic halt', {
      cronId, error: error instanceof Error ? error.message : String(error),
    });
    return { untilMs: now + 60_000, reason: 'redis-read-failed' };
  }
}

// ─── Alert ring buffer (LIST-native) ───────────────────────────────────────
// The Postgres impl reads the entire array, appends, slices to 200, writes back.
// Redis LPUSH + LTRIM does this atomically in two ops with no read-modify-write.
// Kept as a separate export so callers explicitly opt into the LIST shape.

const RING_KEY = nk('alert-log:ring-buffer');
const RING_MAX = 200;

export async function appendAlertLogRedis(entry: unknown): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.lpush(RING_KEY, entry as never);
    await redis.ltrim(RING_KEY, 0, RING_MAX - 1);
  } catch (error) {
    logger.warn('[CronStateRedis] appendAlertLog failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readAlertLogRedis<T = unknown>(): Promise<T[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.lrange<T>(RING_KEY, 0, RING_MAX - 1);
    // Postgres impl returns oldest-first; LPUSH gives newest-first, so reverse.
    return raw.reverse();
  } catch (error) {
    logger.warn('[CronStateRedis] readAlertLog failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ─── Key builders (mirrored from lib/db/cron-state.ts) ─────────────────────
// Kept in lockstep with the Postgres impl. Any change to the Postgres key
// builder MUST land here in the same commit or the dual-write bridge will
// write to different keys per backend.

export const CronKeys = {
  requestCounter: 'priceAlert:requestCounter',
  priceAlertLastAlert: (asset: string) => `priceAlert:lastAlert:${asset}`,
  poolNavPeak: (poolId: string) => `poolNav:peak:${poolId}`,
  poolNavLastHedge: (poolId: string) => `poolNav:lastHedge:${poolId}`,
  rebalanceLastHedge: (portfolioId: number) => `rebalance:lastHedge:${portfolioId}`,
  rebalancePeakValue: (portfolioId: number) => `rebalance:peakValue:${portfolioId}`,
  cronLastRun: (cronId: string) => `cron:lastRun:${cronId}`,
  cronHaltUntil: (cronId: string) => `cron:haltUntil:${cronId}`,
  cronHaltReason: (cronId: string) => `cron:haltReason:${cronId}`,
  polymarketEdgeHaltedUntil: 'polymarket-edge:halted-until' as const,
} as const;
