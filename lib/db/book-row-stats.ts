/**
 * A simulated book's closed-trade record, read from its `hedges` rows.
 *
 * The books also keep counters in `cron_state`, but a counter is a
 * read-modify-write that two overlapping ticks can both apply: a position
 * closed twice once left the main book showing 48 trades against 47 rows.
 * Anything shown to a user reads the rows.
 */
import { query } from '@/lib/db/postgres';

export interface BookRowStats {
  trades: number;
  wins: number;
  /** Realized at or below zero, matching how the books count a loss. */
  losses: number;
  realizedUsd: number;
  /** Mean realized P&L per trade, in bp of the trade's notional. The win rate means nothing without it. */
  avgBp: number;
  /** How the trades closed, from the close reason on the row. */
  takeProfits: number;
  stops: number;
  timeLimits: number;
}

/** Closed trades of `portfolioId` since `sinceMs`. Returns null when the read fails. */
export async function bookRowStats(portfolioId: number, sinceMs: number): Promise<BookRowStats | null> {
  try {
    const rows = await query<{
      n: number; wins: number | null; losses: number | null; realized: number | null;
      avg_bp: number | null; tp: number | null; stops: number | null; time_limits: number | null;
    }>(
      `SELECT COUNT(*)::int AS n,
              SUM((realized_pnl > 0)::int)::int AS wins,
              SUM((realized_pnl <= 0)::int)::int AS losses,
              COALESCE(SUM(realized_pnl), 0)::float AS realized,
              COALESCE(AVG(realized_pnl / NULLIF(notional_value, 0) * 10000), 0)::float AS avg_bp,
              SUM((reason ILIKE '%close: take-profit%')::int)::int AS tp,
              SUM((reason ILIKE '%close: stop-loss%')::int)::int AS stops,
              SUM((reason ILIKE '%close: max-hold%')::int)::int AS time_limits
         FROM hedges
        WHERE portfolio_id = $1 AND status = 'closed' AND closed_at > to_timestamp($2 / 1000.0)`,
      [portfolioId, sinceMs],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      trades: r.n ?? 0,
      wins: r.wins ?? 0,
      losses: r.losses ?? 0,
      realizedUsd: r.realized ?? 0,
      avgBp: r.avg_bp ?? 0,
      takeProfits: r.tp ?? 0,
      stops: r.stops ?? 0,
      timeLimits: r.time_limits ?? 0,
    };
  } catch {
    return null;
  }
}

export interface BookOpenPosition {
  portfolioId: number;
  asset: string;
  side: string;
  openedAtMs: number;
  entryPrice: number;
  notionalUsd: number;
}

/** Active rows of the given books. Throws when the read fails. */
export async function bookOpenPositions(portfolioIds: readonly number[]): Promise<BookOpenPosition[]> {
  const rows = await query<{ portfolio_id: number; asset: string; side: string; opened_ms: number; entry: number | null; notional: number | null }>(
    `SELECT portfolio_id, asset, side, (EXTRACT(EPOCH FROM created_at) * 1000)::float8 AS opened_ms,
            entry_price::float8 AS entry, notional_value::float8 AS notional
       FROM hedges
      WHERE portfolio_id = ANY($1) AND status = 'active'
      ORDER BY created_at`,
    [portfolioIds],
  );
  return rows.map((r) => ({
    portfolioId: r.portfolio_id,
    asset: r.asset,
    side: r.side,
    openedAtMs: Number(r.opened_ms),
    entryPrice: Number(r.entry) || 0,
    notionalUsd: Number(r.notional) || 0,
  }));
}
