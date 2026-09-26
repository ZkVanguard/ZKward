/**
 * Paper trader — handleEntry helpers.
 *
 * Extracted from the 326-LOC handleEntry in PaperTrader.ts (2026-09-18)
 * so each phase becomes independently testable. Split by responsibility:
 *
 *   selectCandidate — signal scan → rank → filter → pick winner.
 *                     No DB writes, no side effects except signal-history
 *                     append (which we WANT to happen even on skip).
 *
 *   priceCandidate  — multi-source price validation. Returns markPrice
 *                     or a skip reason string.
 *
 *   sizeCandidate   — Kelly-scalar × vol-mult × source-calibration →
 *                     notionalUsd. Pure math over the picked candidate.
 *
 * handleEntry itself is now a coordinator: risk-gates → select → price →
 * size → persist. Every helper returns either a success shape OR a skip
 * reason, never both. Errors bubble as thrown exceptions the caller
 * handles.
 */
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import {
  PredictionAggregatorService,
  type AggregatedPrediction,
} from '@/lib/services/market-data/PredictionAggregatorService';
import {
  PAPER_UNIVERSE,
  PAPER_MIN_CONFIDENCE,
  PAPER_MIN_CONSENSUS,
  PAPER_MIN_SOURCES,
  PAPER_STAKE_PCT,
  PAPER_LEVERAGE,
  PAPER_SKIP_STRONG_SIGNALS,
  PAPER_CALIBRATED_MIN_WIN_RATE,
  PAPER_CALIBRATED_RANK_MIN_N,
} from './config';
import type { Side } from './simulated-executor';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';
import { computeSignalScalar, computeCalibrationBoost } from './sizing';
import { getVolMultiplier } from './vol-autotune';
import {
  signalQualityRejection,
  appendSignalHistory,
} from './signal-quality';

// ── Types ────────────────────────────────────────────────────────────

export interface PickedCandidate {
  asset: string;
  prediction: AggregatedPrediction;
  score: number;
  side: Side;
}

export type SelectResult =
  | { ok: true; picked: PickedCandidate }
  | { ok: false; reason: string };

export type PriceResult =
  | { ok: true; markPrice: number }
  | { ok: false; reason: string };

export interface SizeResult {
  notionalUsd: number;
  stakeUsd: number;
  signalScalar: number;
  volMult: number;
  calibrationBoost: number;
}

export interface ConcurrencyFilter {
  activeAssets: string[];
  rejectionReason: (asset: string, side: Side) => string | null;
}

/**
 * Optional post-selection async gate. Runs INSIDE the ranked-candidate
 * loop so a rejection on the top pick lets the loop try the next-best
 * candidate instead of aborting the whole tick. Return `null` to accept
 * or a rejection reason string to skip this candidate and continue.
 *
 * Used by PaperTrader to plug in the streak-guard / trend-alignment /
 * vol-gate / regret-cooldown checks that were previously ran AFTER
 * selection — meaning BTC failing streak would abort the tick even
 * though SOL would have been a valid trade.
 */
export type ExtraCandidateGate = (
  asset: string,
  side: Side,
  now: number,
) => Promise<string | null>;

// ── selectCandidate ──────────────────────────────────────────────────

const recommendationToSide = (rec: string): Side | null => {
  if (rec.includes('LONG')) return 'LONG';
  if (rec.includes('SHORT')) return 'SHORT';
  return null;
};

/**
 * Signal scan + candidate ranking + filter chain. Returns the highest-
 * scoring candidate that survives every filter, or a skip reason.
 *
 * Filter order per candidate: recommendationToSide → skip-STRONG →
 * signal-quality (majority + stability) → concurrency (dedup + cluster).
 *
 * The signal-history append happens for the winning candidate so future
 * ticks have data for the stability filter — but only for the winner
 * to keep history bounded per asset.
 */
