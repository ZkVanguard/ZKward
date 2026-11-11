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
 *   sizeCandidate   — base stake × vol-mult × regime × evidence tier →
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
  PAPER_TRADE_ASSETS,
  PAPER_MIN_CONFIDENCE,
  PAPER_MIN_CONSENSUS,
  PAPER_MIN_SOURCES,
  PAPER_STAKE_PCT,
  PAPER_LEVERAGE,
  PAPER_SKIP_STRONG_SIGNALS,
  PAPER_HALT_ENTRIES_IN_CHOP,
  PAPER_CHOP_STAKE_MULT,
  PAPER_PROBE_STAKE_MULT,
  PAPER_LEDGER_GATE,
} from './config';
import { assetHoldPlan, getLedgerCells, getRecentLedgerCells, type LedgerCell } from '@/lib/services/market-data/ledger-cells';
import { getLoopState, tradeVerdict } from '@/lib/services/market-data/feedback-loop';
import { FEE_BPS_PER_SIDE, type Side } from './simulated-executor';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';
import { computeSignalScalar } from './sizing';
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
  regime?: 'TRENDING_UP' | 'TRENDING_DOWN' | 'CHOP' | null;
  /** Why the entry trades at probe stake (a STRONG signal). */
  probe?: string | null;
  /** Hold horizon the ledger measured an edge at; null = heuristic hold. */
  holdHorizonMin?: number | null;
  ledgerHitRate?: number | null;
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
  /** Confidence and consensus as one scalar. It plans the hold in adaptive mode; it no longer sizes. */
  signalScalar: number;
  volMult: number;
  regimeStakeMult: number;
  probeStakeMult: number;
  /** The ledger's verdict on the combined signal for this coin; it sets the size tier. */
  evidence: SignalEvidence;
}

export type SignalEvidence = 'proven' | 'unproven' | 'wrong-way';

/**
 * Size follows what the ledger has shown, not what the signal claims: full
 * size only for a coin whose combined signal is proven, probe size while it
 * is unproven, nothing while it is measured to point the wrong way. The
 * ledger records every call whether or not a book trades it, so a verdict
 * can change without the book having to trade its way out.
 */
