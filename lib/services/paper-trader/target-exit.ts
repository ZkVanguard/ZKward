/**
 * Target-exit policy: a position closes at a take-profit, at a stop, or at a
 * time limit, and at nothing else.
 *
 * Why: the win rate of a book is set by the shape of its exits far more than
 * by its entries. Replayed on 30 days of 1-minute prices across five assets
 * with full round-trip friction, a +25 bp take-profit with a -200 bp stop
 * and a 24 h limit closed about 89% of trades in profit (worst day 77%).
 * The adaptive exits (trailing arm at 50 bp, tighten, flip, 1-4 h holds)
 * produced 36-56% because most trades timed out near flat and paid friction.
 *
 * What it does not do: it does not create edge. Wins are small and losses
 * are large by design; the average trade equals the entry signal's edge
 * minus friction, exactly as before. Read the win rate together with the
 * average trade.
 */
import type { Side, SimulatedPosition } from './simulated-executor';
import { PAPER_TARGET_MAX_HOLD_MIN, PAPER_TARGET_STOP_BP, PAPER_TARGET_TP_BP } from './config';

export interface TargetExitLevels {
  takeProfitPrice: number;
  stopLossPrice: number;
  maxHoldMin: number;
}

export function targetExitLevels(
  side: Side,
  entryPrice: number,
  tpBp: number = PAPER_TARGET_TP_BP,
  stopBp: number = PAPER_TARGET_STOP_BP,
  maxHoldMin: number = PAPER_TARGET_MAX_HOLD_MIN,
): TargetExitLevels {
  const up = side === 'LONG' ? 1 : -1;
  return {
    takeProfitPrice: entryPrice * (1 + (up * tpBp) / 10_000),
    stopLossPrice: entryPrice * (1 - (up * stopBp) / 10_000),
    maxHoldMin,
  };
}

/** True once the mark has reached the position's take-profit. Positions without one never hit. */
export function takeProfitHit(pos: Pick<SimulatedPosition, 'side' | 'takeProfitPrice'>, markPrice: number): boolean {
  if (!pos.takeProfitPrice) return false;
  return pos.side === 'LONG' ? markPrice >= pos.takeProfitPrice : markPrice <= pos.takeProfitPrice;
}
