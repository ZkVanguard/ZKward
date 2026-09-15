/**
 * Source calibrator — per-source Bayesian hit-rate learning.
 *
 * ## Why
 *
 * The prediction aggregator combines 5-11 sources per asset (Polymarket
 * 5-min binaries, Delphi markets, Manifold questions, funding rates,
 * cross-asset alignment). Their relative weights are hand-coded guesses
 * — Polymarket at 30%, Delphi at 5-15%, funding at 10%, etc. Nothing
 * adapts when a source turns out to be systematically wrong.
 *
 * This module records per-source hit rates from real outcomes and returns
 * a multiplier that scales each source's weight based on its calibrated
 * accuracy. Fed into PredictionAggregatorService before the final
 * normalization step.
 *
 * ## Storage
 *
 * `cron_state` keys: `trader:source-cal:{normalizedKey}`
 * Local to the Aiven DB. No external endpoints, no telemetry.
 *
 * ## Interaction with probability-calibrator
 *
 * probability-calibrator learns per-(asset, side, confidence-bucket) → win
 * rate for the final AGGREGATED signal. This module learns per-SOURCE
 * → hit rate BEFORE aggregation. They stack: sources get calibrated
 * first, aggregated to a final signal, then that signal's confidence
 * gets re-calibrated for the trader's EV gate.
 */

