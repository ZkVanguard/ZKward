/**
 * Signal-quality filters for the paper trader.
 *
 * Diagnosed 2026-09-18: PredictionAggregatorService.scanAndPickBest
 * returns HEDGE_LONG with 22% win rate — the weighted-direction math
 * lets a few high-confidence sources override the majority. Live snapshot
 * showed ETH aggregate=UP while 4 of 7 sources said DOWN.
 *
 * This module adds two safeguards on TOP of the aggregate. Both must
 * pass before an open goes through:
 *
 *   1. majorityAgreement — count sources that align with aggregate
 *      direction. Reject if under PAPER_MIN_MAJORITY_PCT.
 *
 *   2. isSignalStable — read a rolling history of the last K
 *      recommendations per asset. Require the aggregate to have
 *      called the same direction for PAPER_MIN_STABLE_TICKS ticks.
 *      Kills 9-min flip-flop closes.
 *
 * History is stored in cron_state under KEY_SIGNAL_HISTORY as a
 * { [asset]: { direction, at }[] } map trimmed to 10 entries per asset.
 * The paper trader records new signals every tick and gates opens on it.
 */
import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import {
  KEY_SIGNAL_HISTORY,
  PAPER_MIN_MAJORITY_PCT,
  PAPER_MIN_STABLE_TICKS,
} from './config';

export interface SignalHistoryEntry {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  at: number;
}
export type SignalHistoryMap = Record<string, SignalHistoryEntry[]>;

const MAX_HISTORY_PER_ASSET = 10;

/**
 * Percentage of sources that voted the same direction as `direction`.
 * Returns 0 for empty/no-direction cases. Used at entry to reject
 * signals where the majority of underlying sources disagreed with
 * the aggregated recommendation.
 */
export function majorityAgreementPct(
  direction: 'UP' | 'DOWN' | 'NEUTRAL',
  sources: Array<{ direction?: string }>,
): number {
  if (!sources || sources.length === 0) return 0;
  if (direction === 'NEUTRAL') return 0;
  const agree = sources.filter((s) => s.direction === direction).length;
  return agree / sources.length;
}

/**
 * Append the latest signal call for an asset to the rolling history.
 * Trims the per-asset list to MAX_HISTORY_PER_ASSET. Idempotent on the
 * same-tick call because we key on wall time, not tick sequence — if a
 * tick fires twice within a second we get duplicate entries which is
 * fine for the "last K" check.
 */
export async function appendSignalHistory(
  asset: string,
  direction: 'UP' | 'DOWN' | 'NEUTRAL',
  now: number = Date.now(),
): Promise<void> {
  try {
    const map = await getCronStateOr<SignalHistoryMap>(KEY_SIGNAL_HISTORY, {});
    const arr = map[asset] ?? [];
    arr.push({ direction, at: now });
    map[asset] = arr.slice(-MAX_HISTORY_PER_ASSET);
    await setCronState(KEY_SIGNAL_HISTORY, map);
  } catch (e) {
    logger.debug('[SignalQuality] appendSignalHistory failed (non-critical)', {
      asset,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Check whether the aggregate has held the same direction for at least
 * PAPER_MIN_STABLE_TICKS entries in a row for this asset. Returns:
 *   { stable: true } — safe to open
 *   { stable: false, reason } — reject with the reason
 *
 * Returns stable=true for direction=NEUTRAL because the paper trader's
 * own recommendationToSide gate already blocks non-directional opens.
 * Also returns stable=true when history is shorter than the required
 * window — new assets need a warm-up tick or two before the filter is
 * meaningful, and we don't want the filter to permanently reject an
 * asset the trader has never traded.
 */
export async function isSignalStable(
  asset: string,
  direction: 'UP' | 'DOWN' | 'NEUTRAL',
): Promise<{ stable: boolean; reason?: string }> {
  if (direction === 'NEUTRAL') return { stable: true };
  try {
    const map = await getCronStateOr<SignalHistoryMap>(KEY_SIGNAL_HISTORY, {});
    const history = map[asset] ?? [];
    if (history.length < PAPER_MIN_STABLE_TICKS) {
      // Warm-up: not enough history to judge. Let it open — the tick
      // that opens will append its own entry, so subsequent opens will
      // be gated normally.
      return { stable: true };
    }
    const window = history.slice(-PAPER_MIN_STABLE_TICKS);
    const allMatch = window.every((h) => h.direction === direction);
    if (allMatch) return { stable: true };
    const flips = window.filter((h) => h.direction !== direction).length;
    return {
      stable: false,
      reason: `signal-flip in last ${PAPER_MIN_STABLE_TICKS} ticks (${flips} disagreements)`,
    };
  } catch (e) {
    logger.debug('[SignalQuality] isSignalStable failed (defaulting to stable)', {
      asset,
      error: e instanceof Error ? e.message : String(e),
    });
    return { stable: true };
  }
}

/**
 * Compose both filters into a single gate.
 */
export async function signalQualityRejection(
  asset: string,
  aggregateDirection: 'UP' | 'DOWN' | 'NEUTRAL',
  sources: Array<{ direction?: string }>,
): Promise<string | null> {
  // Majority-agreement — the killer filter for the 22% win rate.
  const pct = majorityAgreementPct(aggregateDirection, sources);
  if (pct < PAPER_MIN_MAJORITY_PCT) {
    return `majority ${(pct * 100).toFixed(0)}% agree with ${aggregateDirection} (need ${(PAPER_MIN_MAJORITY_PCT * 100).toFixed(0)}%)`;
  }
  // Stability — kills the 9-min flip-flop pattern.
  const stability = await isSignalStable(asset, aggregateDirection);
  if (!stability.stable) return stability.reason ?? 'unstable';
  return null;
}