export async function selectCandidate(
  now: number,
  concurrencyFilter?: ConcurrencyFilter,
  extraGate?: ExtraCandidateGate,
): Promise<SelectResult> {
  // Regime-scale the entry conf gate: CHOP tightens 1.05× (55 → 58),
  // TREND relaxes 0.95× (55 → 52). minConfidenceMult was dead until
  // 2026-09-22.
  let effectiveMinConf = PAPER_MIN_CONFIDENCE;
  try {
    const { getCurrentRegime, getRegimeMultipliers } = await import('./regime');
    const { regime } = await getCurrentRegime(now);
    const regMults = getRegimeMultipliers(regime);
    effectiveMinConf = PAPER_MIN_CONFIDENCE * regMults.minConfidenceMult;
  } catch { /* fall back to static */ }

  let scan: Awaited<ReturnType<typeof PredictionAggregatorService.scanAndPickBest>>;
  try {
    scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
      minConfidence: effectiveMinConf,
      minConsensus: PAPER_MIN_CONSENSUS,
      minSources: PAPER_MIN_SOURCES,
    });
  } catch (e) {
    return { ok: false, reason: `scan failed: ${errMsg(e)}` };
  }
  if (!scan.best) {
    logger.warn('[PaperTrader] scan.best null — no asset met gates', {
      min: { conf: effectiveMinConf, cons: PAPER_MIN_CONSENSUS, sources: PAPER_MIN_SOURCES },
      universeSize: PAPER_UNIVERSE.length,
    });
    return { ok: false, reason: 'no edge above gates' };
  }

  // L6 — Multi-armed bandit multiplier on the candidate score. Historically
  // profitable (asset, side) arms get their score boosted, chronic losers
  // suppressed. Cold-start arms (<3 trades) return neutral 1.0 so the
  // regular signal picker still gets to explore.
  const { getArmMultiplier } = await import('./bandit');
  const { calibrate } = await import('@/lib/services/ai/probability-calibrator');

  // Fix K (2026-09-26) — rank candidates by CALIBRATED empirical win rate
  // (fee-adjusted), not raw aggregator score. Historical audit showed raw
  // confidence has no monotonic relationship with actual win rate:
  //   raw 60-64 conf → 23.2% wr, raw 70-74 → 38.4% wr, raw 80-84 → 23.8% wr.
  // The old code ranked by raw score, then GATED at pCalibrated < 0.50.
  // That preferred high-raw-conf/low-actual-win over low-raw-conf/high-
  // actual-win. Now: precompute calibrated prob per candidate, USE it as
  // the rank key, and gate at the fee-adjusted threshold (default 0.53).
  // Falls back to raw score when the (asset, side, bucket) has < min-N
  // data — bootstrap window before empirical dominates.
  const rankedCandidates: Array<{
    asset: string;
    prediction: AggregatedPrediction;
    score: number;
    calibratedProb: number | null;
    calibrationN: number;
  }> = [];
  if (concurrencyFilter) {
    for (const [candidateAsset, pred] of Object.entries(scan.all)) {
      if (pred.confidence < effectiveMinConf) continue;
      if (pred.consensus < PAPER_MIN_CONSENSUS) continue;
      if (pred.sources.length < PAPER_MIN_SOURCES) continue;
      const rawScore = PredictionAggregatorService.scoreOpportunity(pred);
      if (rawScore <= 0) continue;
      const side = recommendationToSide(pred.recommendation);
      const armMult = side ? await getArmMultiplier(candidateAsset, side).catch(() => 1) : 1;
      // Calibrated probability lookup — cheap cron_state read.
      let calibratedProb: number | null = null;
      let calibrationN = 0;
      if (side) {
        try {
          const cal = await calibrate({ asset: candidateAsset, side, rawConfidencePct: pred.confidence });
          calibratedProb = cal.pCalibrated;
          calibrationN = cal.nHistory;
        } catch { /* fall back to raw */ }
      }
      // Rank score: when we have real data, use calibrated prob × 100 so
      // it competes on the same numeric scale as raw score. Multiply by
      // bandit arm boost so historically-profitable arms still bubble up.
      const rankScore = calibratedProb !== null && calibrationN >= PAPER_CALIBRATED_RANK_MIN_N
        ? calibratedProb * 100 * armMult
        : rawScore * armMult;
      rankedCandidates.push({ asset: candidateAsset, prediction: pred, score: rankScore, calibratedProb, calibrationN });
    }
    rankedCandidates.sort((a, b) => b.score - a.score);
  } else {
    // Legacy path: apply bandit boost to scan.best too so both paths agree.
    const side = recommendationToSide(scan.best.prediction.recommendation);
    const armMult = side ? await getArmMultiplier(scan.best.asset, side).catch(() => 1) : 1;
    let calibratedProb: number | null = null;
    let calibrationN = 0;
    if (side) {
      try {
        const cal = await calibrate({ asset: scan.best.asset, side, rawConfidencePct: scan.best.prediction.confidence });
        calibratedProb = cal.pCalibrated;
        calibrationN = cal.nHistory;
      } catch { /* fall back to raw */ }
    }
    rankedCandidates.push({ ...scan.best, score: scan.best.score * armMult, calibratedProb, calibrationN });
  }

  let lastSkipReason = 'no edge above gates';
  for (const cand of rankedCandidates) {
    const candSide = recommendationToSide(cand.prediction.recommendation);
    if (!candSide) {
      lastSkipReason = `non-directional signal (${cand.asset})`;
      continue;
    }
    if (PAPER_SKIP_STRONG_SIGNALS && cand.prediction.recommendation.startsWith('STRONG_')) {
      lastSkipReason = `skip-strong: ${cand.prediction.recommendation} (${cand.asset})`;
      continue;
    }
    const candDir = cand.prediction.direction as 'UP' | 'DOWN' | 'NEUTRAL';
    const candSources = (cand.prediction.sources ?? []) as Array<{ direction?: string }>;
    // Record signal history for future ticks' stability check.
    void appendSignalHistory(cand.asset, candDir, now).catch(() => undefined);
    const qReject = await signalQualityRejection(cand.asset, candDir, candSources);
    if (qReject) {
      lastSkipReason = `signal-quality (${cand.asset}): ${qReject}`;
      continue;
    }
    if (concurrencyFilter) {
      const cReject = concurrencyFilter.rejectionReason(cand.asset, candSide);
      if (cReject) {
        lastSkipReason = `concurrency (${cand.asset}): ${cReject}`;
        continue;
      }
    }

    // Fix K (2026-09-26) — fee-adjusted calibrated-probability gate.
    // Uses the pre-computed calibrated prob attached during ranking (no
    // second cron_state read per candidate). Threshold raised from the
    // pre-Fix-K 0.50 to PAPER_CALIBRATED_MIN_WIN_RATE (default 0.53) to
    // cover 3× lev + 13bp round-trip fees + slight adverse-selection
    // margin. Below 53% empirical wins → net loss even when trades
    // marginally "win" by close.
    if (
      cand.calibratedProb !== null
      && cand.calibrationN >= PAPER_CALIBRATED_RANK_MIN_N
      && cand.calibratedProb < PAPER_CALIBRATED_MIN_WIN_RATE
    ) {
      lastSkipReason = `calibrator (${cand.asset} ${candSide}): bucket win-rate ${(cand.calibratedProb * 100).toFixed(0)}% (n=${cand.calibrationN}) below fee-adj ${(PAPER_CALIBRATED_MIN_WIN_RATE * 100).toFixed(0)}%`;
      continue;
    }

    // Extra caller-supplied gate (streak / trend / vol / regret) —
    // was AFTER selection previously, meaning a top-pick rejection
    // aborted the tick instead of trying the next-best candidate.
    // Now runs INSIDE the loop so we walk down the ranked list.
    if (extraGate) {
      const extraReject = await extraGate(cand.asset, candSide, now);
      if (extraReject) {
        lastSkipReason = `${cand.asset}: ${extraReject}`;
        continue;
      }
    }

    logger.info('[PaperTrader] candidate picked from ranked scan', {
      asset: cand.asset,
      rec: cand.prediction.recommendation,
      score: cand.score.toFixed(1),
    });
    return { ok: true, picked: { ...cand, side: candSide } };
  }
  return { ok: false, reason: lastSkipReason };
}

