/**
 * Signal-ledger cells — per-(source, asset, horizon) hit rates from
 * `signal_outcomes`, the measured evidence the traders act on.
 *
 * 2026-10-01: 12.7k resolved rows since the odds-based signals shipped
 * said the aggregate signal is right 58–61% of the time at 240 min on
 * BTC/ETH and a coin flip at 30–60 min, while the paper books held for
 * 73–96 min and closed 80% of max-hold exits red. Holds, admission and
 * source weights now read these cells: trade the horizon where the signal
 * works, skip assets where it measurably doesn't, weight sources by what
 * they actually hit. Rows from before the signal epoch are ignored — the
 * aggregator changed meaning on 2026-09-30 16:55Z.
 */
import { getLedgerHitRates } from '@/lib/db/signal-outcomes';
import { logger } from '@/lib/utils/logger';

export interface LedgerCell {
  source: string;
  asset: string;
  horizonMin: number;
  n: number;
  hitRate: number;
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
/** A horizon counts as an edge only above a coin flip. */
export const LEDGER_MIN_EDGE = 0.5;

const CACHE_TTL_MS = 60_000;
let cache: { at: number; cells: LedgerCell[] } | null = null;
let inflight: Promise<LedgerCell[]> | null = null;

/** Cells with n ≥ LEDGER_MIN_N since the epoch; cached 60s, fail-open to the last good read. */
export async function getLedgerCells(now: number = Date.now()): Promise<LedgerCell[]> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.cells;
  if (inflight) return inflight;
  inflight = getLedgerHitRates({ windowDays: LEDGER_WINDOW_DAYS, minN: LEDGER_MIN_N, sinceMs: LEDGER_EPOCH_MS })
    .then((cells) => {
      cache = { at: Date.now(), cells };
      return cells;
    })
    .catch((e) => {
      logger.warn('[LedgerCells] fetch failed (fail-open)', { error: e instanceof Error ? e.message : String(e) });
      return cache?.cells ?? [];
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function _resetLedgerCellsCache(): void {
  cache = null;
  inflight = null;
}

export function findCell(cells: readonly LedgerCell[], source: string, asset: string, horizonMin: number): LedgerCell | null {
  const upper = asset.toUpperCase();
  return cells.find((c) => c.source === source && c.asset.toUpperCase() === upper && c.horizonMin === horizonMin) ?? null;
}

export interface HoldPlan {
  horizonMin: number;
  hitRate: number;
  n: number;
}

/**
 * The hold horizon with the best measured edge for an asset's aggregate
 * signal. `measured` says whether the ledger has enough data on this asset
 * at all: measured + no plan = the signal has no edge here, skip it;
 * unmeasured = cold asset, caller falls back to its default hold.
 */
export function assetHoldPlan(
  cells: readonly LedgerCell[],
  asset: string,
  candidates: readonly number[] = HOLD_HORIZON_CANDIDATES_MIN,
): { plan: HoldPlan | null; measured: boolean } {
  const upper = asset.toUpperCase();
  const measured = cells.filter(
    (c) => c.source === 'aggregate' && c.asset.toUpperCase() === upper && candidates.includes(c.horizonMin) && c.n >= LEDGER_MIN_N,
  );
  if (measured.length === 0) return { plan: null, measured: false };
  const best = measured.reduce((a, b) => (b.hitRate > a.hitRate ? b : a));
  if (best.hitRate <= LEDGER_MIN_EDGE) return { plan: null, measured: true };
  return { plan: { horizonMin: best.horizonMin, hitRate: best.hitRate, n: best.n }, measured: true };
}

export async function ledgerHoldPlan(asset: string): Promise<{ plan: HoldPlan | null; measured: boolean }> {
  return assetHoldPlan(await getLedgerCells(), asset);
}
