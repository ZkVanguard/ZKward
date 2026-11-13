/**
 * Every paper book in one read: what it tests, whether it is switched on,
 * its closed trades and its open positions from its rows, and the interest
 * credited to its cash where a book has one (assumed, in no row, kept apart).
 *
 * One definition for the chat's get_paper_books, the paper page and the
 * Discord scoreboard: before it, the page and the scoreboard showed only the
 * two signal books, which open nothing while no signal is proven, so the
 * books that held money were invisible.
 */
import { envFlag } from '@/lib/utils/env-flag';
import type { PaperBookSummary } from '@/lib/types/paper-books';

export type { PaperBookSummary };

export interface PaperBookDef {
  id: number;
  name: string;
  tests: string;
  /** The book's off switch; a book without one runs whenever the fast tick runs. */
  disableFlag?: string;
  /** Where the book keeps the interest credited to its cash. */
  interestKey?: string;
}

export const PAPER_BOOKS: readonly PaperBookDef[] = [
  { id: -3, name: 'PaperTrader', tests: 'the full signal strategy; opens only signals the ledger has proven' },
  { id: -4, name: 'PaperGated', tests: 'the same strategy with entry gates removed one at a time' },
  { id: -5, name: 'Oracle', tests: 'every fresh model interpretation at its own horizon', disableFlag: 'ORACLE_TRADER_DISABLE' },
  { id: -6, name: 'Solana sleeve', tests: 'a sleeve sized off the Solana test pool', disableFlag: 'SOLANA_SLEEVE_DISABLE' },
  { id: -7, name: 'LeadTrader', tests: 'one ledger source (Kalshi, BTC and ETH) held to its 240-minute horizon', disableFlag: 'LEAD_TRADER_DISABLE' },
  { id: -8, name: 'FloorTrader', tests: 'long BTC and ETH sized to keep the book above 90% of its peak; no signal', disableFlag: 'FLOOR_TRADER_DISABLE' },
  { id: -9, name: 'FloorLadderTrader', tests: 'the floor rule sized by the move the strike ladder prices', disableFlag: 'FLOOR_LADDER_TRADER_DISABLE' },
  { id: -10, name: 'TrendTrader', tests: 'BTC and ETH, each held as spot at 12.5% of the book while its last daily close is above its 100-day average, decided once a day; few trades by design', disableFlag: 'TREND_TRADER_DISABLE' },
  { id: -11, name: 'CoreTrader', tests: 'the floor rule (BTC and ETH sized to keep the book above 90% of its peak) holding a coin only while it is above its 100-day average, as spot; its cash is credited an assumed 4% a year', disableFlag: 'CORE_TRADER_DISABLE', interestKey: 'core-trader:state' },
  { id: -12, name: 'ShortTrader', tests: 'the core rule turned down: BTC and ETH sold short on the perp, sized by the floor rule, while a coin is below its 100-day average and below its close 30 days before; cash otherwise, credited an assumed 4% a year', disableFlag: 'SHORT_TRADER_DISABLE', interestKey: 'short-trader:state' },
  { id: -13, name: 'ProvenTrader', tests: 'the combined signal traded only while the ledger proves it above the round-trip cost, exactly as proven: resting entry at the reading price, exit at the 60-minute horizon, $1,000 at 1x', disableFlag: 'PROVEN_TRADER_DISABLE' },
];

/** True when the book's off switch is not set. */
export function bookRunning(def: PaperBookDef, env: NodeJS.ProcessEnv = process.env): boolean {
  return !def.disableFlag || !envFlag(def.disableFlag, env);
}

/** Closed trades over the last `hours`, open positions now. Throws when any figure cannot be read. */
export async function readPaperBooks(hours = 720, now: number = Date.now()): Promise<PaperBookSummary[]> {
  const [{ query }, { bookRowStats }, { getCronStateStrict }] = await Promise.all([
    import('@/lib/db/postgres'),
    import('@/lib/db/book-row-stats'),
    import('@/lib/db/cron-state'),
  ]);
  const sinceMs = now - Math.min(Math.max(1, hours), 8760) * 3_600_000;
  const ids = PAPER_BOOKS.map((b) => b.id);
  const [open, stats, interest] = await Promise.all([
    query<{ portfolio_id: number; n: number; notional: number; pnl: number }>(
      `SELECT portfolio_id, COUNT(*)::int AS n,
              COALESCE(SUM(notional_value), 0)::float8 AS notional,
              COALESCE(SUM(current_pnl), 0)::float8 AS pnl
         FROM hedges
        WHERE portfolio_id = ANY($1) AND status = 'active'
        GROUP BY portfolio_id`,
      [ids],
    ),
    Promise.all(ids.map((id) => bookRowStats(id, sinceMs))),
    Promise.all(PAPER_BOOKS.map((b) => (b.interestKey ? getCronStateStrict<{ interestUsd?: number }>(b.interestKey) : null))),
  ]);
  return PAPER_BOOKS.map((b, i) => {
    const s = stats[i];
    if (!s) throw new Error(`could not read the closed trades of book ${b.id}`);
    const o = open.find((r) => Number(r.portfolio_id) === b.id);
    return {
      portfolioId: b.id,
      name: b.name,
      tests: b.tests,
      running: bookRunning(b),
      closed: { trades: s.trades, wins: s.wins, realizedUsd: s.realizedUsd, avgBp: s.avgBp },
      open: { positions: Number(o?.n ?? 0), notionalUsd: Number(o?.notional ?? 0), openPnlUsd: Number(o?.pnl ?? 0) },
      ...(b.interestKey ? { interestUsd: Number(interest[i]?.interestUsd ?? 0) } : {}),
    };
  });
}