// ── priceCandidate ───────────────────────────────────────────────────

/**
 * Multi-source validated price at open. The 2026-09-17 forensic showed
 * ETH trading blind at a 74-day-stale $2016.64 because single-source
 * getLivePrice never checked freshness. Multi-source median across
 * 3 providers with 2% deviation cap catches this. Fails hard on
 * insufficient sources or deviation.
 */
export async function priceCandidate(asset: string): Promise<PriceResult> {
  try {
    // 8s timeout: crypto.com REST + MCP fetches can push 3-5s each in
    // Vercel serverless cold starts. 4s was too aggressive — every entry
    // timed out silently on 2026-09-17 post-deploy.
    const validated = await getMultiSourceValidatedPrice(asset, {
      minSources: 2,
      maxDeviationPercent: 2,
      timeout: 8000,
    });
    if (!validated.price || validated.price <= 0) {
      return { ok: false, reason: 'no mark price after validation' };
    }
    return { ok: true, markPrice: validated.price };
  } catch (e) {
    return { ok: false, reason: `price validation failed: ${errMsg(e).slice(0, 80)}` };
  }
}

// ── sizeCandidate ────────────────────────────────────────────────────

/**
 * Kelly-scaled stake × vol multiplier × source-calibration boost →
 * notional dollars for the open. All three multipliers converge on 1.0
 * for a middling signal; sizing balloons for confident-consensus-strong
 * signals on historically-accurate sources.
 */
export async function sizeCandidate(
  picked: PickedCandidate,
  nav: number,
  now: number,
): Promise<SizeResult> {
  const conf = picked.prediction.confidence ?? 0;
  const cons = (picked.prediction as { consensus?: number }).consensus ?? 0;
  const signalScalar = computeSignalScalar(conf, cons);
  const volMult = await getVolMultiplier(picked.asset, now);
  const rawSourcesForCal = (picked.prediction.sources ?? []) as Array<{
    name: string;
    type?: string;
    weight?: number;
  }>;
  const calibrationBoost = await computeCalibrationBoost(
    rawSourcesForCal.map((s) => ({
      name: s.name,
      type: s.type,
      weight: s.weight ?? 1,
    })),
  );
  const rawStake = nav * PAPER_STAKE_PCT * signalScalar * volMult * calibrationBoost;
  // Hard cap on stake (was missing — paper had unbounded stake vs live's
  // $500 cap). Applied AFTER all multipliers so any combined boost still
  // respects the NAV-fraction ceiling.
  const { PAPER_MAX_STAKE_PCT } = await import('./config');
  const maxStake = nav * PAPER_MAX_STAKE_PCT;
  const stakeUsd = Math.min(rawStake, maxStake);
  const notionalUsd = stakeUsd * PAPER_LEVERAGE;
  return { notionalUsd, stakeUsd, signalScalar, volMult, calibrationBoost };
}
