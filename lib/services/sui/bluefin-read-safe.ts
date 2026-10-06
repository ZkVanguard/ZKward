/**
 * Centralized "safe" BlueFin snapshot for NAV / health / display paths.
 *
 * Failure modes this defends against (all observed in production):
 *   1. Cold Vercel lambda — singleton not yet initialized, getBalance silently
 *      returns 0 instead of throwing.
 *   2. Auth handshake blip — JWT didn't land, account fetch returns null,
 *      getBalance returns 0.
 *   3. Venue API transient — Bluefin returns malformed/empty data, looks
 *      like "no positions" when on-chain says there should be exposure.
 *
 * Contract:
 *   - Always re-runs `initialize(adminKey, network)` before reading so a cold
 *     singleton can never silently surface as zero.
 *   - If the read looks "suspiciously empty" (free=$0 AND positions=[] AND
 *     onChainHasExposure=true), prefers the last-good DB cache over the live
 *     read. That is the asymmetry: a true $0 venue read is only trusted when
 *     on-chain agrees there should be nothing to read.
 *   - On any throw, falls back to the cache; if no fresh cache, surfaces
 *     `source: 'unknown'` so callers know the value can't be trusted.
 *
 * Cache TTL is intentionally longer than the sui-community-pool cron interval
 * (30 min) so any single warm read in the last 30 min covers cold-lambda gaps.
 */

import { logger } from '@/lib/utils/logger';
import { BluefinService, type BluefinPosition } from '@/lib/services/sui/BluefinService';
import { setCronState, getCronStateOr } from '@/lib/db/cron-state';

export interface BluefinSnapshot {
  free: number;
  lockedMargin: number;
  upnl: number;
  totalValue: number;          // the venue's own account value
  positions: BluefinPosition[];
  positionsCount: number;
  source: 'live' | 'cache' | 'unknown';
  ageMs?: number;              // only set when source === 'cache'
  warning?: string;
}

/** v2: holds the venue's own account value. The unversioned key held a sum that double-counted cross-margin P&L. */
export const BLUEFIN_NAV_CACHE_KEY = 'bluefin:nav-last-good:v2';
const CACHE_KEY = BLUEFIN_NAV_CACHE_KEY;
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedSnapshot {
  value: number;
  free: number;
  lockedMargin: number;
  upnl: number;
  positions: number;            // count only — full position objects aren't cached
  ts: number;
}

function sumPositionFields(positions: BluefinPosition[]): { lockedMargin: number; upnl: number } {
  let lockedMargin = 0;
  let upnl = 0;
  for (const p of positions) {
    const pp = p as unknown as Record<string, unknown>;
    // BluefinService.getPositions returns `margin` (initialMargin) and
    // `unrealizedPnl` (NOT `unrealizedProfit` / `uPnL` — those names
    // came from a different SDK shape and would silently sum to zero).
    lockedMargin += Number(pp.margin ?? pp.initialMargin ?? 0) || 0;
    upnl += Number(pp.unrealizedPnl ?? 0) || 0;
  }
  return { lockedMargin, upnl };
}

async function readCache(): Promise<{ cached: CachedSnapshot | null; ageMs: number }> {
  const cached = await getCronStateOr<CachedSnapshot | null>(CACHE_KEY, null);
  const ageMs = cached ? Date.now() - cached.ts : Infinity;
  return { cached, ageMs };
}

/**
 * Refresh the shared `bluefin:nav-last-good` cache from a successful
 * BlueFin read. Any cron that touches getBalance + getPositions and
 * gets clean values should call this — keeps the cache hot across
 * every cron cadence so the NAV path / health endpoint / dashboard
 * always see fresh data, regardless of which cron last fired.
 *
 * No-op when the read looks empty (free=0 AND no positions) so a
 * venue blip can't poison the cache with zeros.
 *
 * Also maintains a `bluefin:consecutiveEmptyReads` counter for
 * persistence-based empty detection: each clean (non-empty) read
 * resets it; each empty read increments it. Discord alerts at the
 * 3rd consecutive empty so 1-tick venue blips don't page anyone but
 * sustained outages do.
 */
