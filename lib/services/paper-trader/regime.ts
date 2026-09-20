/**
 * L9 — Market regime detector.
 * L10 — Per-regime strategy config.
 *
 * Classifies the current market into one of three regimes:
 *   TRENDING_UP    — high vol + positive funding + upward consensus
 *   TRENDING_DOWN  — high vol + negative funding + downward consensus
 *   CHOP           — everything else (default)
 *
 * Signals used (all reused from existing infrastructure, zero new API calls):
 *   • BTC annualized realized vol (Deribit) → vol tier
 *   • BTC BlueFin funding rate → sentiment sign
 *   • Multi-asset direction consensus from PredictionAggregator → trend
 *
 * The regime output is cached in cron_state so downstream readers don't
 * hit the vol/funding APIs. Refreshed hourly by paper trader's runTick.
 *
 * Per-regime strategy config (L10) supplies overrides that stack on top of
 * static PAPER_TRADER_* env vars: tighter filters + tighter stops in chop,
 * looser filters + wider trailing in trend.
 */

import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { getRealizedVolPct } from './volatility-gate';

export type Regime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'CHOP';

export interface RegimeState {
  regime: Regime;
  btcVolPct: number | null;
  btcFundingSign: 1 | -1 | 0;
  consensusDir: 'UP' | 'DOWN' | 'MIXED';
  detectedAt: number;
}

const REGIME_KEY = 'paper-trader:regime';
const REGIME_TTL_MS = 60 * 60 * 1000; // 1h — vol/funding move slowly

// Thresholds. Only cross into trending when BOTH vol is high AND signals
// agree on a direction; otherwise chop wins by default (safer).
const HIGH_VOL_PCT = 45;
const CONSENSUS_MIN_AGREE = 0.6;

/**
 * Look up the current regime, refreshing from live signals if the cached
 * value is stale. Failure to fetch fresh signals returns the stale cached
 * value; failure to fetch anything at all returns CHOP (safe default).
 */
export async function getCurrentRegime(now: number = Date.now()): Promise<RegimeState> {
  const cached = await getCronState<RegimeState>(REGIME_KEY);
  if (cached && now - cached.detectedAt < REGIME_TTL_MS) return cached;

  try {
    const btcVolPct = await getRealizedVolPct('BTC').catch(() => null);

    // Funding sign is derived from the BlueFin source's directional read
    // inside the aggregator (rather than a separate API call requiring the
    // full BluefinService boot). This shares the aggregator's cache so we
    // don't double-hit BlueFin.
    let btcFundingSign: 1 | -1 | 0 = 0;
    let consensusDir: 'UP' | 'DOWN' | 'MIXED' = 'MIXED';
    try {
      const { PredictionAggregatorService } = await import('@/lib/services/market-data/PredictionAggregatorService');
      const scan = await PredictionAggregatorService.scanAndPickBest(['BTC', 'ETH', 'SOL'], {
        minConfidence: 0, minConsensus: 0, minSources: 1,
      });
      const dirs = Object.values(scan.all).map((p) => p.direction as string);
      const up = dirs.filter((d) => d === 'UP').length;
      const down = dirs.filter((d) => d === 'DOWN').length;
      const total = up + down;
      if (total > 0 && up / total >= CONSENSUS_MIN_AGREE) consensusDir = 'UP';
      else if (total > 0 && down / total >= CONSENSUS_MIN_AGREE) consensusDir = 'DOWN';

      // Pull the BlueFin funding source out of BTC's per-source list.
      const btc = scan.all.BTC;
      const funding = btc?.sources?.find((s) => /funding/i.test((s as { name?: string }).name ?? ''));
      const fundingDir = (funding as { direction?: string } | undefined)?.direction;
      if (fundingDir === 'UP') btcFundingSign = 1;
      else if (fundingDir === 'DOWN') btcFundingSign = -1;
    } catch { /* aggregator read optional */ }

    let regime: Regime = 'CHOP';
    if (btcVolPct && btcVolPct >= HIGH_VOL_PCT) {
      // Full trend needs both funding + consensus alignment. Just one
      // agreement doesn't override the default CHOP.
      if (btcFundingSign >= 0 && consensusDir === 'UP') regime = 'TRENDING_UP';
      else if (btcFundingSign <= 0 && consensusDir === 'DOWN') regime = 'TRENDING_DOWN';
    }

    const state: RegimeState = { regime, btcVolPct, btcFundingSign, consensusDir, detectedAt: now };
    await setCronState(REGIME_KEY, state);
    return state;
  } catch (e) {
    logger.debug('[Regime] detection failed (falling back to CHOP)', { error: errMsg(e) });
    return cached ?? {
      regime: 'CHOP',
      btcVolPct: null,
      btcFundingSign: 0,
      consensusDir: 'MIXED',
      detectedAt: now,
    };
  }
}

/**
 * L10 — Per-regime strategy overrides. Multiplicative factors applied on
 * top of the static PAPER_TRADER_* defaults. 1.0 = no change.
 *
 * CHOP: strict — cut losers fast, don't hold long, require strong signals.
 *   • stop tighter (0.75× base)
 *   • max-hold shorter (0.75×)
 *   • confidence gate tighter (1.05× base)
 *
 * TRENDING_UP/DOWN: loose — winners have room to run when the tide is
 * with them.
 *   • stop wider (1.5× base)
 *   • max-hold longer (1.5×)
 *   • confidence gate slightly relaxed (0.95×)
 *
 * Env-tunable via PAPER_TRADER_REGIME_OVERRIDES_DISABLE=1 for kill-switch.
 */
export interface RegimeMultipliers {
  stopLossMult: number;
  maxHoldMult: number;
  minConfidenceMult: number;
}

const OVERRIDES_DISABLED = process.env.PAPER_TRADER_REGIME_OVERRIDES_DISABLE === '1';

const REGIME_CONFIG: Record<Regime, RegimeMultipliers> = {
  CHOP:          { stopLossMult: 0.75, maxHoldMult: 0.75, minConfidenceMult: 1.05 },
  TRENDING_UP:   { stopLossMult: 1.5,  maxHoldMult: 1.5,  minConfidenceMult: 0.95 },
  TRENDING_DOWN: { stopLossMult: 1.5,  maxHoldMult: 1.5,  minConfidenceMult: 0.95 },
};

export function getRegimeMultipliers(regime: Regime): RegimeMultipliers {
  if (OVERRIDES_DISABLED) return { stopLossMult: 1, maxHoldMult: 1, minConfidenceMult: 1 };
  return REGIME_CONFIG[regime] ?? { stopLossMult: 1, maxHoldMult: 1, minConfidenceMult: 1 };
}

// Test-only
export {
  REGIME_KEY as _REGIME_KEY,
  HIGH_VOL_PCT as _HIGH_VOL_PCT,
  CONSENSUS_MIN_AGREE as _CONSENSUS_MIN_AGREE,
};
