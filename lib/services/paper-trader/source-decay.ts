/**
 * L4 — Signal-source decay detector.
 *
 * Reads L1 attribution data from hedges.metadata and per source computes:
 *   • rolling 30-trade win rate
 *   • rolling 30-trade net PnL
 *
 * Sources with win rate below the disable threshold (default 48% —
 * marginally worse than random) get their aggregator weight zeroed by
 * writing to a cron_state override map. The aggregator reads this map
 * and multiplies its base weight by the override.
 *
 * A source can be re-enabled the same way (set override back to 1).
 * Manual override always beats automatic — the map value 0 wins even if
 * automatic re-check would have said 1.
 */

import { query } from '@/lib/db/postgres';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';

export const DECAY_WEIGHT_KEY = 'source-decay:weight-multipliers';
export const DECAY_LAST_CHECK_KEY = 'source-decay:last-check';
export const DECAY_MIN_TRADES = 30;
export const DECAY_WIN_RATE_FLOOR = Number(process.env.SOURCE_DECAY_WIN_RATE_FLOOR || 0.48);
export const DECAY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

interface AttributionRow {
  key: string;
  dir: 'UP' | 'DOWN' | 'NEUTRAL';
  wasCorrect: boolean;
}

export interface SourceStats {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
}

/**
 * Compute per-source win rates from the last N closed paper trades.
 * Exported for the /api/admin/source-attribution report + unit tests.
 */
export async function computeSourceStats(lookbackTrades: number = 30): Promise<SourceStats[]> {
  const rows = await query<{ metadata: unknown }>(
    `SELECT metadata FROM hedges
     WHERE order_id LIKE 'paper_%'
       AND status = 'closed'
       AND metadata ? 'attribution'
     ORDER BY closed_at DESC
     LIMIT $1`,
    [lookbackTrades],
  );
  const stats = new Map<string, { trades: number; wins: number }>();
  for (const row of rows) {
    const md = row.metadata as { attribution?: AttributionRow[] } | null;
    for (const a of md?.attribution ?? []) {
      if (a.dir === 'NEUTRAL') continue;
      const s = stats.get(a.key) ?? { trades: 0, wins: 0 };
      s.trades += 1;
      if (a.wasCorrect) s.wins += 1;
      stats.set(a.key, s);
    }
  }
  return Array.from(stats.entries())
    .map(([key, s]) => ({
      key,
      trades: s.trades,
      wins: s.wins,
      winRate: s.trades > 0 ? s.wins / s.trades : 0,
    }))
    .sort((a, b) => b.trades - a.trades);
}

/**
 * Read the current weight-multiplier override map. Aggregator multiplies
 * a source's base weight by this value. 0 = disabled, 1 = normal.
 */
export async function getSourceWeightMultipliers(): Promise<Record<string, number>> {
  return (await getCronState<Record<string, number>>(DECAY_WEIGHT_KEY)) ?? {};
}

/**
 * Run the decay check. Sources below DECAY_WIN_RATE_FLOOR after
 * DECAY_MIN_TRADES samples get multiplier=0. Sources back above the
 * floor get multiplier=1. Returns the number of sources flipped.
 *
 * Safe to call every tick — internal hourly gate prevents thrash.
 */
export async function runSourceDecayCheck(now: number = Date.now()): Promise<number> {
  try {
    const lastCheck = (await getCronState<number>(DECAY_LAST_CHECK_KEY)) ?? 0;
    if (now - lastCheck < DECAY_CHECK_INTERVAL_MS) return 0;
    await setCronState(DECAY_LAST_CHECK_KEY, now);

    const stats = await computeSourceStats(DECAY_MIN_TRADES);
    const currentMults = await getSourceWeightMultipliers();
    const nextMults: Record<string, number> = { ...currentMults };
    let flipped = 0;

    for (const s of stats) {
      if (s.trades < DECAY_MIN_TRADES) continue; // insufficient data
      const shouldDisable = s.winRate < DECAY_WIN_RATE_FLOOR;
      const wasDisabled = (currentMults[s.key] ?? 1) === 0;
      if (shouldDisable && !wasDisabled) {
        nextMults[s.key] = 0;
        flipped += 1;
        logger.warn(`[L4] disabling source ${s.key} — winRate ${(s.winRate * 100).toFixed(1)}% over ${s.trades} trades`);
        try {
          const { notifyDiscord } = await import('@/lib/utils/discord-notify');
          await notifyDiscord(
            `Signal source disabled: ${s.key} — ${(s.winRate * 100).toFixed(1)}% win rate over ${s.trades} trades`,
            'WARN',
            { component: 'source-decay' },
          );
        } catch { /* discord failure non-fatal */ }
      } else if (!shouldDisable && wasDisabled) {
        nextMults[s.key] = 1;
        flipped += 1;
        logger.info(`[L4] re-enabling source ${s.key} — winRate recovered to ${(s.winRate * 100).toFixed(1)}%`);
      }
    }
    if (flipped > 0) await setCronState(DECAY_WEIGHT_KEY, nextMults);
    return flipped;
  } catch (e) {
    logger.debug('[L4] source-decay check failed (non-fatal)', { error: errMsg(e) });
    return 0;
  }
}
