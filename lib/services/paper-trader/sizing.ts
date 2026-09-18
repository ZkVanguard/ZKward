/**
 * Paper trader — sizing math primitives.
 *
 * Pure functions that turn signal metadata into stake/hold parameters.
 * No I/O other than the source-calibrator lookup in computeCalibrationBoost.
 * Extracted from PaperTrader.ts to keep the trader file focused on
 * orchestration and to give sizing math a stable unit-test seam.
 */

import { logger } from '@/lib/utils/logger';
import {
  normalizeSourceKey,
  getCalibratedMultiplier,
} from '@/lib/services/ai/source-calibrator';
import { PAPER_MAX_HOLD_MIN, PAPER_MAX_HOLD_EXTRA_MIN } from './config';

/**
 * Confidence-weighted stake scalar. Rides the 55-100 confidence range and
 * the 50-100 consensus range, averaged to a single scalar in [0.4, 2.0].
 * Ensures a min-gate 55/50 signal gets 0.4× nominal (skin in the game) and
 * a 100/100 exceptional signal gets 2× nominal.
 */
export function computeSignalScalar(confidence: number, consensus: number): number {
  const confN = Math.max(0, Math.min(1, (confidence - 55) / 45));
  const consN = Math.max(0, Math.min(1, (consensus - 50) / 50));
  const avg = (confN + consN) / 2;
  return 0.4 + avg * 1.6;
}

/**
 * Signal-strength-scaled max-hold minutes. Weak signals close at the base
 * PAPER_MAX_HOLD_MIN. Strong signals earn extra time (up to
 * PAPER_MAX_HOLD_EXTRA_MIN extra) so moves develop past fees. Uses the
 * same signalScalar as sizing so a signal that gets a bigger position
 * also gets a longer window.
 */
export function computeMaxHoldMinutes(signalScalar: number): number {
  const capped = Math.max(0.4, Math.min(2.0, signalScalar));
  const bonusRatio = (capped - 0.4) / 1.6; // 0.0 at min gate, 1.0 at max
  return PAPER_MAX_HOLD_MIN + bonusRatio * PAPER_MAX_HOLD_EXTRA_MIN;
}

/**
 * Weighted-average calibrated multiplier across the signal's sources.
 * Reads the per-source Bayesian hit-rate from source-calibrator (fed by
 * recordSourceOutcome at close). Returns a stake scalar in [0.5, 1.5]:
 *   1.0 = neutral (no data or 50% hit rates)
 *   1.5 = signals dominated by 65%+ hit-rate sources → boost size
 *   0.5 = signals dominated by 35%- hit-rate sources → shrink size
 *
 * Clamped tighter than the raw source-calibrator range [0.2, 2.0] so
 * calibration modulates but never dominates the sizing math — one
 * outlier source with sparse data can't 4x the position.
 */
export async function computeCalibrationBoost(
  sources: Array<{ name: string; type?: string; weight: number }>,
): Promise<number> {
  if (!sources || sources.length === 0) return 1.0;
  try {
    const weighted = await Promise.all(
      sources.map(async (s) => {
        const key = normalizeSourceKey(s.name, s.type ?? '');
        const mult = await getCalibratedMultiplier(key);
        return { mult, weight: Math.max(0, s.weight) };
      }),
    );
    const totalWeight = weighted.reduce((a, b) => a + b.weight, 0);
    if (totalWeight <= 0) return 1.0;
    const raw = weighted.reduce((a, b) => a + b.mult * b.weight, 0) / totalWeight;
    return Math.max(0.5, Math.min(1.5, raw));
  } catch (e) {
    logger.debug('[PaperTrader] calibration boost failed (defaulting to 1.0)', {
      error: e instanceof Error ? e.message : String(e),
    });
    return 1.0;
  }
}
