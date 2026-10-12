/**
 * Venue positions that nothing in the system will close.
 *
 * On 2026-10-07 the live trader's close failed, it cleared its own record of
 * the trade, and a 5x position sat on the venue for days: the row said active,
 * the trader said nothing was open, and no check compared the two.
 */

export interface VenuePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
}

export interface ActivePoolRow {
  market: string | null;
  side: string;
  order_id: string;
}

export type UnmanagedReason =
  /** The venue holds it and no active row describes it. */
  | 'no-row'
  /** The row belongs to the live trader, and the trader no longer tracks a trade on that symbol. */
  | 'trader-lost-track';

export interface UnmanagedPosition extends VenuePosition {
  reason: UnmanagedReason;
  /** Consecutive runs it has been seen unmanaged. */
  seen: number;
}

export const UNMANAGED_KEY = 'venue:unmanaged-positions';
/** One sighting can be a trade mid-open or mid-close; two runs apart is not. */
export const UNMANAGED_ALERT_AFTER = 2;

export interface UnmanagedState {
  at: number;
  positions: UnmanagedPosition[];
}

const LIVE_TRADER_PREFIX = 'polyedge_';

export function findUnmanagedPositions(
  venue: VenuePosition[],
  activeRows: ActivePoolRow[],
  traderSymbol: string | null,
  previous: UnmanagedPosition[] = [],
): UnmanagedPosition[] {
  const out: UnmanagedPosition[] = [];
  for (const p of venue) {
    if (!(p.size > 0)) continue;
    const rows = activeRows.filter((r) => r.market === p.symbol && r.side === p.side);
    let reason: UnmanagedReason | null = null;
    if (rows.length === 0) reason = 'no-row';
    else if (rows.every((r) => r.order_id.startsWith(LIVE_TRADER_PREFIX)) && traderSymbol !== p.symbol) reason = 'trader-lost-track';
    if (!reason) continue;
    const before = previous.find((q) => q.symbol === p.symbol && q.side === p.side);
    out.push({ symbol: p.symbol, side: p.side, size: p.size, reason, seen: (before?.seen ?? 0) + 1 });
  }
  return out;
}

export function describeUnmanaged(p: UnmanagedPosition): string {
  const why = p.reason === 'no-row' ? 'no active row' : 'the live trader no longer tracks it';
  return `${p.symbol} ${p.side} ${p.size} (${why})`;
}
