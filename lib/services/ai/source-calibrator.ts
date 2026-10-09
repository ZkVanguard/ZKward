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

import { getCronState, getCronStates, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';

/** Fix H (2026-09-25) — hard-filter mode.
 *
 *  The soft-multiplier approach (Bayesian shrink → weight scaling) still
 *  lets 15+ near-coin-flip sources contribute to every aggregation. When
 *  we averaged 20 sources with hit rates 45-55%, the aggregator output
 *  converged to a coin flip regardless of what any individual source
 *  said. Confidence bucket 60-64 came in at 23.2% win rate (n=56); even
 *  bucket 80-84 was only 23.8% (n=21). Confidence stopped meaning
 *  anything.
 *
 *  Hard filter: once a source has enough data (n >= MIN_TRADES), REMOVE
 *  it entirely from the aggregation if its calibrated hit rate is below
 *  MIN_HIT_RATE. Cold sources (n < MIN_TRADES) still pass through with
 *  Bayesian-shrunk multipliers so new sources can bootstrap.
 *
 *  Tunable so we can back off if the filter starves the aggregator of
 *  data. Off by default; enable via env until we confirm behavior.
 */
const HARD_FILTER_ENABLED = ((process.env.SOURCE_HARD_FILTER_ENABLED || 'true') !== 'false');
const HARD_FILTER_MIN_TRADES = Number(process.env.SOURCE_HARD_FILTER_MIN_TRADES || 20);
const HARD_FILTER_MIN_HIT_RATE = Number(process.env.SOURCE_HARD_FILTER_MIN_HIT_RATE || 0.52);

/** Prior "phantom trades" credited to the neutral hit rate before empirical
 *  outcomes take over.
 *
 *  Was 10 until 2026-09-22. Diagnosis: median source hit rate is
 *  52% ± 5 on live data. With PRIOR=10, a source at 30% over 20 real
 *  trades only shrinks to 0.37 → weight × 0.73. Chronically-losing
 *  sources kept contributing to signals. Aggregating 15 near-random
 *  sources converges to 50% predictor by CLT — matching the observed
 *  44-55% paper win rate.
 *
 *  Lowered to 5 so 20+ real trades meaningfully shift the multiplier
 *  toward empirical. Trade-off: more variance on very-thin sources
 *  (< 5 trades), but those get MIN_MULTIPLIER floor.
 */
const PRIOR_STRENGTH = Number(process.env.SOURCE_CALIBRATOR_PRIOR || 5);
const NEUTRAL_HIT_RATE = 0.5;

/** Hard cutoff — sources at < KILL_THRESHOLD hit rate with >= KILL_MIN_TRADES
 *  data get their weight multiplier floored near zero. Complements
 *  source-decay's binary disable but fires 2× faster (15 vs 30 min trades). */
const KILL_THRESHOLD = Number(process.env.SOURCE_CALIBRATOR_KILL_THRESHOLD || 0.40);
const KILL_MIN_TRADES = Number(process.env.SOURCE_CALIBRATOR_KILL_MIN_TRADES || 15);
const KILL_MULTIPLIER = 0.05;

/** Clamp multiplier so extreme outliers can't dominate the aggregation. */
const MIN_MULTIPLIER = 0.2;
const MAX_MULTIPLIER = 2.0;

/** Buckets from an older epoch are ignored and restart on their next write.
 *  2026-09-30: every market-question source changed meaning (odds instead of
 *  wording), so 84 buckets / 1,653 observations measured a signal that no
 *  longer exists. A lazy reset needs no delete and nothing stays stale. */
export const CALIBRATION_EPOCH = (process.env.SOURCE_CALIBRATOR_EPOCH || '2026-09-30').trim();

/** Ledger cells (signal_outcomes) outrank per-trade buckets: thousands of
 *  fixed-horizon resolutions vs tens of trades. A source whose timing is
 *  measured wrong-way is removed for that asset; one measured right gets
 *  this multiplier; everything else keeps its base weight. */
const LEDGER_PROVEN_MULTIPLIER = Number(process.env.SOURCE_LEDGER_PROVEN_MULTIPLIER || 1.5);

export interface SourceCalibrationBucket {
  n: number;
  wins: number;
  updatedAt: number;
  epoch?: string;
}

const liveBucket = (b: SourceCalibrationBucket | null | undefined): SourceCalibrationBucket | null =>
  b && b.epoch === CALIBRATION_EPOCH ? b : null;

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
    return `delphi:${slugify(lower.slice(7))}`;
  }

  // Manifold markets — same pattern
  if (lower.startsWith('manifold:')) {
    return `manifold:${slugify(lower.slice(9))}`;
  }

  // Fallback — coarse key by type + name-slug head
  return `${(type || 'other').toLowerCase()}:${slugify(lower)}`;
}

