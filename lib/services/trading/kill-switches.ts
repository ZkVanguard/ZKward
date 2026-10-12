/**
 * Pure kill-switch evaluator for the polymarket-edge-trader.
 *
 * Four independent trip conditions:
 *   1. Consecutive losses ≥ MAX_CONSECUTIVE_LOSSES
 *   2. Drawdown from peak ≥ MAX_DRAWDOWN_PCT — but only when the peak
 *      is "meaningful" (see PEAK_FLOOR rationale below). Prevents the
 *      $0.10-win-then-$0.10-loss = "100% drawdown" false trip observed
 *      2026-07-13.
 *   3. Daily realized PnL ≤ DAILY_LOSS_CAP_USD
 *   4. Cumulative loss since the last such halt ≥ CUMULATIVE_LOSS_CAP_USD.
 *      Conditions 1 and 2 arm only after a meaningful profit, and 3 is sized
 *      for one bad day, so a trader that lost a little on every trade from
 *      its first one could not be halted by any of them: 243 trades and
 *      -$22.53 by 2026-10-07 with a best-ever total of +$0.07.
 *
 * Any one trips → halt for HALT_DURATION_MS. The route uses this
 * decision to write cron_state + notify Discord; this module has no
 * side effects so all 6 branches are unit-testable.
 */

export interface KillSwitchStats {
  totalPnlUsd: number;
  peakPnlUsd: number;
  consecutiveLosses: number;
  /** Total P&L when the cumulative-loss halt last fired; 0 before the first. */
  haltAnchorPnlUsd?: number;
}

export interface KillSwitchDaily {
  pnlUsd: number;
}

export interface KillSwitchConfig {
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
  dailyLossCapUsd: number;       // negative number, e.g. -10
  baseStakeUsd: number;          // for computing peak floor
  cumulativeLossCapUsd: number;  // positive number: loss since the last anchor that halts; 0 = off
  haltDurationMs: number;
  now?: number;
}

export type KillReason =
  | 'consecutive-losses'
  | 'drawdown'
  | 'daily-cap'
  | 'cumulative-loss';

export interface KillSwitchDecision {
  /** true if THIS evaluation caused a new halt (fresh trip). */
  trip: boolean;
  /** true if a halt is currently active (this call caused it OR already active). */
  halted: boolean;
  /** Which condition tripped (only set when trip=true). */
  reason?: KillReason;
  /** Detailed reason string suitable for Discord + logs. */
  detail?: string;
  /** Timestamp (ms) until which trading should be halted (only when trip=true). */
  untilMs?: number;
  /** Computed drawdown-from-peak ratio, for observability. */
  drawdownPct: number;
  /** True when peak is above the meaningful-profit floor — for tests. */
  peakMeaningful: boolean;
  /**
   * Set when the cumulative-loss cap is spent: the caller stores it as
   * `haltAnchorPnlUsd`, so the next halt needs a further full cap of losses.
   * That is the release path: after the halt the trader gets a fresh budget.
   */
  newAnchorPnlUsd?: number;
}

/**
 * Pure kill-switch evaluator.
 *
 * @param currentHaltUntilMs Existing halt-until timestamp from cron_state
 *                            (0 or absent = not halted). Used to compute
 *                            `halted` in the no-trip case.
 */
export function evaluateKillSwitch(
  stats: KillSwitchStats,
  daily: KillSwitchDaily,
  currentHaltUntilMs: number,
  config: KillSwitchConfig,
): KillSwitchDecision {
  const now = config.now ?? Date.now();

  const drawdownPct =
    stats.peakPnlUsd > 0 ? (stats.peakPnlUsd - stats.totalPnlUsd) / stats.peakPnlUsd : 0;

  // Absolute-$ floor. At penny-level P&L, every trip condition is dominated
  // by noise: 3 losses of $0.10 each is "MAX_CONSECUTIVE_LOSSES tripped"
  // even though the strategy is fine; $0.10 win then $0.10 loss reads as
  // "100% drawdown". Peak of at least max(2×BASE_STAKE, $5) means we've
  // accumulated real money before the halt logic takes over — below that,
  // the trader is still bootstrapping and short streaks are pure variance.
  //
  // Applied to consecutiveLosses + drawdown. dailyLossCap stays absolute-$
  // (unaffected by peak) since it IS the absolute-$ safety.
  //
  // Observed 2026-07-13 (drawdown false trip on $0.10 pullback) and
  // 2026-08-01 (consecutiveLosses=3 trip on 3 tiny penny losses).
  //
  // Lowered 2026-08-14 from 4×/$10 → 2×/$5 after observing that a strategy
  // losing since day 1 (peak = $0.07 across 28 lifetime trades) can never
  // accumulate enough to arm the guard — kill switch was permanently muted.
  const peakFloor = Math.max(config.baseStakeUsd * 2, 5);
  const peakMeaningful = stats.peakPnlUsd >= peakFloor;

  const tripLosses = stats.consecutiveLosses >= config.maxConsecutiveLosses && peakMeaningful;
  const tripDrawdown = drawdownPct >= config.maxDrawdownPct && peakMeaningful;
  const tripDaily = daily.pnlUsd <= config.dailyLossCapUsd;
  // Measured from an anchor, not from a peak: it needs no profit to arm.
  const lossSinceAnchor = (stats.haltAnchorPnlUsd ?? 0) - stats.totalPnlUsd;
  const tripCumulative = config.cumulativeLossCapUsd > 0 && lossSinceAnchor >= config.cumulativeLossCapUsd;

  if (tripLosses || tripDrawdown || tripDaily || tripCumulative) {
    const untilMs = now + config.haltDurationMs;
    const reason: KillReason = tripLosses
      ? 'consecutive-losses'
      : tripDrawdown
        ? 'drawdown'
        : tripDaily
          ? 'daily-cap'
          : 'cumulative-loss';
    const detail = tripLosses
      ? `consecutiveLosses=${stats.consecutiveLosses}`
      : tripDrawdown
        ? `drawdown=${(drawdownPct * 100).toFixed(1)}%`
        : tripDaily
          ? `dailyPnL=$${daily.pnlUsd.toFixed(2)}`
          : `lost $${lossSinceAnchor.toFixed(2)} since the last halt (cap $${config.cumulativeLossCapUsd.toFixed(2)}), total $${stats.totalPnlUsd.toFixed(2)}`;
    return {
      trip: true, halted: true, reason, detail, untilMs,
      drawdownPct, peakMeaningful,
      // Any halt re-anchors once the cap is spent, whichever condition is reported first.
      ...(tripCumulative ? { newAnchorPnlUsd: stats.totalPnlUsd } : {}),
    };
  }
  return {
    trip: false,
    halted: currentHaltUntilMs > now,
    drawdownPct, peakMeaningful,
  };
}
