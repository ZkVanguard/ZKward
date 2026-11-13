/**
 * ProvenTrader — trades only what the signal ledger has proven above cost,
 * the way it was proven (portfolio -13), at the user's word on 2026-11-13
 * ("we are generating great signals, still we are messing it up").
 *
 * Why: the main signal book opens a coin only when the ledger's judge rates
 * its combined vote above the round-trip cost at the judge's horizon (60 min),
 * then holds it up to 24 h with a +25 bp target and a −200 bp stop, a
 * different bet from the one measured. Over 30 days it closed 23 such trades
 * at −23.8 bp each. This book takes the same readings and trades them as they
 * were measured: if the signals are good and the execution was the problem,
 * it makes money; if it does not, the signals are not good enough after costs.
 *
 * Design: LeadTrader's code (runLeadBook) on the combined vote ('aggregate'
 * rows of signal_outcomes) at the judge's horizon, for the paper universe. A
 * resting entry at the reading's price, filled only on a trade-through; a
 * market exit at the horizon; $1,000 at 1x; one position per coin. A reading
 * is traded only while tradeVerdict says the coin's combined vote clears the
 * round trip by two standard errors; an unreadable judgment trades nothing.
 */
import { LEDGER_WEIGHT_HORIZON_MIN } from '@/lib/services/market-data/ledger-cells';
import { FEE_BPS_PER_SIDE } from './simulated-executor';
import { PAPER_UNIVERSE } from './config';
import { runLeadBook, type LeadBook, type LeadTickSummary } from './LeadTrader';

export const PROVEN_PORTFOLIO_ID = -13;
/** The round trip the edge must clear: the same bar as the main book's full size. */
export const PROVEN_COST_BP = 2 * FEE_BPS_PER_SIDE;

/** True while the judge rates this coin's combined vote above the round trip. */
export async function provenAboveCost(asset: string): Promise<boolean> {
  const { getLoopState, tradeVerdict } = await import('@/lib/services/market-data/feedback-loop');
  return tradeVerdict(await getLoopState(), 'aggregate', asset, PROVEN_COST_BP) === 'proven';
}

const PROVEN: LeadBook = {
  name: 'ProvenTrader',
  portfolioId: PROVEN_PORTFOLIO_ID,
  keyPrefix: 'proven-trader',
  orderPrefix: 'proven',
  sourceLike: 'aggregate',
  holdMin: LEDGER_WEIGHT_HORIZON_MIN,
  assets: PAPER_UNIVERSE,
  stakeUsd: 1000,
  disableFlag: 'PROVEN_TRADER_DISABLE',
  admit: (asset) => provenAboveCost(asset),
};

export function runProvenTick(now: number = Date.now()): Promise<LeadTickSummary> {
  return runLeadBook(PROVEN, now);
}

export class ProvenTrader {
  static runTick(now: number = Date.now()): Promise<LeadTickSummary> {
    return runProvenTick(now);
  }
}
