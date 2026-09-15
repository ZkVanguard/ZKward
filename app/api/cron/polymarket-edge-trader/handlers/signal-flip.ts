/**
 * Pure signal-flip decision — extracted so the confidence gate can be unit tested.
 *
 * Trader re-scans predictions every tick. Without a confidence gate, a noisy
 * 5-min binary market (Polymarket "BTC up/down in 5 min") produces spurious
 * demotions (HEDGE_SHORT → LIGHT_HEDGE_SHORT) and direction flips at 40-55%
 * confidence — each one closes the trade at ~$0 realized and pays a
 * round-trip fee. This mirrors the SIGNAL_FLIP_MIN_CONF pattern the
 * agent-signal-tick cron adopted 2026-08-04.
 */
import type { AggregatedPrediction } from '@/lib/services/market-data/PredictionAggregatorService';
import type { ActiveTrade } from '@/lib/services/trading/active-trade';
import { recommendationToSide, isActionable } from './trader-utils';

export interface SignalFlipInput {
  active: Pick<ActiveTrade, 'side' | 'entryScore'>;
  livePred: Pick<AggregatedPrediction, 'recommendation' | 'confidence'>;
  liveScore: number;
  minConfidence: number;
  scoreCollapseRatio: number;
}

/**
 * Returns a non-empty reason string when the trade should exit on signal flip,
 * null otherwise. The three exit conditions all require the *new* signal to
 * meet `minConfidence` — a low-conf re-scan is noise, not a flip.
 */
export function evaluateSignalFlip(input: SignalFlipInput): string | null {
  const { active, livePred, liveScore, minConfidence, scoreCollapseRatio } = input;

  // Confidence gate: a low-confidence re-scan of a noisy 5-min binary
  // market isn't a real signal change. Treat as no-op, hold the trade.
  if ((livePred.confidence ?? 0) < minConfidence) return null;

  const liveSide = recommendationToSide(livePred.recommendation);
  if (liveSide !== active.side) {
    return `recommendation flipped: ${livePred.recommendation}`;
  }
  if (!isActionable(livePred.recommendation)) {
    return `recommendation demoted to ${livePred.recommendation}`;
  }
  if (liveScore < active.entryScore * scoreCollapseRatio) {
    return `score collapsed ${active.entryScore.toFixed(0)} → ${liveScore.toFixed(0)} (< ${(scoreCollapseRatio * 100).toFixed(0)}% threshold)`;
  }
  return null;
}
