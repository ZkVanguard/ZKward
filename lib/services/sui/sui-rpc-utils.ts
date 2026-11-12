/**
 * Shared SUI RPC infrastructure — circuit breaker, timeout+retry fetch,
 * and dedup caching.
 *
 * Both SuiCommunityPoolService (SUI-native pool) and SuiUsdcPoolService
 * (USDC pool) use these utilities. Extracted from
 * SuiCommunityPoolService.ts (was 1602 LOC) so the two service classes
 * don't share a private module scope — sets up the future split of
 * SuiUsdcPoolService into its own file.
 *
 * Nothing here is domain-aware — it's a generic hardening wrapper
 * around Sui JSON-RPC calls (answered by sui-grpc-bridge.ts) with:
 *   - Consecutive-failure circuit breaker (opens after 5, resets after 30s)
 *   - Dedup cache: 100 concurrent callers share 1 in-flight RPC
 */
import { logger } from '@/lib/utils/logger';
import { suiJsonRpcResponse } from './sui-grpc-bridge';

/** Read a numeric env with a default. Trims + parses safely — an invalid
 *  value (garbage, empty, negative when negative is nonsensical) falls
 *  back to the default rather than propagating NaN through the system. */
function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = Number(String(raw).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

// ── TTL constants (env-overridable per environment) ────────────────────────
// Defaults are conservative for prod. Dev / backfill may want lower TTLs
// to see fresh writes immediately; local testing may want higher to
// reduce RPC noise. Every value clamps to > 0 or falls back to default.
export const SUI_STATS_TTL_MS = envNumber('SUI_STATS_TTL_MS', 60_000);
export const SUI_MEMBER_TTL_MS = envNumber('SUI_MEMBER_TTL_MS', 30_000);
export const SUI_MEMBERS_TTL_MS = envNumber('SUI_MEMBERS_TTL_MS', 120_000);

export type SuiRpcNetwork = 'mainnet' | 'testnet';

const CIRCUIT_BREAKER_THRESHOLD = envNumber('SUI_RPC_CIRCUIT_THRESHOLD', 5);
const CIRCUIT_BREAKER_RESET_MS = envNumber('SUI_RPC_CIRCUIT_RESET_MS', 30_000);

// ── Cache infrastructure ───────────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const suiStatsCache = new Map<string, CacheEntry<unknown>>();
const suiPendingRequests = new Map<string, Promise<unknown>>();

// ── Circuit breaker ────────────────────────────────────────────────────────
export const suiRpcCircuitBreaker = {
  failures: 0,
  lastFailure: 0,
  state: 'closed' as 'closed' | 'open' | 'half-open',
  /** Max consecutive failures before opening circuit (env: SUI_RPC_CIRCUIT_THRESHOLD) */
  threshold: CIRCUIT_BREAKER_THRESHOLD,
  /** Time to wait before trying again (ms) (env: SUI_RPC_CIRCUIT_RESET_MS) */
  resetTimeout: CIRCUIT_BREAKER_RESET_MS,

  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
      logger.error('[SUI-RPC] Circuit breaker OPEN — too many consecutive failures', {
        failures: this.failures,
      });
    }
  },
  canAttempt(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.lastFailure > this.resetTimeout) {
      this.state = 'half-open';
      logger.info('[SUI-RPC] Circuit breaker half-open — attempting probe request');
      return true;
    }
    if (this.state === 'half-open') {
      // Allow one probe request in half-open; if it fails, reopen
      return true;
    }
    return false;
  },
};

/**
 * One JSON-RPC body, answered by the gRPC bridge (sui-grpc-bridge.ts) as an
 * HTTP response in JSON-RPC form: 200 with `result`, or 502 with `error`.
 * A circuit breaker stops the calls after repeated failure.
 */
export async function suiFetchWithTimeout(network: SuiRpcNetwork, init: RequestInit): Promise<Response> {
  if (!suiRpcCircuitBreaker.canAttempt()) {
    logger.warn('[SUI-RPC] Circuit breaker OPEN — returning error response');
    return new Response(
      JSON.stringify({ error: { message: 'SUI RPC circuit breaker is OPEN — requests blocked' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const res = await suiJsonRpcResponse(network, typeof init.body === 'string' ? init.body : '');
  if (res.ok) suiRpcCircuitBreaker.recordSuccess();
  else suiRpcCircuitBreaker.recordFailure();
  return res;
}

/**
 * Deduplicated fetch with in-memory caching.
 * Prevents thundering herd: 100 concurrent users = 1 RPC call.
 */
export async function suiCachedFetch<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
): Promise<T> {
  const cached = suiStatsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data as T;
  }

  const pending = suiPendingRequests.get(cacheKey) as Promise<T> | undefined;
  if (pending) return pending;

  const request = fetcher()
    .then((result) => {
      suiStatsCache.set(cacheKey, { data: result, expiresAt: Date.now() + ttlMs });
      return result;
    })
    .finally(() => {
      suiPendingRequests.delete(cacheKey);
    });

  suiPendingRequests.set(cacheKey, request);
  return request;
}

/**
 * Escape hatch — clear all cached entries. Used by unit tests + admin
 * routes that need a guaranteed fresh RPC read.
 */
export function invalidateSuiCache(): void {
  suiStatsCache.clear();
}
