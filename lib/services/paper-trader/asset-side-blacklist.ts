/**
 * Fix L (2026-09-26) — asset-side lifetime win-rate blacklist.
 *
 * Deep-dive audit (2026-09-26, n=379) showed 5 (asset, side) pairs
 * account for 97% of the total bleed:
 *   BTC LONG  114 tr / 26% wr / -$24k
 *   BTC SHORT  36 tr / 22% wr / -$11k
 *   ETH SHORT  70 tr / 33% wr / -$20k
 *   SOL LONG   32 tr / 34% wr / -$14k
 *   SOL SHORT  15 tr / 27% wr /  -$3k
 * vs 3 winners:
 *   XRP LONG   33 tr / 46% wr / +$0.3k
 *   XRP SHORT  20 tr / 45% wr / +$0.5k
 *   DOGE SHORT 37 tr / 41% wr / +$1.5k
 *
 * This module computes lifetime win-rate per (asset, side) from the
 * hedges table, blocks pairs below PAPER_ASSET_SIDE_BLACKLIST_MIN_WR
 * (default 40%) with at least PAPER_ASSET_SIDE_BLACKLIST_MIN_N samples
 * (default 20). Cold pairs pass through.
 *
 * Cached 30 min to avoid a DB hit per candidate. Cache dies with the
 * lambda; first tick after cold-start rebuilds it once.
 */

import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { query } from '@/lib/db/postgres';
import type { Side } from './simulated-executor';
import {
  PAPER_PORTFOLIO_ID,
  PAPER_ASSET_SIDE_BLACKLIST_MIN_WR,
  PAPER_ASSET_SIDE_BLACKLIST_MIN_N,
  PAPER_ASSET_SIDE_BLACKLIST_CACHE_TTL_MS,
} from './config';

interface PairStats {
  n: number;
  wins: number;
  wr: number;
  pnl: number;
  blacklisted: boolean;
}

let _cache: { at: number; pairs: Map<string, PairStats> } | null = null;

function key(asset: string, side: Side): string {
  return `${asset.toUpperCase()}:${side}`;
}

async function loadPairStats(): Promise<Map<string, PairStats>> {
  const rows = await query<{
    asset: string;
    side: string;
    n: string;
    wins: string;
    pnl: string;
  }>(
    `SELECT asset, side, COUNT(*)::text AS n,
            SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)::text AS wins,
            ROUND(SUM(realized_pnl)::numeric, 2)::text AS pnl
     FROM hedges
     WHERE portfolio_id = $1
       AND order_id LIKE 'paper_%'
       AND status = 'closed'
     GROUP BY asset, side`,
    [PAPER_PORTFOLIO_ID],
  );
  const m = new Map<string, PairStats>();
  for (const r of rows) {
    const n = Number(r.n);
    const wins = Number(r.wins);
    const wr = n > 0 ? wins / n : 0;
    const blacklisted = n >= PAPER_ASSET_SIDE_BLACKLIST_MIN_N && wr < PAPER_ASSET_SIDE_BLACKLIST_MIN_WR;
    m.set(key(r.asset, r.side as Side), { n, wins, wr, pnl: Number(r.pnl), blacklisted });
  }
  return m;
}

/**
 * Returns a rejection reason string if this (asset, side) is currently
 * blacklisted based on lifetime empirical wr. Cold pairs (n < min-N)
 * always pass through.
 *
 * Fail-open: any error returns null (allow the trade). The caller has
 * other gates (Fix K, streak, etc.) so a blacklist DB blip doesn't
 * silently open the gates entirely.
 */
export async function assetSideBlacklistRejection(
  asset: string,
  side: Side,
): Promise<string | null> {
  try {
    const now = Date.now();
    if (!_cache || now - _cache.at > PAPER_ASSET_SIDE_BLACKLIST_CACHE_TTL_MS) {
      _cache = { at: now, pairs: await loadPairStats() };
    }
    const stats = _cache.pairs.get(key(asset, side));
    if (!stats) return null; // no data → cold pair, allow
    if (!stats.blacklisted) return null;
    return `asset-side-blacklist: ${asset} ${side} lifetime wr ${(stats.wr * 100).toFixed(0)}% (n=${stats.n}) below ${(PAPER_ASSET_SIDE_BLACKLIST_MIN_WR * 100).toFixed(0)}% floor · lifetime PnL $${stats.pnl.toFixed(0)}`;
  } catch (e) {
    logger.debug('[PaperTrader] asset-side blacklist lookup failed (non-fatal)', {
      asset, side, error: errMsg(e),
    });
    return null;
  }
}

/** Test hook — force cache invalidation between test cases. */
export function _resetAssetSideBlacklistCache(): void {
  _cache = null;
}
