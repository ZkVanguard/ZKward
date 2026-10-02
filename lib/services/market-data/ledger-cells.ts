/**
 * Signal-ledger cells — per-(source, asset, horizon) evidence from
 * `signal_outcomes`, what the traders act on. Rows from before the signal
 * epoch are ignored — the aggregator changed meaning on 2026-09-30 16:55Z.
 *
 * Admission is by expectancy, on independent evidence (2026-10-02). The
 * first version admitted a horizon on hit rate > 50% over n >= 50 rows.
 * Rows overlap, so "BTC 240 min, 55%, n = 202" was nine independent
 * windows with a mean return of -4 bp in the signal's direction, and the
 * books paid about 17 bp of round-trip friction per trade to hold it: a
 * 36% win rate is what a zero-edge trade earns at that cost. A horizon is
 * now admitted only when, across enough non-overlapping windows, the mean
 * return in the signal's direction less one standard error exceeds
 * friction. The ledger scores every signal whether or not anything
 * trades, so skipping an asset never starves the evidence that would
 * re-admit it.
 */
import { getLedgerHitRates } from '@/lib/db/signal-outcomes';
import { logger } from '@/lib/utils/logger';

export interface LedgerCell {
  source: string;
  asset: string;
  horizonMin: number;
  n: number;
  hitRate: number;
  /** Non-overlapping horizon-length windows behind the cell. */
  windows?: number;
  /** Mean return in the signal's direction across those windows, in bp. */
  meanBp?: number;
  /** Standard error of that mean, in bp. */
  seBp?: number;
}

