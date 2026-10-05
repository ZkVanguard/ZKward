/**
 * Signal-ledger cells — per-(source, asset, horizon) evidence from
 * `signal_outcomes`, what the traders and the aggregator act on. Rows from
 * before the signal epoch are ignored — the aggregator changed meaning on
 * 2026-09-30 16:55Z.
 *
 * Decisions read TIMING, never the hit rate (2026-10-02). A hit rate over
 * ledger rows fails twice: the rows overlap, so two hundred of them at a
 * 240 min horizon are about ten independent observations; and it rewards
 * drift, so a source that said DOWN for two days in a falling market scores
 * 58% and knows nothing. Under that rule about half of all source cells
 * were being removed and others boosted on roughly ten windows of noise.
 * A cell now acts only when its drift-removed return, over non-overlapping
 * windows, is beyond LEDGER_TIMING_SE standard errors: wrong-way sources and
 * assets are dropped, proven ones lifted, and everything unproven is left
 * alone — which also means nothing is blocked on evidence it cannot get.
 */
import { getLedgerHitRates } from '@/lib/db/signal-outcomes';
import { logger } from '@/lib/utils/logger';

export interface LedgerCell {
  source: string;
  asset: string;
  horizonMin: number;
  n: number;
  hitRate: number;
  /** Non-overlapping horizon-length windows behind the timing figures. */
  windows?: number;
  /** Mean return in the source's direction with the asset's drift removed, in bp. */
  timingBp?: number;
  /** Standard error of that mean, in bp. */
  timingSeBp?: number;
}

const num = (key: string, dflt: number): number => {
  const v = Number((process.env[key] || '').trim());
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const LEDGER_WINDOW_DAYS = num('SIGNAL_LEDGER_WINDOW_DAYS', 14);
export const LEDGER_MIN_N = num('SIGNAL_LEDGER_MIN_N', 50);
/** Independent windows a cell needs before its timing says anything. */
export const LEDGER_MIN_WINDOWS = num('SIGNAL_LEDGER_MIN_WINDOWS', 12);
/** Standard errors from zero before a cell counts as wrong-way or proven. */
export const LEDGER_TIMING_SE = num('SIGNAL_LEDGER_TIMING_SE', 2);
/**
 * Horizon sources are weighted and judged at. 60 min is the longest with
 * enough independent windows to rate a source within days (about 45 per
 * cell in two days; 240 min gives about 12), and the aggregate has no
 * measured edge beyond it.
 */
export const LEDGER_WEIGHT_HORIZON_MIN = num('SIGNAL_LEDGER_WEIGHT_HORIZON_MIN', 60);
/** Rows before this were scored against the pre-odds aggregator. */
export const LEDGER_EPOCH_MS = num('SIGNAL_LEDGER_EPOCH_MS', Date.parse('2026-09-30T16:55:00Z'));
/** Horizons a book may hold to; the ledger picks the best one per asset. */
export const HOLD_HORIZON_CANDIDATES_MIN: readonly number[] = (process.env.PAPER_TRADER_HOLD_HORIZONS_MIN || '60,240')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/**
 * Recency window: a 14-day cell can average across regimes, so a horizon
 * that has turned wrong-way over the last hours is dropped even while the
 * long window still looks fine.
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

export type TimingVerdict = 'wrong-way' | 'proven' | 'unproven';

/**
 * What a cell says about timing. 'wrong-way': following it lost against the
 * asset's own drift, beyond LEDGER_TIMING_SE standard errors. 'proven': it
 * gained, by the same margin. 'unproven': too few independent windows, or
 * inside the noise — where a source that never changes direction always
 * lands, whatever its hit rate.
 */
export function timingVerdict(c: LedgerCell | null | undefined): TimingVerdict {
  if (!c || (c.windows ?? 0) < LEDGER_MIN_WINDOWS) return 'unproven';
  const se = c.timingSeBp ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(se)) return 'unproven';
  const mean = c.timingBp ?? 0;
  if (mean + LEDGER_TIMING_SE * se < 0) return 'wrong-way';
  if (mean - LEDGER_TIMING_SE * se > 0) return 'proven';
  return 'unproven';
}

export interface HoldPlan {
  horizonMin: number;
  hitRate: number;
  n: number;
}

/**
 * The hold horizon for an asset's aggregate signal: the candidate with the
 * best timing among those not measured wrong-way. `measured` says whether
 * the ledger has data on this asset at all: measured + no plan = the
 * aggregate is wrong-way at every candidate horizon, skip the asset;
 * unmeasured = cold asset, the caller keeps its default hold.
 * `recent` cells (last LEDGER_RECENT_HOURS) drop a horizon that has turned
 * wrong-way lately; a thin or absent recent cell changes nothing.
 */
export function assetHoldPlan(
  cells: readonly LedgerCell[],
  asset: string,
  candidates: readonly number[] = HOLD_HORIZON_CANDIDATES_MIN,
  recent: readonly LedgerCell[] = [],
): { plan: HoldPlan | null; measured: boolean } {
  const upper = asset.toUpperCase();
  const measured = cells.filter(
    (c) => c.source === 'aggregate' && c.asset.toUpperCase() === upper && candidates.includes(c.horizonMin) && c.n >= LEDGER_MIN_N,
  );
  if (measured.length === 0) return { plan: null, measured: false };
  const eligible = measured.filter(
    (c) => timingVerdict(c) !== 'wrong-way' && timingVerdict(findCell(recent, 'aggregate', upper, c.horizonMin)) !== 'wrong-way',
  );
  if (eligible.length === 0) return { plan: null, measured: true };
  const best = eligible.reduce((a, b) => ((b.timingBp ?? 0) > (a.timingBp ?? 0) ? b : a));
  return { plan: { horizonMin: best.horizonMin, hitRate: best.hitRate, n: best.n }, measured: true };
}

export async function ledgerHoldPlan(asset: string): Promise<{ plan: HoldPlan | null; measured: boolean }> {
  const [cells, recent] = await Promise.all([getLedgerCells(), getRecentLedgerCells()]);
  return assetHoldPlan(cells, asset, undefined, recent);
}
