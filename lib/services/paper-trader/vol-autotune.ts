/**
 * Per-asset volatility auto-tune. Computes realized volatility from the
 * paper trader's own closed-trade history and caches the resulting
 * multiplier map in cron_state. Sizing uses cached multipliers if fresh
 * (1h TTL), else falls back to the static PAPER_ASSET_VOL_MULT table.
 *
 * Why compute from paper trades instead of external candles:
 *   - Uses the exact same fee/slippage regime the trader experiences
 *   - No external API dependency (no rate limits, no timeouts)
 *   - Naturally adapts if the trader's asset universe changes
 *
 * The vol proxy: standard deviation of return-per-hour across the last
 * PAPER_VOL_TUNE_WINDOW closed trades per asset, normalized so BTC = 1.0.
 * Assets without enough history fall back to the static table.
 */
import { query } from '@/lib/db/postgres';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { PAPER_ASSET_VOL_MULT } from './config';

const CACHE_KEY = 'paper-trader:vol-mults';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PAPER_VOL_TUNE_WINDOW = Number(
  process.env.PAPER_TRADER_VOL_TUNE_WINDOW || 30,
);
const MIN_TRADES_FOR_TUNE = Number(
  process.env.PAPER_TRADER_VOL_TUNE_MIN_TRADES || 10,
);

interface VolCacheEntry {
  mults: Record<string, number>;
  computedAt: number;
}

/**
 * Compute return-per-hour for a single closed trade. Uses gross
 * PnL / notional as the return magnitude (fees already reflect the same
 * trade, so this is a directional-move proxy). Annualized to per-hour
 * so different hold durations are comparable.
 */
function tradeReturnPerHour(row: {
  current_pnl: number | string | null;
  size: number | string;
  entry_price: number | string;
  duration_sec: number | string;
}): number | null {
  const pnl = Number(row.current_pnl ?? 0);
  const size = Number(row.size);
  const entry = Number(row.entry_price);
  const durSec = Number(row.duration_sec);
  const notional = size * entry;
  if (!Number.isFinite(notional) || notional <= 0) return null;
  if (!Number.isFinite(durSec) || durSec <= 0) return null;
  // Return fraction over the hold, then normalize to per-hour.
  const returnFrac = pnl / notional;
  const durHours = durSec / 3600;
  return returnFrac / Math.max(durHours, 0.01);
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute a fresh vol-multiplier map from the last N paper trades per asset.
 * Returns null when no asset has enough history to normalize against BTC.
 */
export async function computeVolMultipliers(): Promise<Record<string, number> | null> {
  try {
    // One query per asset would exhaust Aiven's connection budget. Use a
    // single window-function query that pulls the last N per asset.
    const rows = await query<{
      asset: string;
      current_pnl: string;
      size: string;
      entry_price: string;
      duration_sec: string;
    }>(
      `SELECT asset,
              current_pnl,
              size,
              entry_price,
              EXTRACT(EPOCH FROM (closed_at - created_at)) AS duration_sec
       FROM (
         SELECT h.*, ROW_NUMBER() OVER (PARTITION BY asset ORDER BY closed_at DESC) AS rn
         FROM hedges h
         WHERE h.order_id LIKE 'paper_%' AND h.status = 'closed' AND h.closed_at IS NOT NULL
       ) t
       WHERE rn <= $1`,
      [PAPER_VOL_TUNE_WINDOW],
    );

    // Bucket by asset
    const byAsset = new Map<string, number[]>();
    for (const r of rows) {
      const rph = tradeReturnPerHour(r);
      if (rph === null) continue;
      const arr = byAsset.get(r.asset) ?? [];
      arr.push(rph);
      byAsset.set(r.asset, arr);
    }

    // BTC is the anchor. Need enough history to normalize.
    const btcSeries = byAsset.get('BTC') ?? [];
    if (btcSeries.length < MIN_TRADES_FOR_TUNE) return null;
    const btcVol = stddev(btcSeries);
    if (!Number.isFinite(btcVol) || btcVol <= 0) return null;

    const mults: Record<string, number> = {};
    for (const [asset, series] of byAsset.entries()) {
      if (series.length < MIN_TRADES_FOR_TUNE) continue;
      const assetVol = stddev(series);
      if (!Number.isFinite(assetVol) || assetVol <= 0) continue;
      // BTC vol / asset vol → higher-vol assets get smaller multiplier
      const raw = btcVol / assetVol;
      // Clamp so a very low-sample asset can't dominate.
      mults[asset] = Math.max(0.25, Math.min(2.0, raw));
    }
    if (Object.keys(mults).length === 0) return null;
    return mults;
  } catch (e) {
    logger.warn('[VolAutotune] compute failed', { error: errMsg(e) });
    return null;
  }
}

/**
 * Returns the current vol multiplier for an asset, computing + caching
 * the full map if the cache is stale. Falls back to the static
 * PAPER_ASSET_VOL_MULT table on any error or when insufficient history.
 */
export async function getVolMultiplier(asset: string, now: number = Date.now()): Promise<number> {
  const staticFallback = PAPER_ASSET_VOL_MULT[asset] ?? 1.0;
  try {
    let cached = await getCronState<VolCacheEntry>(CACHE_KEY);
    if (!cached || now - cached.computedAt > CACHE_TTL_MS) {
      const fresh = await computeVolMultipliers();
      if (fresh) {
        cached = { mults: fresh, computedAt: now };
        await setCronState(CACHE_KEY, cached).catch(() => undefined);
        logger.info('[VolAutotune] refreshed multipliers', { mults: fresh });
      } else if (!cached) {
        return staticFallback;
      }
    }
    return cached!.mults[asset] ?? staticFallback;
  } catch (e) {
    logger.debug('[VolAutotune] getVolMultiplier failed, using static', { asset, error: errMsg(e) });
    return staticFallback;
  }
}
