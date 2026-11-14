/**
 * The core and short books on the venue's test network: moving there closes the simulated lots once and carries
 * their result; from then on a lot is the venue's fill, recorded with its fee and account, and the book is worth
 * what its subaccount holds.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => (state.has(k) ? state.get(k) : null)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
type Row = { order_id: string; asset: string; entry: number; notional: number; size: number; held_ms: number; portfolio: number; execution: string | null; venue_fee: number | null; realized?: number };
const rows: Row[] = [];
let realized = 0;
jest.mock('@/lib/db/postgres', () => ({
  query: async (sql: string, p: unknown[]) => (sql.includes("status = 'active'") ? rows.filter((r) => r.portfolio === p[0]) : [{ realized }]),
}));
const createHedge = jest.fn(async (a: Record<string, unknown>) => {
  rows.push({ order_id: String(a.orderId), asset: String(a.asset), entry: Number(a.entryPrice), notional: Number(a.notionalValue), size: Number(a.size), held_ms: 0, portfolio: Number(a.portfolioId), execution: (a.metadata as { execution?: string } | undefined)?.execution ?? null, venue_fee: (a.metadata as { venueOpenFeeUsd?: number } | undefined)?.venueOpenFeeUsd ?? null });
});
jest.mock('@/lib/db/hedges', () => ({ createHedge: (a: Record<string, unknown>) => createHedge(a) }));
const settleHedgeRow = jest.fn(async (a: { orderId: string; result: { realizedPnlUsd: number } }) => {
  const i = rows.findIndex((r) => r.order_id === a.orderId);
  if (i >= 0) rows.splice(i, 1);
  realized += a.result.realizedPnlUsd;
  return true;
});
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({ settleHedgeRow: (a: never) => settleHedgeRow(a) }));
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({ getMultiSourceValidatedPrice: async (a: string) => ({ price: a === 'BTC' ? 80_000 : 2_500 }) }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const venueOpenLot = jest.fn(async (_id: number, asset: string, side: string, notional: number, _orderId: string, now: number) => ({
  asset, side, entryPrice: asset === 'BTC' ? 80_010 : 2_501, size: notional / (asset === 'BTC' ? 80_010 : 2_501), notionalUsd: notional, leverage: 1, openedAt: now, openFeeUsd: notional * 0.0004, slippageOpenUsd: 0,
}));
const venueCloseLot = jest.fn(async (_id: number, pos: { asset: string; side: string; entryPrice: number; size: number; notionalUsd: number; openFeeUsd: number }) => ({
  asset: pos.asset, side: pos.side, entryPrice: pos.entryPrice, exitPrice: pos.entryPrice, notionalUsd: pos.notionalUsd, size: pos.size, holdSeconds: 60,
  grossPnlUsd: 0, openFeeUsd: pos.openFeeUsd, closeFeeUsd: 0.4, slippageUsd: 0, fundingUsd: 0, realizedPnlUsd: -pos.openFeeUsd - 0.4,
}));
const venueBookValueUsd = jest.fn(async (_id: number, start: number, carried: number) => start + carried + 7);
let onVenue = true;
jest.mock('@/lib/services/paper-trader/venue-books', () => ({
  VENUE_EXECUTION: 'venue-testnet',
  VENUE_ORDERS_PER_TICK: 2,
  onVenue: () => onVenue,
  bookActor: () => ({ account: 'SubAcct111', signer: { publicKey: 'SubAcct111', sign: () => '' } }),
  venueOpenLot: (...a: Parameters<typeof venueOpenLot>) => venueOpenLot(...a),
  venueCloseLot: (...a: Parameters<typeof venueCloseLot>) => venueCloseLot(...a),
  venueBookValueUsd: (...a: Parameters<typeof venueBookValueUsd>) => venueBookValueUsd(...a),
  reconcileVenueBook: async () => ({ closed: [], flattened: [] }),
}));

import { runShortTick } from '@/lib/services/paper-trader/ShortTrader';
import { SHORT_PORTFOLIO_ID } from '@/lib/services/paper-trader/ShortTrader';
import type { CoreState } from '@/lib/services/paper-trader/CoreTrader';

const NOW = Date.parse('2026-11-14T00:10:00Z');
const falling = Array.from({ length: 101 }, (_, i) => 300 - i);
const short = () => state.get('short-trader:state') as CoreState;
const simLot = (i: number, asset = 'BTC'): Row => ({ order_id: `short_${asset}_1_${i}`, asset, entry: asset === 'BTC' ? 81_000 : 2_600, notional: 1000, size: 1000 / (asset === 'BTC' ? 81_000 : 2_600), held_ms: 3_600_000, portfolio: SHORT_PORTFOLIO_ID, execution: null, venue_fee: null });

beforeEach(() => { jest.clearAllMocks(); state.clear(); rows.length = 0; realized = 0; onVenue = true; });

describe('moving to the venue', () => {
  it('closes the simulated lots once at the mark, carries their result, and opens the lots on the venue', async () => {
    rows.push(simLot(0), simLot(1, 'ETH'));
    const s = await runShortTick(NOW, async () => falling);
    const moved = settleHedgeRow.mock.calls.filter((c) => (c[0] as unknown as { reason: string }).reason === 'moved-to-venue');
    expect(moved.map((c) => c[0].orderId).sort()).toEqual(['short_BTC_1_0', 'short_ETH_1_1']);
    expect(short().venue).toEqual({ since: NOW, carriedUsd: realized - (realized - short().venue!.carriedUsd) });
    expect(short().venue!.since).toBe(NOW);
    // The value comes from the venue: start + carried + the subaccount's gain (7 here).
    expect(venueBookValueUsd).toHaveBeenCalledWith(SHORT_PORTFOLIO_ID, 100_000, short().venue!.carriedUsd);
    // At most VENUE_ORDERS_PER_TICK real orders a tick: the rest wait for the next tick, a minute later.
    expect(s.bought).toBe(2);
    expect(venueOpenLot).toHaveBeenCalledTimes(2);
  });

  it('a new lot is the venue fill, recorded with its fee and its subaccount, as a perp', async () => {
    await runShortTick(NOW, async () => falling);
    const [args] = createHedge.mock.calls[0];
    expect(args).toMatchObject({ side: 'SHORT', market: 'BTC-PERP', entryPrice: 80_010, metadata: { execution: 'venue-testnet', venueAccount: 'SubAcct111', venueOpenFeeUsd: 0.4 } });
    expect(String(args.reason)).toContain('venue test network');
  });

  it('a venue lot closes through the venue the day the rule turns off', async () => {
    await runShortTick(NOW, async () => falling);
    const rising = Array.from({ length: 101 }, (_, i) => 100 + i);
    const s = await runShortTick(NOW + 86_400_000, async () => rising);
    expect(s.sold).toBe(2);
    expect(venueCloseLot).toHaveBeenCalledTimes(2);
    expect(rows.filter((r) => r.execution === 'venue-testnet')).toHaveLength(0);
  });
});

describe('off the venue', () => {
  it('nothing touches the venue', async () => {
    onVenue = false;
    await runShortTick(NOW, async () => falling);
    expect(venueOpenLot).not.toHaveBeenCalled();
    expect(venueBookValueUsd).not.toHaveBeenCalled();
    expect(createHedge.mock.calls[0][0]).not.toHaveProperty('metadata');
  });
});
