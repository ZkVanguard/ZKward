/**
 * ActiveTrade — the persisted shape of an in-flight polymarket-edge trade.
 *
 * Stored in cron_state at KEY_ACTIVE. Read at the top of every trader
 * tick to decide whether we're managing an existing position or opening
 * a new one. Cleared (set to null) on any exit path.
 *
 * Optional fields (`highWaterBps`, `deferCount`) are back-compat safe:
 * rows written before those fields existed simply lack them, and the
 * trader treats missing as the default (0 hwm, 0 defers).
 */
import type { SupportedAsset } from '@/lib/config/trader-assets';
import type { AggregatedPrediction } from '@/lib/services/market-data/PredictionAggregatorService';

export interface ActiveTrade {
  symbol: string;
  asset: SupportedAsset;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  stakeUsd: number;
  recommendation: AggregatedPrediction['recommendation'];
  consensus: number;
  confidence: number;
  sourceCount: number;
  /** Score at entry — used for signal-flip stop comparison. */
  entryScore: number;
  openedAt: number;
  /** Hard close time. Extended by fee-bleed defers up to MAX_DEFER_COUNT. */
  closeBy: number;
  clientOrderId: string;
  /**
   * Highest favourable move (in signed bps) observed since entry.
   * Ratchets upward only. Drives the trailing stop — see
   * lib/services/trading/trailing-stop.ts. Optional for back-compat.
   */
  highWaterBps?: number;
  /**
   * Number of times max-hold was deferred to avoid a fee-bleed close.
   * Capped at MAX_DEFER_COUNT. Optional for back-compat.
   */
  deferCount?: number;
  /**
   * Number of times max-hold was deferred because the signal was still
   * aligned + STRONG_ at expiry. Separate counter from `deferCount` so
   * fee-bleed and aligned-signal caps don't compete for the same budget.
   * Capped at MAX_ALIGNED_DEFER_COUNT. Optional for back-compat.
   */
  alignedDeferCount?: number;
  /**
   * What the open settled in the venue account (its fee), in USD. Subtracted
   * from the close's settled result so one trade has one figure. Optional for
   * back-compat; missing means unknown and counts as 0.
   */
  openCostUsd?: number;
}

/** cron_state key where the ActiveTrade blob lives. */
export const KEY_ACTIVE_TRADE = 'polymarket-edge:active-trade';