/**
 * Slug for calibration keys, with volatile numeric tails stripped so a
 * market whose title embeds a live price doesn't fragment into a fresh
 * bucket on every price change. Observed 2026-09-27: 'will-bitcoin-
 * reach-100k-currently-81/-76/-84/-86' each accumulated separately and
 * none reached the Fix-H hard-filter n=20 despite 152 combined
 * observations at ~40% hit rate — fragmentation was defeating the
 * dead-source filter.
 */
function slugify(raw: string): string {
  return raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/currently-[0-9]+(-[0-9]+)*/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
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
    const prev = liveBucket(await getCronState<SourceCalibrationBucket>(key)) ?? { n: 0, wins: 0, updatedAt: 0 };
    const won = input.sourceDirection === input.actualDirection;
    await setCronState(key, {
      n: prev.n + 1,
      wins: prev.wins + (won ? 1 : 0),
      updatedAt: Date.now(),
      epoch: CALIBRATION_EPOCH,
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
function hitRateFromBucket(bucket: SourceCalibrationBucket | null): number {
  if (!bucket || bucket.n === 0) return NEUTRAL_HIT_RATE;
  const empirical = bucket.wins / bucket.n;
  return (bucket.n * empirical + PRIOR_STRENGTH * NEUTRAL_HIT_RATE) / (bucket.n + PRIOR_STRENGTH);
}

export async function getCalibratedHitRate(sourceKey: string): Promise<number> {
  try {
    return hitRateFromBucket(liveBucket(await getCronState<SourceCalibrationBucket>(stateKey(sourceKey))));
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

function multiplierFromBucket(bucket: SourceCalibrationBucket | null): number {
  // Hard-cut chronically-bad sources. Bayesian shrinkage was too soft
  // (a 30% source over 20 trades still contributed 0.73× weight); this
  // kills them explicitly when the empirical evidence is strong enough.
  if (bucket && bucket.n >= KILL_MIN_TRADES && bucket.wins / bucket.n < KILL_THRESHOLD) return KILL_MULTIPLIER;
  return hitRateToMultiplier(hitRateFromBucket(bucket));
}

export async function getCalibratedMultiplier(sourceKey: string): Promise<number> {
  try {
    return multiplierFromBucket(liveBucket(await getCronState<SourceCalibrationBucket>(stateKey(sourceKey))));
  } catch {
    return hitRateToMultiplier(NEUTRAL_HIT_RATE);
  }
}

/**
 * Fix H — hard-filter check. Returns true if this source has ENOUGH DATA
 * (n >= HARD_FILTER_MIN_TRADES) AND its empirical hit rate is BELOW the
 * accept threshold — meaning the source should be REMOVED from
 * aggregation entirely, not just weight-shrunk.
 *
 * Cold sources (insufficient data) return false so they can bootstrap.
 */
function hardFilterFromBucket(bucket: SourceCalibrationBucket | null): boolean {
  if (!HARD_FILTER_ENABLED || !bucket || bucket.n < HARD_FILTER_MIN_TRADES) return false;
  return bucket.wins / bucket.n < HARD_FILTER_MIN_HIT_RATE;
}

export async function shouldHardFilterSource(sourceKey: string): Promise<boolean> {
  if (!HARD_FILTER_ENABLED) return false;
  try {
    return hardFilterFromBucket(liveBucket(await getCronState<SourceCalibrationBucket>(stateKey(sourceKey))));
  } catch {
    return false; // fail-open — if calibration read errors, keep source
  }
}

/**
 * Apply calibrated multipliers to a source list, then re-normalize so
 * weights still sum to 1. If total falls to 0 (defensive), fall back to
 * the input list unchanged.
 */
export async function applyCalibrationToSources<
  S extends { name: string; type?: string; weight: number },
>(sources: S[], opts: { asset?: string; horizonMin?: number } = {}): Promise<S[]> {
  if (!sources || sources.length === 0) return sources;
  // L4 — signal-decay auto-disable. Reads the multiplier map written by
  // paper-trader/source-decay.ts. A source explicitly zeroed by decay
  // stays zero even after Bayesian shrinkage kicks it back toward 0.5:
  // decay is a hard kill, calibrator is a soft weight.
  // The decay map and every source's bucket in one round trip (each source
  // used to read its bucket three times, one query each).
  const DECAY_KEY = 'source-decay:weight-multipliers';
  const sourceKeys = sources.map((s) => normalizeSourceKey(s.name, s.type ?? ''));
  const stored = await getCronStates<unknown>([DECAY_KEY, ...sourceKeys.map(stateKey)]);
  const decayMults = (stored.get(DECAY_KEY) as Record<string, number> | undefined) ?? {};
  const bucketOf = (key: string) => liveBucket(stored.get(stateKey(key)) as SourceCalibrationBucket | undefined);

  // Ledger cells for this asset at the trading horizon (when known).
  const ledgerMult = new Map<string, number>();
  const ledgerKill = new Set<string>();
  if (opts.asset) {
    try {
      const { getLedgerCells, findCell, timingVerdict } = await import('@/lib/services/market-data/ledger-cells');
      const cells = await getLedgerCells();
      const horizon = opts.horizonMin ?? 60;
      for (const s of sources) {
        const key = normalizeSourceKey(s.name, s.type ?? '');
        const cell = findCell(cells, key, opts.asset, horizon);
        if (!cell) continue;
        const verdict = timingVerdict(cell);
        if (verdict === 'wrong-way') ledgerKill.add(key);
        else ledgerMult.set(key, verdict === 'proven' ? LEDGER_PROVEN_MULTIPLIER : 1);
      }
    } catch (e) {
      logger.debug('[SourceCalibrator] ledger cells unavailable (per-trade buckets only)', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Hard-filter pass first: a ledger-measured loser, or (Fix H) a source
  // with n >= MIN_TRADES of trade outcomes below MIN_HIT_RATE, is REMOVED
  // entirely, not down-weighted.
  const skipFlags: boolean[] = sources.map((s) => {
    const key = normalizeSourceKey(s.name, s.type ?? '');
    return ledgerKill.has(key) || hardFilterFromBucket(bucketOf(key));
  });
  const survivors: S[] = sources.filter((_, i) => !skipFlags[i]);
  // Defensive floor — never leave the aggregator with < 2 sources.
  // If we filtered too aggressively, fall back to the unfiltered set
  // so we don't produce degenerate predictions.
  const filteredSources: S[] = survivors.length >= 2 ? survivors : sources;

  const withMults = filteredSources.map((s) => {
    const key = normalizeSourceKey(s.name, s.type ?? '');
    const measured = ledgerMult.get(key) ?? multiplierFromBucket(bucketOf(key));
    const decay = decayMults[key] ?? 1;
    return { ...s, weight: s.weight * measured * decay };
  });
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