import { getCronState, getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';

/** Prior "phantom trades" credited to the neutral hit rate before empirical
 *  outcomes take over. Same PRIOR_STRENGTH as probability-calibrator. */
const PRIOR_STRENGTH = 10;
const NEUTRAL_HIT_RATE = 0.5;

/** Clamp multiplier so extreme outliers can't dominate the aggregation. */
const MIN_MULTIPLIER = 0.2;
const MAX_MULTIPLIER = 2.0;

export interface SourceCalibrationBucket {
  n: number;
  wins: number;
  updatedAt: number;
}

/**
 * Reduce a source's display name + type to a stable calibration key.
 * Different sources with the same key share history — so rolling
 * Polymarket 5-min BTC markets (whose titles rotate every 5 min) all
 * accumulate against the same 'polymarket-5min-BTC' bucket.
 */
export function normalizeSourceKey(name: string, type: string = ''): string {
  const lower = (name || '').toLowerCase();

  // "Polymarket 5-Min BTC (synthetic STRONG)" — check BEFORE generic 5-min
  // so the "(synthetic" tail isn't swallowed by the shorter pattern below.
  const p5mSynth = lower.match(/^polymarket 5-min ([a-z]+) \(synthetic/);
  if (p5mSynth) return `polymarket-5min-${p5mSynth[1].toUpperCase()}-synth`;

  // Polymarket 5-min binaries per asset (with optional -ticker variant)
  const p5m = lower.match(/^polymarket 5-min ([a-z]+)(\s*\(ticker\))?/);
  if (p5m) return `polymarket-5min-${p5m[1].toUpperCase()}${p5m[2] ? '-ticker' : ''}`;

  // Delphi ⚡ 5-Min signal per asset (title rotates every 5 min)
  const d5m = lower.match(/delphi.*5-min ([a-z]+) signal/);
  if (d5m) return `delphi-5min-${d5m[1].toUpperCase()}`;

  // Cross-asset alignment (its dominance text varies, key it stably)
  if (lower.includes('cross-asset alignment')) return 'cross-asset-alignment';

  // Funding-rate proxies (Bluefin funding + approximate variants)
  if (lower.includes('funding rate') || lower.includes('funding proxy')) {
    return 'funding-rate';
  }

  // Generic Delphi markets — key by first 40 chars of question slug
  if (lower.startsWith('delphi:')) {
    const q = lower.slice(7).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return `delphi:${q}`;
  }

  // Manifold markets — same pattern
  if (lower.startsWith('manifold:')) {
    const q = lower.slice(9).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return `manifold:${q}`;
  }

  // Fallback — coarse key by type + name-slug head
  const nameSlug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${(type || 'other').toLowerCase()}:${nameSlug}`;
}

function stateKey(sourceKey: string): string {
  return `trader:source-cal:${sourceKey}`;
}

/**
 * Record a source's direction call against the realized outcome.
 * NEUTRAL on either side is treated as "no observation" — we can't
 * label a NEUTRAL prediction as right or wrong against a directional
 * price move.
 */
export async function recordSourceOutcome(input: {
  sourceKey: string;
  sourceDirection: 'UP' | 'DOWN' | 'NEUTRAL';
  actualDirection: 'UP' | 'DOWN' | 'NEUTRAL';
}): Promise<void> {
  if (input.sourceDirection === 'NEUTRAL' || input.actualDirection === 'NEUTRAL') return;
  if (!input.sourceKey) return;
  try {
    const key = stateKey(input.sourceKey);
    const prev = await getCronStateOr<SourceCalibrationBucket>(key, {
      n: 0,
      wins: 0,
      updatedAt: 0,
    });
    const won = input.sourceDirection === input.actualDirection;
    await setCronState(key, {
      n: prev.n + 1,
      wins: prev.wins + (won ? 1 : 0),
      updatedAt: Date.now(),
    });
  } catch (e) {
    logger.warn('[SourceCalibrator] recordSourceOutcome failed (non-critical)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Bayesian-shrunken hit rate for a source key. Returns 0.5 (neutral)
 * when there's no history — so untuned sources fall back to their
 * hand-coded weights unchanged.
 */
export async function getCalibratedHitRate(sourceKey: string): Promise<number> {
  try {
    const bucket = await getCronState<SourceCalibrationBucket>(stateKey(sourceKey));
    if (!bucket || bucket.n === 0) return NEUTRAL_HIT_RATE;
    const empirical = bucket.wins / bucket.n;
    return (bucket.n * empirical + PRIOR_STRENGTH * NEUTRAL_HIT_RATE) / (bucket.n + PRIOR_STRENGTH);
  } catch (e) {
    logger.warn('[SourceCalibrator] getCalibratedHitRate failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return NEUTRAL_HIT_RATE;
  }
}

/**
 * Weight multiplier derived from calibrated hit rate.
 *   0.5 → 1.0 (no change, no data)
 *   0.6 → 1.2 (20% boost)
 *   0.7 → 1.4 (40% boost)
 *   0.4 → 0.8 (20% cut)
 *   0.3 → 0.6 (40% cut)
 * Clamped to [0.2, 2.0] so a single high-variance source can't dominate.
 */
export function hitRateToMultiplier(hitRate: number): number {
  const raw = hitRate / NEUTRAL_HIT_RATE;
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, raw));
}

export async function getCalibratedMultiplier(sourceKey: string): Promise<number> {
  const rate = await getCalibratedHitRate(sourceKey);
  return hitRateToMultiplier(rate);
}

/**
 * Apply calibrated multipliers to a source list, then re-normalize so
 * weights still sum to 1. If total falls to 0 (defensive), fall back to
 * the input list unchanged.
 */
export async function applyCalibrationToSources<
  S extends { name: string; type?: string; weight: number },
>(sources: S[]): Promise<S[]> {
  if (!sources || sources.length === 0) return sources;
  const withMults = await Promise.all(
    sources.map(async (s) => {
      const key = normalizeSourceKey(s.name, s.type ?? '');
      const mult = await getCalibratedMultiplier(key);
      return { ...s, weight: s.weight * mult };
    }),
  );
  const total = withMults.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return sources;
  return withMults.map((s) => ({ ...s, weight: s.weight / total }));
}

// Test-only exports
export {
  PRIOR_STRENGTH as _PRIOR_STRENGTH,
  NEUTRAL_HIT_RATE as _NEUTRAL_HIT_RATE,
  MIN_MULTIPLIER as _MIN_MULTIPLIER,
  MAX_MULTIPLIER as _MAX_MULTIPLIER,
};
