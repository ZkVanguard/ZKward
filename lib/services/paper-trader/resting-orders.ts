/**
 * Resting-order execution for the simulated books.
 *
 * Why: with no entry edge a trade loses exactly what it costs to execute, and
 * market orders both ways cost about 14 bp on the books' exit shape — the
 * whole loss. An order that rests in the book pays the maker fee and no
 * spread. Replayed on 30 days of 1-minute prices (five assets, 7,205 entries
 * with a coin-flip direction, same exit shape): market orders averaged
 * -14.0 bp per trade, a resting take-profit -9.7 bp, a resting entry as well
 * -5.3 bp, with the win rate within two points throughout.
 *
 * The honesty rule is the fill: a resting order counts as filled only once
 * the mark has traded THROUGH its price by the asset's slippage allowance,
 * and it fills at its own price, never a better one. The 60 s tick misses
 * every touch-and-return fill a real order would have had and keeps every
 * fill where price kept going against it, so the model errs against the
 * book. The stop and the time limit remain market orders at full cost.
 *
 * This does not create edge: it removes most of the execution cost. The
 * average trade still equals entry edge minus what is left of that cost.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { restingFilled, type Side, type SourceSnapshot } from './simulated-executor';
import { PAPER_RESTING_ENTRY_WAIT_MIN } from './config';

/** Everything a book needs to open the position once its entry fills. */
export interface EntryPlan {
  asset: string;
  side: Side;
  rec: string;
  notionalUsd: number;
  conf: number;
  cons: number;
  score: number;
  probe?: string | null;
  holdHorizonMin?: number | null;
  ledgerHitRate?: number | null;
  signalScalar: number;
  sourceSnapshot: SourceSnapshot[];
}

export interface RestingEntry {
  plan: EntryPlan;
  limitPrice: number;
  placedAt: number;
  expiresAt: number;
}

export async function placeRestingEntry(key: string, plan: EntryPlan, limitPrice: number, now: number): Promise<void> {
  const entry: RestingEntry = { plan, limitPrice, placedAt: now, expiresAt: now + PAPER_RESTING_ENTRY_WAIT_MIN * 60_000 };
  await setCronState(key, entry);
}

export type RestingEntryState =
  | { state: 'none' }
  | { state: 'waiting'; entry: RestingEntry }
  | { state: 'filled'; entry: RestingEntry };

/**
 * A book holds at most one resting entry. 'none' = nothing resting, or it
 * lapsed unfilled and was cancelled: look for a new candidate. 'waiting' =
 * do nothing else this tick. 'filled' = open the plan at `limitPrice`; the
 * order is already cleared, so a second tick cannot open it again.
 */
export async function checkRestingEntry(
  key: string,
  now: number,
  getMark: (asset: string) => Promise<number | null>,
): Promise<RestingEntryState> {
  const entry = await getCronState<RestingEntry>(key);
  if (!entry?.plan) return { state: 'none' };
  if (now >= entry.expiresAt) {
    await setCronState(key, null);
    return { state: 'none' };
  }
  const mark = await getMark(entry.plan.asset);
  if (!mark || !restingFilled(entry.plan.side === 'LONG' ? 'buy' : 'sell', entry.limitPrice, mark, entry.plan.asset)) {
    return { state: 'waiting', entry };
  }
  await setCronState(key, null);
  return { state: 'filled', entry };
}
