/**
 * How close a venue position is to liquidation, from the venue's own figures.
 *
 * The guard used to estimate a liquidation price from the database row
 * (entry × (1 ± 1 / leverage)). That is an isolated-margin formula: for the
 * pool's cross-margin ETH short it gave $2,689 while the venue's figure was
 * $3,792, so the guard judged a comfortable position to be 6% from
 * liquidation. Only the venue knows the margin behind a position.
 */

export interface VenueRiskPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  markPrice: number;
  /** 0 or missing when the venue gives no liquidation price for the position. */
  liquidationPrice: number;
  margin?: number;
}

export type LiquidationLevel = 'emergency' | 'warning' | 'healthy' | 'unknown';

/** Close when the mark is within this many percent of the liquidation price. */
export const LIQUIDATION_EMERGENCY_PCT = 5;
/** Say so when it is within this many. */
export const LIQUIDATION_WARNING_PCT = 10;

/** Percent the mark must still move against the position to reach liquidation; null when the venue gives no price. */
export function liquidationDistancePct(p: Pick<VenueRiskPosition, 'side' | 'markPrice' | 'liquidationPrice'>): number | null {
  if (!(p.markPrice > 0) || !(p.liquidationPrice > 0)) return null;
  const d = p.side === 'LONG' ? (p.markPrice - p.liquidationPrice) / p.markPrice : (p.liquidationPrice - p.markPrice) / p.markPrice;
  return d * 100;
}

export function liquidationLevel(distancePct: number | null): LiquidationLevel {
  if (distancePct === null) return 'unknown';
  if (distancePct < LIQUIDATION_EMERGENCY_PCT) return 'emergency';
  if (distancePct < LIQUIDATION_WARNING_PCT) return 'warning';
  return 'healthy';
}
