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
 *   • Adverse slippage per side, per asset (spread + impact) — see below
 *   • A resting-order fill pays the maker fee and no slippage; what it
 *     costs instead is the fill rule in resting-orders.ts
 */

export const FEE_BPS_PER_SIDE = 6.5;
/** Resting-order fee. The venue lists 0.5 bp; the books assume double. */
export const MAKER_FEE_BPS_PER_SIDE = Number(process.env.PAPER_MAKER_FEE_BPS || 1);
export const FUNDING_APR = 0.11;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * Slippage — the last flattering assumption, removed 2026-09-28.
 * Market orders cross the spread and eat impact; a mark-price fill
 * pretends they don't. Modeled as an adverse cost per side, per asset
 * (majors tight, small-caps wider), charged at open AND close so every
 * realized number the platform shows is net of the full friction a
 * live taker would pay. Flat override: PAPER_SLIPPAGE_BPS_PER_SIDE;
 * per-asset: PAPER_ASSET_SLIPPAGE_BPS='{"BTC":1,...}'.
 */
const DEFAULT_SLIPPAGE_BPS: Record<string, number> = (() => {
  const raw = process.env.PAPER_ASSET_SLIPPAGE_BPS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through */ }
  }
  return { BTC: 1, ETH: 1, SOL: 2, XRP: 2, DOGE: 2.5, SUI: 2.5, ATOM: 2.5 };
})();
const FLAT_SLIPPAGE_BPS = Number(process.env.PAPER_SLIPPAGE_BPS_PER_SIDE || 0);

export function slippageBpsForAsset(asset: string): number {
  if (FLAT_SLIPPAGE_BPS > 0) return FLAT_SLIPPAGE_BPS;
  return DEFAULT_SLIPPAGE_BPS[asset.toUpperCase()] ?? 1.5;
}

/** Adverse slippage cost in USD for ONE side of the trade. */
export function computeSlippageUsd(notionalUsd: number, asset: string): number {
  return notionalUsd * (slippageBpsForAsset(asset) / 10_000);
}

/**
 * True once the mark has traded THROUGH a resting order's price by the
 * asset's slippage allowance. A touch is not a fill: the order may sit
 * behind others at that price.
 */
export function restingFilled(order: 'buy' | 'sell', limitPrice: number, markPrice: number, asset: string): boolean {
  const through = slippageBpsForAsset(asset) / 10_000;
  return order === 'buy' ? markPrice <= limitPrice * (1 - through) : markPrice >= limitPrice * (1 + through);
}

export type Side = 'LONG' | 'SHORT';

export interface SimulatedFillParams {
  asset: string;
  side: Side;
  notionalUsd: number;
  leverage: number;
  entryPrice: number;
  /** The entry filled as a resting order: maker fee, no slippage. */
  resting?: boolean;
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
  /** Adverse slippage paid at open (one side). Optional for positions
   *  stored before 2026-09-28 — those close with close-side slippage only. */
  slippageOpenUsd?: number;
  // Signal sources present at open (with normalized keys). Used at close
  // to record per-source outcomes against the actual price move. Optional
  // for backward-compat with positions written before the calibrator
  // landed.
  sourceSnapshot?: SourceSnapshot[];
  // Peak unrealized PnL (USD) observed during the position's life. Drives
  // trailing-stop: once armed, close if unrealized drops back below a
  // configurable fraction of this peak. Optional for backward-compat.
  peakUnrealizedPnl?: number;
  // Trough unrealized PnL (USD) — the worst dip during the position's life.
  // MFE/MAE pair with `peakUnrealizedPnl`. Persisted to hedges.metadata at
  // close to enable stop-loss tuning: "trade would have won +$120 but
  // reversed to -$40 exit" is a direct signal that trailing was too loose.
  troughUnrealizedPnl?: number;
  // Signal metadata used at open. Kept in position state so trailing-stop
  // and notify layer can reference it without re-scanning the aggregator.
  entryConfidence?: number;
  entryConsensus?: number;
  // Signal-strength-scaled max-hold ceiling (minutes) captured at open.
  // handleActive uses this instead of the static PAPER_MAX_HOLD_MIN so
  // strong signals earn more time to develop past the fee floor.
  maxHoldMin?: number;
  // Per-position stop-loss price computed from the adaptive-vol
  // threshold at open and locked to the entry price so the check is
  // deterministic per tick against live mark (independent of NAV drift
  // between ticks). Prior implementation only compared
  // mtm.unrealizedPnlUsd against -nav*stopLossPct — 138 / 164 paper
  // trades force-closed at max-hold with -$450 avg loss because that
  // threshold was calibrated to NAV blow-up (0.4-2% of ~$600K NAV =
  // $2.4K-$12K) not per-trade risk. Price-anchored stop fires cleanly
  // regardless of NAV size. No hard take-profit — backtest showed a 1%
  // TP capped fat-tail winners for -$18K net; trailing-stop handles
  // winner ratcheting instead. Optional for backward-compat.
  stopLossPrice?: number;
  /** Set only on target-exit positions: they close here, at the stop or at the time limit. */
  takeProfitPrice?: number;
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
  slippageUsd: number;
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
    openFeeUsd: computeFeeUsd(params.notionalUsd, params.resting ? MAKER_FEE_BPS_PER_SIDE : FEE_BPS_PER_SIDE),
    slippageOpenUsd: params.resting ? 0 : computeSlippageUsd(params.notionalUsd, params.asset),
  };
}

export function simulateClose(
  position: SimulatedPosition,
  exitPrice: number,
  nowMs: number,
  /** The exit filled as a resting order at `exitPrice`: maker fee, no slippage. */
  resting: boolean = false,
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
  const closeFeeUsd = computeFeeUsd(position.notionalUsd, resting ? MAKER_FEE_BPS_PER_SIDE : FEE_BPS_PER_SIDE);
  const fundingUsd = computeFundingUsd(position.notionalUsd, position.side, holdMs);
  const slippageUsd =
    (position.slippageOpenUsd ?? 0) + (resting ? 0 : computeSlippageUsd(position.notionalUsd, position.asset));
  const realizedPnlUsd =
    grossPnlUsd - position.openFeeUsd - closeFeeUsd - slippageUsd + fundingUsd;
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
    slippageUsd,
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
    unrealizedPnlUsd:
      gross - position.openFeeUsd - (position.slippageOpenUsd ?? 0) + fundingAccruedUsd,
    fundingAccruedUsd,
  };
}