export async function refreshBluefinCache(args: {
  free: number;
  positions: Array<Record<string, unknown>>;
  /** The venue's own account value. Without it the counters are kept but the cached total is left alone. */
  accountValue?: number;
  source?: string;          // which cron called us, for logging
}): Promise<void> {
  const { free, positions, accountValue, source = 'unknown' } = args;
  const venueLooksEmpty = free === 0 && positions.length === 0;

  if (venueLooksEmpty) {
    // Increment persistent empty-read counter. Alert on the 3rd one
    // (≈ 15 min of consecutive empties at 5-min cron cadence).
    //
    // 2026-07-17: silent-catch on the increment removed. If the write
    // fails, the count stays stale → 3-strike alert never fires →
    // operator doesn't learn venue is empty. Now logs on failure.
    const prev = await getCronStateOr<number>('bluefin:consecutiveEmptyReads', 0);
    const next = prev + 1;
    try {
      await setCronState('bluefin:consecutiveEmptyReads', next);
    } catch (err) {
      logger.error('[bluefin-read-safe] consecutiveEmptyReads increment FAILED', {
        prev, next, error: err instanceof Error ? err.message : String(err),
      });
    }
    if (next === 3) {
      const { notifyDiscord } = await import('@/lib/utils/discord-notify');
      await notifyDiscord(
        `BlueFin /account returning EMPTY for ${next}+ consecutive cron reads (~15 min). ` +
        `Could be venue API glitch OR real position close. NAV is currently served from ` +
        `last-good cache. Investigate via BlueFin web UI.`,
        'WARN',
        { source, consecutiveEmpty: next },
      ).catch(() => {});
    }
    return; // don't poison cache with zeros
  }

  // Clean (non-empty) read — reset the empty counter and refresh cache.
  try {
    await setCronState('bluefin:consecutiveEmptyReads', 0);
  } catch (err) {
    logger.warn('[bluefin-read-safe] consecutiveEmptyReads reset failed (non-critical)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let lockedMargin = 0;
  let upnl = 0;
  for (const p of positions) {
    lockedMargin += Number(p.margin ?? p.initialMargin ?? 0) || 0;
    upnl += Number(p.unrealizedPnl ?? 0) || 0;
  }
  // Only the venue's own total may be cached as the NAV component; a sum of
  // the parts double-counts cross-margin P&L. The NAV read refreshes it.
  if (accountValue === undefined || !Number.isFinite(accountValue)) return;
  await setCronState(CACHE_KEY, {
    value: accountValue,
    free,
    lockedMargin,
    upnl,
    positions: positions.length,
    ts: Date.now(),
  }).catch(() => { /* best-effort */ });
}

function snapshotFromCache(c: CachedSnapshot, ageMs: number, warning: string): BluefinSnapshot {
  return {
    free: c.free,
    lockedMargin: c.lockedMargin,
    upnl: c.upnl,
    totalValue: c.value,
    positions: [],
    positionsCount: c.positions,
    source: 'cache',
    ageMs,
    warning,
  };
}

/**
 * Read BlueFin venue state with cache fallback.
 *
 * @param onChainHasExposure  Pass true when on-chain hedge_state.active_hedges
 *   is non-empty OR total_hedged_value > 0. Lets the helper distinguish "venue
 *   really empty" from "venue read failed and we expected exposure."
 */
export async function safeBluefinSnapshot(opts: {
  network: 'mainnet' | 'testnet';
  onChainHasExposure: boolean;
}): Promise<BluefinSnapshot> {
  const adminKey = (process.env.BLUEFIN_PRIVATE_KEY || process.env.SUI_POOL_ADMIN_KEY || '').trim();
  if (!adminKey) {
    const { cached, ageMs } = await readCache();
    if (cached) {
      const stale = ageMs >= CACHE_TTL_MS;
      const warning = stale
        ? `STALE cache (${Math.round(ageMs / 60_000)}min): no adminKey configured`
        : 'no adminKey configured — using cache';
      return snapshotFromCache(cached, ageMs, warning);
    }
    return {
      free: 0, lockedMargin: 0, upnl: 0, totalValue: 0,
      positions: [], positionsCount: 0,
      source: 'unknown', warning: 'no BLUEFIN_PRIVATE_KEY configured',
    };
  }

  try {
    const bf = BluefinService.getInstance();
    // Always re-call initialize. It's idempotent when already initialized
    // (returns early on line 199–201) and re-runs auth if not.
    await bf.initialize(adminKey, opts.network);

    const [freeRes, posRes, valueRes] = await Promise.allSettled([
      bf.getBalance(),
      bf.getPositions(),
      bf.getAccountValue(),
    ]);
    const free = freeRes.status === 'fulfilled' ? (Number(freeRes.value) || 0) : 0;
    const positions: BluefinPosition[] = posRes.status === 'fulfilled' ? posRes.value : [];
    // "Ok" includes the account value: without it there is no trustworthy
    // total, and the cached one is used instead.
    const bothOk = freeRes.status === 'fulfilled' && posRes.status === 'fulfilled' && valueRes.status === 'fulfilled';

    const { lockedMargin, upnl } = sumPositionFields(positions);
    // The venue's own total. free + lockedMargin + upnl counted a cross-margin
    // position's unrealized P&L twice (free collateral already includes it):
    // on 2026-10-06 that sum read $9.47 against an account value of $16.22.
    const computed = valueRes.status === 'fulfilled' ? valueRes.value : free + lockedMargin;
    const venueLooksEmpty = free === 0 && positions.length === 0;

    // Trust path 1: both fetches succeeded AND something is there.
    if (bothOk && !venueLooksEmpty) {
      const cachePayload: CachedSnapshot = {
        value: computed, free, lockedMargin, upnl,
        positions: positions.length, ts: Date.now(),
      };
      // Reset consecutiveEmptyReads counter — any clean live read means
      // the venue is alive again. Without this, the counter only resets
      // on CRON-driven refreshes (refreshBluefinCache), so on-demand
      // API reads that get clean data leave the counter stuck at its
      // historical high. Observed 2026-06-22: counter=8 while venue
      // was actively responding to a divergence-endpoint read.
      await Promise.all([
        setCronState(CACHE_KEY, cachePayload).catch(() => {}),
        setCronState('bluefin:consecutiveEmptyReads', 0).catch(() => {}),
      ]);
      return {
        free, lockedMargin, upnl, totalValue: computed,
        positions, positionsCount: positions.length,
        source: 'live',
      };
    }

    // Trust path 2: both fetches succeeded, venue truly empty, AND no
    // exposure expected. Return live $0 but DO NOT cache the zero —
    // cache is reserved for positive snapshots so consecutive cold-
    // lambda + empty-venue glitches can't poison it. Reset counter
    // because this IS a clean read (not degraded).
    if (bothOk && venueLooksEmpty && !opts.onChainHasExposure) {
      await setCronState('bluefin:consecutiveEmptyReads', 0).catch(() => {});
      return {
        free: 0, lockedMargin: 0, upnl: 0, totalValue: 0,
        positions: [], positionsCount: 0,
        source: 'live',
      };
    }

    // Suspicious read: venue says empty but chain says exposure, OR a sub-
    // fetch rejected. Prefer the cache; if cache TTL is expired but a value
    // exists, STILL use it (marked source: 'cache' with a stale warning)
    // rather than dropping the BlueFin component from NAV. A stale read
    // that's hours old is dramatically better than reporting $0 and
    // tanking the share price for every dashboard viewer.
    const { cached, ageMs } = await readCache();
    if (cached) {
      const stale = ageMs >= CACHE_TTL_MS;
      const warning = stale
        ? `STALE cache (${Math.round(ageMs / 60_000)}min old) — live read failed AND TTL expired`
        : 'live read looked empty while on-chain has exposure';
      logger[stale ? 'error' : 'warn']('[BluefinReadSafe] suspicious live read — using cache', {
        bothOk,
        freeRead: freeRes.status,
        posRead: posRes.status,
        rawFree: free,
        rawPositions: positions.length,
        onChainHasExposure: opts.onChainHasExposure,
        cachedValue: cached.value,
        cacheAgeMs: ageMs,
        stale,
      });
      return snapshotFromCache(cached, ageMs, warning);
    }

    logger.error('[BluefinReadSafe] suspicious live read AND no cache ever — surfacing unknown', {
      bothOk,
      freeRead: freeRes.status,
      posRead: posRes.status,
      onChainHasExposure: opts.onChainHasExposure,
    });
    return {
      free, lockedMargin, upnl, totalValue: computed,
      positions, positionsCount: positions.length,
      source: 'unknown',
      warning: 'venue read suspicious and cache never populated',
    };
  } catch (err) {
    const { cached, ageMs } = await readCache();
    if (cached) {
      const stale = ageMs >= CACHE_TTL_MS;
      const warning = stale
        ? `STALE cache (${Math.round(ageMs / 60_000)}min old): read threw: ${err instanceof Error ? err.message : String(err)}`
        : `read threw: ${err instanceof Error ? err.message : String(err)}`;
      logger[stale ? 'error' : 'warn']('[BluefinReadSafe] read threw — using cache', {
        error: err instanceof Error ? err.message : String(err),
        cachedValue: cached.value,
        cacheAgeMs: ageMs,
        stale,
      });
      return snapshotFromCache(cached, ageMs, warning);
    }
    logger.error('[BluefinReadSafe] read threw and cache never populated', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      free: 0, lockedMargin: 0, upnl: 0, totalValue: 0,
      positions: [], positionsCount: 0,
      source: 'unknown',
      warning: `read threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
