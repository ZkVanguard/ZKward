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
): Promise<SelectResult> {
  let scan: Awaited<ReturnType<typeof PredictionAggregatorService.scanAndPickBest>>;
  try {
    scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
      minConfidence: PAPER_MIN_CONFIDENCE,
      minConsensus: PAPER_MIN_CONSENSUS,
      minSources: PAPER_MIN_SOURCES,
    });
  } catch (e) {
    return { ok: false, reason: `scan failed: ${errMsg(e)}` };
  }
  if (!scan.best) {
    logger.warn('[PaperTrader] scan.best null — no asset met gates', {
      min: { conf: PAPER_MIN_CONFIDENCE, cons: PAPER_MIN_CONSENSUS, sources: PAPER_MIN_SOURCES },
      universeSize: PAPER_UNIVERSE.length,
    });
    return { ok: false, reason: 'no edge above gates' };
  }

  // In concurrent mode: rank every candidate by score, iterate.
  // In legacy mode: just try scan.best.
  const rankedCandidates: Array<{ asset: string; prediction: AggregatedPrediction; score: number }> = [];
  if (concurrencyFilter) {
    for (const [candidateAsset, pred] of Object.entries(scan.all)) {
      if (pred.confidence < PAPER_MIN_CONFIDENCE) continue;
      if (pred.consensus < PAPER_MIN_CONSENSUS) continue;
      if (pred.sources.length < PAPER_MIN_SOURCES) continue;
      const s = PredictionAggregatorService.scoreOpportunity(pred);
      if (s <= 0) continue;
      rankedCandidates.push({ asset: candidateAsset, prediction: pred, score: s });
    }
    rankedCandidates.sort((a, b) => b.score - a.score);
  } else {
    rankedCandidates.push(scan.best);
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
  const stakeUsd = nav * PAPER_STAKE_PCT * signalScalar * volMult * calibrationBoost;
  const notionalUsd = stakeUsd * PAPER_LEVERAGE;
  return { notionalUsd, stakeUsd, signalScalar, volMult, calibrationBoost };
}
