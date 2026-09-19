/**
 * Funding-adjusted EV gate — checks the trade's expected value AFTER
 * subtracting funding + fee costs is above EV_MIN_USD.
 *
 * Extracted from polymarket-edge-trader/route.ts on 2026-09-18 as part
 * of P1-F declutter. Pure — no NextResponse, no logging side effects
 * (caller logs + short-circuits on block).
 *
 * Why this matters: Kelly + calibration only checks that p > 0.5.
 * A 55% edge held 30min at 11% APR funding + 13 bps round-trip fees
 * on a 3× levered notional is often NEGATIVE-EV once costs subtract.
 * Skipping these is exactly what prevented the wash-trade pattern
 * from being visible before (100% phantom rate 2026-08-08).
 *
 * Calibration: Bayesian-shrunken probability from historical outcomes
 * for this (asset, side, confidence-bucket). Falls back to raw when
 * no history exists. Closes the biggest known PnL leak — historical
 * conf 70-80 bucket won 12% of the time despite model saying 74%.
 */
import { calibrate as calibrateProbability } from '@/lib/services/ai/probability-calibrator';
import { expectedValueUsd } from '@/lib/services/hedging/quant-models';

export interface EvGateInput {
  asset: string;
  side: 'LONG' | 'SHORT';
  rawConfidencePct: number;
  notionalUsd: number;
  holdingHours: number;
  fundingRateApr: number;
  feeBpsRoundTrip: number;
  evMinUsd: number;
}

export interface EvCalibrationLog {
  asset: string;
  side: 'LONG' | 'SHORT';
  rawConf: number;
  pRaw: number;
  pCalibrated: number;
  nHistory: number;
  empiricalWinRate: number | null;
}

export interface EvGateResult {
  /** null when EV clears the min — trade proceeds. */
  blockReason: string | null;
  /** Log payload the caller emits regardless of outcome. */
  calibrationLog: EvCalibrationLog;
  /** Raw EV computation for downstream context. */
  ev: {
    evUsd: number;
    edgeUsd: number;
    fundingCostUsd: number;
    feeCostUsd: number;
  };
  /** Calibrated probability actually used in EV. */
  evP: number;
}

export async function computeEvGate(input: EvGateInput): Promise<EvGateResult> {
  const calibration = await calibrateProbability({
    asset: input.asset,
    side: input.side,
    rawConfidencePct: input.rawConfidencePct,
  });
  const evP = Math.min(0.999, Math.max(0.001, calibration.pCalibrated));
  const ev = expectedValueUsd({
    probability: evP,
    payoffOdds: 1,
    notionalUsd: input.notionalUsd,
    holdingHours: input.holdingHours,
    fundingRateApr: input.fundingRateApr,
    feeBpsRoundTrip: input.feeBpsRoundTrip,
  });

  const calibrationLog: EvCalibrationLog = {
    asset: input.asset,
    side: input.side,
    rawConf: input.rawConfidencePct,
    pRaw: calibration.pRaw,
    pCalibrated: calibration.pCalibrated,
    nHistory: calibration.nHistory,
    empiricalWinRate: calibration.empiricalWinRate,
  };

  let blockReason: string | null = null;
  if (ev.evUsd < input.evMinUsd) {
    blockReason =
      `ev-gate blocked ${input.asset} ${input.side}: EV=$${ev.evUsd.toFixed(3)} < min $${input.evMinUsd.toFixed(2)} ` +
      `(edge=$${ev.edgeUsd.toFixed(3)} funding=$${ev.fundingCostUsd.toFixed(3)} fees=$${ev.feeCostUsd.toFixed(3)}, ` +
      `p=${(evP * 100).toFixed(1)}% notional=$${input.notionalUsd.toFixed(2)} hold=${input.holdingHours}h)`;
  }

  return { blockReason, calibrationLog, ev, evP };
}
