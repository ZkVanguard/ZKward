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
 * around Sui JSON-RPC calls with:
 *   - AbortController timeout (default 10s)
 *   - Exponential backoff retry (up to 2 attempts)
 *   - Consecutive-failure circuit breaker (opens after 5, resets after 30s)
 *   - Dedup cache: 100 concurrent callers share 1 in-flight RPC
 */
import { logger } from '@/lib/utils/logger';

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

// ── Providers: one list for every SUI JSON-RPC path ────────────────────────
// Providers are retiring JSON-RPC for gRPC one by one: the official fullnode
// in 2026-07, and two of the three earlier defaults by 2026-10-22 (HTTP 404
// with a deprecation body). These two still answered `sui_getObject` on
// mainnet that day; no testnet provider tested that day still served it.
export type SuiRpcNetwork = 'mainnet' | 'testnet';
const DEFAULT_PROVIDERS: Record<SuiRpcNetwork, readonly string[]> = {
  mainnet: ['https://sui-rpc.publicnode.com', 'https://mainnet.suiet.app'],
  testnet: ['https://sui-testnet-rpc.publicnode.com'],
};

/**
 * The providers for a network, in order: `SUI_<NET>_RPC_LIST` when set,
 * else `SUI_<NET>_RPC` (a pinned paid endpoint) ahead of the defaults.
 */
export function suiRpcProviders(network: SuiRpcNetwork): string[] {
  const NET = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
  const list = (process.env[`SUI_${NET}_RPC_LIST`] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const single = (process.env[`SUI_${NET}_RPC`] || '').trim();
  const defaults = DEFAULT_PROVIDERS[network];
  return single ? [single, ...defaults.filter((u) => u !== single)] : [...defaults];
}

// The provider that last answered, per network and process: every client and
// raw call starts there, so a dead provider costs one request per process,
// not one per call.
const lastWorking: Partial<Record<SuiRpcNetwork, string>> = {};

/** The providers in the order to try them now: the last one that answered first. */
export function suiRpcOrder(network: SuiRpcNetwork): string[] {
  const all = suiRpcProviders(network);
  const pinned = lastWorking[network];
  return pinned && all.includes(pinned) ? [pinned, ...all.filter((u) => u !== pinned)] : all;
}

export function markSuiRpcWorking(network: SuiRpcNetwork, url: string): void {
  lastWorking[network] = url;
}

/** Test hook. */
export function __resetSuiRpcOrderForTests(): void {
  delete lastWorking.mainnet;
  delete lastWorking.testnet;
}

/**
 * A request error comes back as HTTP 200 with a JSON-RPC error, so any other
 * status is the provider's fault: 404 when it has dropped JSON-RPC, 429, 5xx.
 */
export function isSuiProviderFaultStatus(status: number): boolean {
  return status < 200 || status >= 300;
}

export const SUI_RPC_TIMEOUT_MS = envNumber('SUI_RPC_TIMEOUT_MS', 10_000);
export const SUI_RPC_MAX_RETRIES = envNumber('SUI_RPC_MAX_RETRIES', 2);
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

/** A 200 whose only content is "JSON-RPC is deprecated here" is a dead provider too. */
function isDeprecationBody(text: string): boolean {
  try {
    const j = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
    return j.result === undefined && /deprecated/i.test(j.error?.message ?? '');
  } catch {
    return false;
  }
}

/**
 * POST one JSON-RPC body to the network's providers, starting from the last
 * one that answered and moving on from any that is down, refuses JSON-RPC or
 * rate-limits. Each full pass is retried with backoff; a circuit breaker
 * stops the calls after repeated total failure. When no provider answers,
 * the last provider's error response is returned, or the last network error
 * is thrown.
 */
export async function suiFetchWithTimeout(
  network: SuiRpcNetwork,
  init: RequestInit,
  timeoutMs = SUI_RPC_TIMEOUT_MS,
): Promise<Response> {
  if (!suiRpcCircuitBreaker.canAttempt()) {
    // Return a synthetic error response instead of throwing (recoverable)
    logger.warn('[SUI-RPC] Circuit breaker OPEN — returning error response');
    return new Response(
      JSON.stringify({ error: { message: 'SUI RPC circuit breaker is OPEN — requests blocked' } }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  let lastError: unknown;
  let lastRefusal: Response | null = null;
  for (let attempt = 0; attempt <= SUI_RPC_MAX_RETRIES; attempt++) {
    for (const url of suiRpcOrder(network)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await response.text();
        const copy = new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
        if (isSuiProviderFaultStatus(response.status) || isDeprecationBody(text)) {
          lastRefusal = copy;
          logger.warn('[SUI-RPC] Provider refused; trying the next', { url, status: response.status });
          continue;
        }
        markSuiRpcWorking(network, url);
        suiRpcCircuitBreaker.recordSuccess();
        return copy;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    if (attempt < SUI_RPC_MAX_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 4000);
      logger.warn(`[SUI-RPC] Every provider failed on attempt ${attempt + 1}, retrying in ${delay}ms`, {
        error: lastError instanceof Error ? lastError.message : String(lastError ?? lastRefusal?.status),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  suiRpcCircuitBreaker.recordFailure();
  if (lastRefusal) return lastRefusal;
  throw lastError;
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