export function evidenceStakeMult(evidence: SignalEvidence, probe: boolean): number {
  if (evidence === 'wrong-way') return 0;
  return evidence === 'proven' && !probe ? 1 : PAPER_PROBE_STAKE_MULT;
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
 * Filter order per candidate: recommendationToSide → signal-quality
 * (majority + stability) → concurrency (dedup + cluster) → ledger
 * admission → caller gates. STRONG signals pass as probes (sized down in
 * sizeCandidate), not skips.
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
  let effectiveMinConf = PAPER_MIN_CONFIDENCE;
  let currentRegime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'CHOP' | null = null;
  try {
    const { entryConfidenceFloor } = await import('./regime');
    ({ minConfidence: effectiveMinConf, regime: currentRegime } = await entryConfidenceFloor(PAPER_MIN_CONFIDENCE, now));
  } catch { /* fall back to static */ }

  // CHOP: full halt only when configured (or the chop stake is 0); otherwise
  // the entry proceeds and sizeCandidate scales stake by PAPER_CHOP_STAKE_MULT.
  if (currentRegime === 'CHOP' && (PAPER_HALT_ENTRIES_IN_CHOP || PAPER_CHOP_STAKE_MULT <= 0)) {
    logger.info('[PaperTrader] chop-regime halt — no entries this tick', {
      regime: currentRegime,
    });
    return { ok: false, reason: 'chop-regime: entries halted (funding+consensus not trending)' };
  }

  let scan: Awaited<ReturnType<typeof PredictionAggregatorService.scanAndPickBest>>;
  try {
    scan = await PredictionAggregatorService.scanAndPickBest(PAPER_TRADE_ASSETS, {
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
      universeSize: PAPER_TRADE_ASSETS.length,
    });
    return { ok: false, reason: 'no edge above gates' };
  }

  // Ledger cells (2026-10-01): the aggregate signal's measured hit rate per
  // asset × horizon decides admission, the hold horizon, and nudges rank.
  let ledgerCells: readonly LedgerCell[] = [];
  let recentCells: readonly LedgerCell[] = [];
  if (PAPER_LEDGER_GATE) {
    try {
      [ledgerCells, recentCells] = await Promise.all([getLedgerCells(), getRecentLedgerCells()]);
    } catch { /* fail-open: cold everywhere */ }
  }
  const holdPlan = (asset: string) => assetHoldPlan(ledgerCells, asset, undefined, recentCells);

  // Rank by the aggregator's own score, nudged by the ledger's hold plan.
  // Per-trade learners (a coin-and-side bandit, a confidence calibrator)
  // used to reorder this list from 6-40 trades each: win rates set by the
  // exits, not by the signal.
  const rankedCandidates: Array<{ asset: string; prediction: AggregatedPrediction; score: number }> = [];
  if (concurrencyFilter) {
    for (const [candidateAsset, pred] of Object.entries(scan.all)) {
      if (pred.confidence < effectiveMinConf) continue;
      if (pred.consensus < PAPER_MIN_CONSENSUS) continue;
      if (pred.sources.length < PAPER_MIN_SOURCES) continue;
      const rawScore = PredictionAggregatorService.scoreOpportunity(pred);
      if (rawScore <= 0) continue;
      const plan = holdPlan(candidateAsset).plan;
      const ledgerMult = plan ? Math.max(0.5, Math.min(1.5, plan.hitRate / 0.5)) : 1;
      rankedCandidates.push({ asset: candidateAsset, prediction: pred, score: rawScore * ledgerMult });
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
    const strongProbe =
      PAPER_SKIP_STRONG_SIGNALS && cand.prediction.recommendation.startsWith('STRONG_')
        ? `strong-signal: ${cand.prediction.recommendation}`
        : null;
    if (strongProbe && PAPER_PROBE_STAKE_MULT <= 0) {
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

    // Ledger admission: the aggregate measured wrong-way at every hold horizon → skip.
    const { plan, measured } = holdPlan(cand.asset);
    if (PAPER_LEDGER_GATE && measured && !plan) {
      lastSkipReason = `ledger (${cand.asset}): aggregate signal measured wrong-way at every hold horizon`;
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
    return {
      ok: true,
      picked: {
        ...cand,
        side: candSide,
        regime: currentRegime,
        probe: strongProbe,
        holdHorizonMin: PAPER_LEDGER_GATE ? plan?.horizonMin ?? null : null,
        ledgerHitRate: plan?.hitRate ?? null,
      },
    };
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
 * Base stake × vol multiplier × regime × evidence tier → notional dollars
 * for the open. Confidence does not set the size, and neither do the
 * per-trade source scores: on the ledger neither has measured any edge
 * (confidence 70+ ran -0.2 ± 1.3 bp at 60 min), and the source scores grade
 * a source by the exit's win rate. Scaling by them made the most confident
 * calls the largest, so a stop on one cost two to four times a normal trade.
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
  const regimeStakeMult = picked.regime === 'CHOP' ? PAPER_CHOP_STAKE_MULT : 1;
  // An unreadable verdict store reads as unproven: the smaller size.
  const loop = await getLoopState().catch(() => null);
  // At the market round trip: a resting entry costs less, but it may not fill and a stop closes at market.
  const evidence: SignalEvidence = tradeVerdict(loop, 'aggregate', picked.asset, 2 * FEE_BPS_PER_SIDE);
  const probeStakeMult = evidenceStakeMult(evidence, !!picked.probe);
  const rawStake =
    nav * PAPER_STAKE_PCT * volMult * regimeStakeMult * probeStakeMult;
  // Hard cap on stake (was missing — paper had unbounded stake vs live's
  // $500 cap). Applied AFTER all multipliers so any combined boost still
  // respects the NAV-fraction ceiling.
  const { PAPER_MAX_STAKE_PCT } = await import('./config');
  const maxStake = nav * PAPER_MAX_STAKE_PCT;
  const stakeUsd = Math.min(rawStake, maxStake);
  const notionalUsd = stakeUsd * PAPER_LEVERAGE;
  return { notionalUsd, stakeUsd, signalScalar, volMult, regimeStakeMult, probeStakeMult, evidence };
}
