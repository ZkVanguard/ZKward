/**
 * SimulatedTradeExecutor — mark-price paper-trade fills with realistic
 * BlueFin-parity friction, so we can prove signal edge net of the exact
 * fee model a live user would pay.
 *
 * Pure helpers below carry all the math. The class-shaped exports are
 * kept minimal so paper-trader/PaperTrader.ts stays thin.
 *
 * Fee & funding model (matches BlueFin Pro observed 2026-09):
 *   • Taker fee 6.5 bp per side → 13 bp round-trip
 *   • Perp funding ~11% APR average, prorated per second on open notional
 *   • LONG pays funding (bull-regime convention), SHORT collects
 *   • Zero slippage — fair-mark fill. Slippage layer is a future knob.
 */

export const FEE_BPS_PER_SIDE = 6.5;
export const FUNDING_APR = 0.11;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export type Side = 'LONG' | 'SHORT';

export interface SimulatedFillParams {
  asset: string;
  side: Side;
  notionalUsd: number;
  leverage: number;
  entryPrice: number;
}

export interface SourceSnapshot {
  key: string;             // normalized (see source-calibrator.normalizeSourceKey)
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
}

export interface SimulatedPosition {
  asset: string;
  side: Side;
  entryPrice: number;
  size: number;
  notionalUsd: number;
  leverage: number;
  openedAt: number;
  openFeeUsd: number;
  // Signal sources present at open (with normalized keys). Used at close
  // to record per-source outcomes against the actual price move. Optional
  // for backward-compat with positions written before the calibrator
  // landed.
  sourceSnapshot?: SourceSnapshot[];
}

export interface SimulatedCloseResult {
  asset: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  notionalUsd: number;
  size: number;
  holdSeconds: number;
  grossPnlUsd: number;
  openFeeUsd: number;
  closeFeeUsd: number;
  fundingUsd: number;
  realizedPnlUsd: number;
}

/** Fee in USD for one side of the trade. Applied at open and again at close. */
export function computeFeeUsd(notionalUsd: number, feeBps: number = FEE_BPS_PER_SIDE): number {
  return notionalUsd * (feeBps / 10_000);
}

/**
 * Funding paid/collected over the hold period, signed from the position's
 * perspective (negative = position paid). LONG pays under positive-funding
 * regime (typical bull-market perp); SHORT collects. Symmetric abs value.
 */
export function computeFundingUsd(
  notionalUsd: number,
  side: Side,
  holdMs: number,
  aprRate: number = FUNDING_APR,
): number {
  const seconds = Math.max(0, holdMs) / 1000;
  const magnitude = notionalUsd * aprRate * (seconds / SECONDS_PER_YEAR);
  return side === 'LONG' ? -magnitude : magnitude;
}

/** Directional gross PnL before any fees/funding. */
export function computeGrossPnl(
  side: Side,
  entryPrice: number,
  exitPrice: number,
  notionalUsd: number,
): number {
  if (entryPrice <= 0) return 0;
  const moveFrac = (exitPrice - entryPrice) / entryPrice;
  const directional = side === 'LONG' ? moveFrac : -moveFrac;
  return notionalUsd * directional;
}

export function simulateOpen(
  params: SimulatedFillParams,
  nowMs: number,
): SimulatedPosition {
  if (params.entryPrice <= 0) {
    throw new Error(`simulateOpen: invalid entryPrice ${params.entryPrice}`);
  }
  if (params.notionalUsd <= 0) {
    throw new Error(`simulateOpen: invalid notionalUsd ${params.notionalUsd}`);
  }
  return {
    asset: params.asset,
    side: params.side,
    entryPrice: params.entryPrice,
    size: params.notionalUsd / params.entryPrice,
    notionalUsd: params.notionalUsd,
    leverage: params.leverage,
    openedAt: nowMs,
    openFeeUsd: computeFeeUsd(params.notionalUsd),
  };
}

export function simulateClose(
  position: SimulatedPosition,
  exitPrice: number,
  nowMs: number,
): SimulatedCloseResult {
  if (exitPrice <= 0) {
    throw new Error(`simulateClose: invalid exitPrice ${exitPrice}`);
  }
  const holdMs = Math.max(0, nowMs - position.openedAt);
  const grossPnlUsd = computeGrossPnl(
    position.side,
    position.entryPrice,
    exitPrice,
    position.notionalUsd,
  );
  const closeFeeUsd = computeFeeUsd(position.notionalUsd);
  const fundingUsd = computeFundingUsd(position.notionalUsd, position.side, holdMs);
  const realizedPnlUsd = grossPnlUsd - position.openFeeUsd - closeFeeUsd + fundingUsd;
  return {
    asset: position.asset,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    notionalUsd: position.notionalUsd,
    size: position.size,
    holdSeconds: Math.round(holdMs / 1000),
    grossPnlUsd,
    openFeeUsd: position.openFeeUsd,
    closeFeeUsd,
    fundingUsd,
    realizedPnlUsd,
  };
}

/**
 * Mark-to-market unrealized PnL for an open position. Includes accrued
 * funding + already-paid open fee. Does NOT include the yet-to-pay close
 * fee — that only materializes at exit. Used by the NAV snapshot.
 */
export function markToMarket(
  position: SimulatedPosition,
  markPrice: number,
  nowMs: number,
): { unrealizedPnlUsd: number; fundingAccruedUsd: number } {
  const gross = computeGrossPnl(
    position.side,
    position.entryPrice,
    markPrice,
    position.notionalUsd,
  );
  const holdMs = Math.max(0, nowMs - position.openedAt);
  const fundingAccruedUsd = computeFundingUsd(position.notionalUsd, position.side, holdMs);
  return {
    unrealizedPnlUsd: gross - position.openFeeUsd + fundingAccruedUsd,
    fundingAccruedUsd,
  };
}
