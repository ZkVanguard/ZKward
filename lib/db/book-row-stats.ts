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
}

/** Closed trades of `portfolioId` since `sinceMs`. Returns null when the read fails. */
export async function bookRowStats(portfolioId: number, sinceMs: number): Promise<BookRowStats | null> {
  try {
    const rows = await query<{ n: number; wins: number | null; losses: number | null; realized: number | null }>(
      `SELECT COUNT(*)::int AS n,
              SUM((realized_pnl > 0)::int)::int AS wins,
              SUM((realized_pnl <= 0)::int)::int AS losses,
              COALESCE(SUM(realized_pnl), 0)::float AS realized
         FROM hedges
        WHERE portfolio_id = $1 AND status = 'closed' AND closed_at > to_timestamp($2 / 1000.0)`,
      [portfolioId, sinceMs],
    );
    const r = rows[0];
    if (!r) return null;
    return { trades: r.n ?? 0, wins: r.wins ?? 0, losses: r.losses ?? 0, realizedUsd: r.realized ?? 0 };
  } catch {
    return null;
  }
}
