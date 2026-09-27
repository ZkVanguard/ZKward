/**
 * Probability calibrator — Bayesian-shrinkage over historical (asset,
 * side, confidence-bucket) → actual-win-rate.
 *
 * ## Why
 *
 * The signal aggregator's raw `confidence` number turns out to be a poor
 * predictor of actual outcomes. Historical audit (2026-08-28, 22 real
 * trades) showed:
 *   conf 60-70 bucket:   100% actual win rate (n=4)
 *   conf 70-80 bucket:    12% actual win rate (n=17)
 *
 * Raw confidence has NO monotonic relationship with realized outcomes in
 * the high-conf tail — it's actually inverted. Feeding raw confidence
 * into the EV gate produced trades the model was sure would win but
 * that lost 87% of the time.
 *
 * ## What this module does
 *
 * On trade close: recordOutcome() writes a per-bucket (predicted, wins)
 * count to cron_state under `trader:calibration:{asset}:{side}:{decile}`.
 *
 * On trade open: calibrate() reads that bucket's history and returns a
 * Bayesian-shrunken probability:
 *
 *   p_out = (n_bucket * p_actual + PRIOR * p_raw) / (n_bucket + PRIOR)
 *
 * When we have zero history for a bucket, p_out == p_raw (fall back to
 * the raw signal). When we have many observations, p_out converges to
 * the historically-realized rate. PRIOR=10 gives raw confidence full
 * weight until we've seen ~10 trades in that bucket — small-sample
 * safe, big-sample data-driven.
 *
 * Fed into the EV gate INSTEAD OF prediction.confidence/100, this
 * closes the biggest known PnL leak.
 */

import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';

/** Prior strength — how many "phantom trades" we credit to the raw
 *  signal before empirical outcomes take over. 10 = raw signal dominant
 *  until ~10 real trades land in a bucket. */
const PRIOR_STRENGTH = 10;

/** Decile buckets: 0-9, 10-19, 20-29, ..., 90-100. */
function bucketFor(confidencePct: number): number {
  return Math.max(0, Math.min(9, Math.floor(confidencePct / 10)));
}

interface CalibrationBucket {
  n: number;      // number of observations
  wins: number;   // number of positive-PnL outcomes
  updatedAt: number;
}

// Optional namespace isolates trader populations. Paper passes 'paper' so
// its buckets aren't polluted by (and don't pollute) live-trader history —
// 2026-09-27 forensics found the shared SOL:LONG:7 bucket claiming 61% wr
// (n=149, epochs back to Sep 2) while post-reset paper SOL LONG ran 29%,
// so Fix K was actively ranking a bleeding pair to the top.
function keyFor(asset: string, side: 'LONG' | 'SHORT', bucket: number, namespace?: string): string {
  return namespace
    ? `trader:calibration:${namespace}:${asset}:${side}:${bucket}`
    : `trader:calibration:${asset}:${side}:${bucket}`;
}

/**
 * Record a trade outcome. Called from applyOutcome (state-transitions.ts)
 * or reconcile-active-trade branches when a trade closes with a realized
 * PnL. Non-critical — never throws.
 */
export async function recordOutcome(input: {
  asset: string;
  side: 'LONG' | 'SHORT';
  openConfidencePct: number;
  realizedPnl: number;
  namespace?: string;
}): Promise<void> {
  try {
    const b = bucketFor(input.openConfidencePct);
    const key = keyFor(input.asset, input.side, b, input.namespace);
    const prev = await getCronStateOr<CalibrationBucket>(key, {
      n: 0,
      wins: 0,
      updatedAt: 0,
    });
    const next: CalibrationBucket = {
      n: prev.n + 1,
      wins: prev.wins + (input.realizedPnl > 0 ? 1 : 0),
      updatedAt: Date.now(),
    };
    await setCronState(key, next);
  } catch (e) {
    logger.warn('[Calibrator] recordOutcome failed (non-critical)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Bayesian-shrunken probability estimate for a (asset, side, conf)
 * combination. Returns a value in [0, 1].
 *
 * When there's no history: returns rawConfidencePct/100 exactly.
 * When there's history: shrinks toward the empirical win rate.
 */
export async function calibrate(input: {
  asset: string;
  side: 'LONG' | 'SHORT';
  rawConfidencePct: number;
  namespace?: string;
}): Promise<{ pCalibrated: number; pRaw: number; nHistory: number; empiricalWinRate: number | null }> {
  const pRaw = Math.max(0, Math.min(1, input.rawConfidencePct / 100));
  try {
    const b = bucketFor(input.rawConfidencePct);
    const key = keyFor(input.asset, input.side, b, input.namespace);
    const bucket = await getCronStateOr<CalibrationBucket>(key, { n: 0, wins: 0, updatedAt: 0 });
    if (bucket.n === 0) {
      return { pCalibrated: pRaw, pRaw, nHistory: 0, empiricalWinRate: null };
    }
    const pEmpirical = bucket.wins / bucket.n;
    // Bayesian shrinkage — see module doc.
    const pCalibrated = (bucket.n * pEmpirical + PRIOR_STRENGTH * pRaw) / (bucket.n + PRIOR_STRENGTH);
    return {
      pCalibrated: Math.max(0.001, Math.min(0.999, pCalibrated)),
      pRaw,
      nHistory: bucket.n,
      empiricalWinRate: pEmpirical,
    };
  } catch (e) {
    logger.warn('[Calibrator] calibrate failed — falling back to raw (non-critical)', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { pCalibrated: pRaw, pRaw, nHistory: 0, empiricalWinRate: null };
  }
}

/** Export bucket function for tests + debug tooling. */
export { bucketFor as _bucketFor, PRIOR_STRENGTH as _PRIOR_STRENGTH };
