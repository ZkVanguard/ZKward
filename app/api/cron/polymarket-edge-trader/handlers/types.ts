/**
 * Shared types + DEFAULT_STATS for the polymarket-edge-trader.
 *
 * Extracted from route.ts on 2026-08-10.
 */
import type { AggregatedPrediction } from '@/lib/services/market-data/PredictionAggregatorService';
import type { SupportedAsset } from '@/lib/config/trader-assets';

export interface EdgeStats {
  trades: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  peakPnlUsd: number;
  consecutiveLosses: number;
  lastUpdatedMs: number;
  perAsset?: Record<string, { trades: number; wins: number; pnlUsd: number }>;
}

/** Daily realized-PnL bucket — auto-resets when UTC day changes. */
export interface DailyStats {
  utcDayKey: string; // YYYY-MM-DD
  pnlUsd: number;
  trades: number;
}

export interface EdgeResult {
  success: boolean;
  ranAt: string;
  attempted: boolean;
  action?:
    | 'closed'
    | 'opened'
    | 'idle'
    | 'halted'
    | 'no-signal'
    | 'no-collateral'
    | 'no-edge'
    | 'signal-flip-exit'
    | 'slippage-exit'
    | 'daily-cap'
    | 'skip-asset-too-small-nav'
    | 'regret-halt'
    | 'treasury-halt'
    | 'funding-headwind'
    | 'exposure-cap';
  trade?: {
    symbol: string;
    asset: SupportedAsset;
    side: 'LONG' | 'SHORT';
    size: number;
    stakeUsd: number;
    consensus: number;
    confidence: number;
    sourceCount: number;
    recommendation: AggregatedPrediction['recommendation'];
  };
  closed?: {
    symbol: string;
    asset: SupportedAsset;
    realizedPnlUsd: number;
    win: boolean;
    durationS: number;
  };
  prediction?: {
    direction: AggregatedPrediction['direction'];
    recommendation: AggregatedPrediction['recommendation'];
    confidence: number;
    consensus: number;
    probability: number;
    sourceNames: string[];
  };
  /** Per-asset scan summary so the operator can audit why this asset won. */
  scan?: Record<string, {
    direction: AggregatedPrediction['direction'];
    recommendation: AggregatedPrediction['recommendation'];
    confidence: number;
    consensus: number;
    sources: number;
    score: number;
  }>;
  stats?: EdgeStats;
  daily?: DailyStats;
  haltedUntil?: number;
  reason?: string;
  error?: string;
}

export const DEFAULT_STATS: EdgeStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  totalPnlUsd: 0,
  peakPnlUsd: 0,
  consecutiveLosses: 0,
  lastUpdatedMs: 0,
  perAsset: {},
};