const num = (key: string, dflt: number): number => {
  const v = Number((process.env[key] || '').trim());
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const LEDGER_WINDOW_DAYS = num('SIGNAL_LEDGER_WINDOW_DAYS', 14);
export const LEDGER_MIN_N = num('SIGNAL_LEDGER_MIN_N', 50);
/** Rows before this were scored against the pre-odds aggregator. */
export const LEDGER_EPOCH_MS = num('SIGNAL_LEDGER_EPOCH_MS', Date.parse('2026-09-30T16:55:00Z'));
/** Horizons a book may hold to; the ledger picks the best one per asset. */
export const HOLD_HORIZON_CANDIDATES_MIN: readonly number[] = (process.env.PAPER_TRADER_HOLD_HORIZONS_MIN || '60,240')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/** Independent windows a cell needs before it says anything about an asset. */
export const LEDGER_MIN_WINDOWS = num('SIGNAL_LEDGER_MIN_WINDOWS', 20);
/** Round-trip cost a trade must clear: taker fees both sides plus slippage. */
export const LEDGER_FRICTION_BP = num('SIGNAL_LEDGER_FRICTION_BP', 17);
/** Recent windows needed before the recency check can veto a horizon. */
export const LEDGER_RECENT_MIN_WINDOWS = num('SIGNAL_LEDGER_RECENT_MIN_WINDOWS', 8);

/** What a trade at this cell is expected to keep after friction, at one standard error of caution. */
export function netEdgeBp(c: LedgerCell): number {
  return (c.meanBp ?? 0) - (c.seBp ?? Number.POSITIVE_INFINITY) - LEDGER_FRICTION_BP;
}
/**
 * Recency gate (2026-10-02): the 14-day cell can average across regimes —
 * BTC's 240 m hit rate ran 65% → 61% → 56% across successive 12 h buckets
 * while the 24 h horizon flipped from 39% to 72%. A horizon is admitted only
 * if it also holds above a coin flip over this recent window, when the
 * window has enough rows to say anything.
 */
export const LEDGER_RECENT_HOURS = num('SIGNAL_LEDGER_RECENT_HOURS', 48);
export const LEDGER_RECENT_MIN_N = num('SIGNAL_LEDGER_RECENT_MIN_N', 20);

const CACHE_TTL_MS = 60_000;

/** 60 s cache around one hit-rate read; fails open to the last good read. */
function cachedCells(load: () => Promise<LedgerCell[]>, label: string) {
  let cache: { at: number; cells: LedgerCell[] } | null = null;
  let inflight: Promise<LedgerCell[]> | null = null;
  const get = async (now: number = Date.now()): Promise<LedgerCell[]> => {
    if (cache && now - cache.at < CACHE_TTL_MS) return cache.cells;
    if (inflight) return inflight;
    inflight = load()
      .then((cells) => {
        cache = { at: Date.now(), cells };
        return cells;
      })
      .catch((e) => {
        logger.warn(`[LedgerCells] ${label} fetch failed (fail-open)`, { error: e instanceof Error ? e.message : String(e) });
        return cache?.cells ?? [];
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  const reset = () => {
    cache = null;
    inflight = null;
  };
  return { get, reset };
}

const windowCells = cachedCells(
  () => getLedgerHitRates({ windowDays: LEDGER_WINDOW_DAYS, minN: LEDGER_MIN_N, sinceMs: LEDGER_EPOCH_MS }),
  'window',
);
const recentCells = cachedCells(
  () => getLedgerHitRates({ windowDays: LEDGER_RECENT_HOURS / 24, minN: LEDGER_RECENT_MIN_N, sinceMs: LEDGER_EPOCH_MS }),
  'recent',
);

/** Cells with n ≥ LEDGER_MIN_N over LEDGER_WINDOW_DAYS since the epoch. */
export const getLedgerCells = windowCells.get;
/** Cells with n ≥ LEDGER_RECENT_MIN_N over the last LEDGER_RECENT_HOURS. */
export const getRecentLedgerCells = recentCells.get;

export function _resetLedgerCellsCache(): void {
  windowCells.reset();
  recentCells.reset();
}

export function findCell(cells: readonly LedgerCell[], source: string, asset: string, horizonMin: number): LedgerCell | null {
  const upper = asset.toUpperCase();
  return cells.find((c) => c.source === source && c.asset.toUpperCase() === upper && c.horizonMin === horizonMin) ?? null;
}

export interface HoldPlan {
  horizonMin: number;
  hitRate: number;
  n: number;
  windows: number;
  meanBp: number;
}

/**
 * The hold horizon with the best measured expectancy for an asset's
 * aggregate signal. `measured` says whether the ledger has enough
 * independent windows on this asset at any candidate horizon: measured + no
 * plan = nothing here clears friction, skip it; unmeasured = cold asset,
 * caller falls back to its default hold.
 * `recent` cells (last LEDGER_RECENT_HOURS) veto a horizon whose edge has
 * gone: a recent cell with enough windows and a mean at or below zero drops
 * that horizon; a thin or absent recent cell leaves the decision alone.
 */
export function assetHoldPlan(
  cells: readonly LedgerCell[],
  asset: string,
  candidates: readonly number[] = HOLD_HORIZON_CANDIDATES_MIN,
  recent: readonly LedgerCell[] = [],
): { plan: HoldPlan | null; measured: boolean } {
  const upper = asset.toUpperCase();
  const measured = cells.filter(
    (c) =>
      c.source === 'aggregate' && c.asset.toUpperCase() === upper && candidates.includes(c.horizonMin) &&
      (c.windows ?? 0) >= LEDGER_MIN_WINDOWS,
  );
  if (measured.length === 0) return { plan: null, measured: false };
  const holdsRecently = (c: LedgerCell): boolean => {
    const r = findCell(recent, 'aggregate', upper, c.horizonMin);
    return !r || (r.windows ?? 0) < LEDGER_RECENT_MIN_WINDOWS || (r.meanBp ?? 0) > 0;
  };
  const eligible = measured.filter((c) => netEdgeBp(c) > 0 && holdsRecently(c));
  if (eligible.length === 0) return { plan: null, measured: true };
  const best = eligible.reduce((a, b) => (netEdgeBp(b) > netEdgeBp(a) ? b : a));
  return {
    plan: { horizonMin: best.horizonMin, hitRate: best.hitRate, n: best.n, windows: best.windows ?? 0, meanBp: best.meanBp ?? 0 },
    measured: true,
  };
}

export async function ledgerHoldPlan(asset: string): Promise<{ plan: HoldPlan | null; measured: boolean }> {
  const [cells, recent] = await Promise.all([getLedgerCells(), getRecentLedgerCells()]);
  return assetHoldPlan(cells, asset, undefined, recent);
}
