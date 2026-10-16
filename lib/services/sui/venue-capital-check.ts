/**
 * Once a day: does the venue account match the records?
 *
 * The account's value moves only by capital in or out (`venue_capital`) and by
 * trade results (the pool's venue rows: realized on close, current mark while
 * open). Before the records existed the account had lost about $50 that no
 * row explained; that gap is the baseline (`venue-check:baseline`, recorded
 * 2026-10-16 with the backfill), and only results after it are added here.
 *
 *   expected = net capital + baseline + results since the baseline
 *
 * A gap over $0.50 is an ERROR naming the gap: money moved that no record
 * explains. A failed read throws; nothing here passes on an unknown.
 */
import { query } from '@/lib/db/postgres';
import { getCronStateStrict } from '@/lib/db/cron-state';
import { TRADE_OUTCOME_SQL } from '@/lib/db/hedges';

export const VENUE_GAP_TOLERANCE_USD = 0.5;

export interface VenueCheck {
  accountValueUsd: number;
  expectedUsd: number;
  gapUsd: number;
  ok: boolean;
  parts: { netCapitalUsd: number; baselineUsd: number; realizedSinceUsd: number; openUsd: number };
}

/** Pure: the comparison itself. */
export function compareVenue(accountValueUsd: number, parts: VenueCheck['parts']): VenueCheck {
  const expectedUsd = parts.netCapitalUsd + parts.baselineUsd + parts.realizedSinceUsd + parts.openUsd;
  const gapUsd = accountValueUsd - expectedUsd;
  return { accountValueUsd, expectedUsd, gapUsd, ok: Math.abs(gapUsd) <= VENUE_GAP_TOLERANCE_USD, parts };
}

/** Null until a baseline is recorded: there is nothing to compare against yet. */
export async function checkVenueCapital(accountValueUsd: number): Promise<VenueCheck | null> {
  if (!Number.isFinite(accountValueUsd)) throw new Error('venue account value unreadable');
  const baseline = await getCronStateStrict<{ usd: number; atMs: number }>('venue-check:baseline');
  if (!baseline || !Number.isFinite(baseline.usd) || !Number.isFinite(baseline.atMs)) return null;
  const [cap] = await query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount_usd ELSE -amount_usd END), 0)::text AS net FROM venue_capital`,
  );
  const since = new Date(baseline.atMs).toISOString();
  const [res] = await query<{ realized: string; open: string }>(
    `SELECT COALESCE(SUM(realized_pnl) FILTER (WHERE status IN ('closed', 'liquidated') AND closed_at > $1), 0)::text AS realized,
            COALESCE(SUM(current_pnl) FILTER (WHERE status = 'active'), 0)::text AS open
       FROM hedges
      WHERE portfolio_id = -2 AND chain = 'sui' AND notional_value >= 1 AND ${TRADE_OUTCOME_SQL}`,
    [since],
  );
  return compareVenue(accountValueUsd, {
    netCapitalUsd: Number(cap?.net ?? NaN),
    baselineUsd: baseline.usd,
    realizedSinceUsd: Number(res?.realized ?? NaN),
    openUsd: Number(res?.open ?? NaN),
  });
}
