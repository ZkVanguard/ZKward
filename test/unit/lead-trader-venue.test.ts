/**
 * The proven book on the venue's test network: its resting entry is a real post-only order at the reading's
 * price, a fill becomes a row with the venue's price, fee and account, and the exit at the horizon is a venue order.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => (state.has(k) ? state.get(k) : null)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown[]>>();
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, params: unknown[]) => query(sql, params) }));
const createHedge = jest.fn(async (_: Record<string, unknown>) => {});
jest.mock('@/lib/db/hedges', () => ({ createHedge: (a: Record<string, unknown>) => createHedge(a) }));
const settleHedgeRow = jest.fn<(a: Record<string, unknown>) => Promise<boolean>>(async () => true);
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({ settleHedgeRow: (a: Record<string, unknown>) => settleHedgeRow(a) }));
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({ getMultiSourceValidatedPrice: async () => ({ price: 85_000 }) }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('@/lib/services/market-data/feedback-loop', () => ({ getLoopState: async () => ({}), tradeVerdict: () => 'proven' }));

const venuePlaceEntry = jest.fn(async (..._a: unknown[]) => {});
type EntryState = { state: 'resting' } | { state: 'gone' } | { state: 'filled'; position: Record<string, unknown> };
const venueEntryState = jest.fn<(...a: unknown[]) => Promise<EntryState>>(async () => ({ state: 'resting' }));
const venueCloseLot = jest.fn(async (_id: number, pos: { asset: string; side: string; entryPrice: number; size: number; notionalUsd: number }) => ({
  asset: pos.asset, side: pos.side, entryPrice: pos.entryPrice, exitPrice: 85_300, notionalUsd: pos.notionalUsd, size: pos.size, holdSeconds: 3600,
  grossPnlUsd: 3.5, openFeeUsd: 0.15, closeFeeUsd: 0.4, slippageUsd: 0, fundingUsd: 0, realizedPnlUsd: 2.95,
}));
jest.mock('@/lib/services/paper-trader/venue-books', () => ({
  VENUE_EXECUTION: 'venue-testnet',
  VENUE_ORDERS_PER_TICK: 2,
  onVenue: (id: number) => id === -13,
  bookActor: () => ({ account: 'ProvenSub111', signer: { publicKey: 'ProvenSub111', sign: () => '' } }),
  venuePlaceEntry: (...a: unknown[]) => venuePlaceEntry(...a),
  venueEntryState: (...a: unknown[]) => venueEntryState(...a),
  venueCloseLot: (...a: Parameters<typeof venueCloseLot>) => venueCloseLot(...a),
  reconcileVenueBook: async () => ({ closed: [], flattened: [] }),
}));

import { ProvenTrader } from '@/lib/services/paper-trader/ProvenTrader';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const MIN = 60_000;
const reading = { source: 'aggregate', asset: 'BTC', direction: 'UP', entry_price: 85_000, reading_at_ms: NOW - 30_000 };

beforeEach(() => { jest.clearAllMocks(); state.clear(); query.mockResolvedValue([]); });
afterEach(() => { state.clear(); });

describe('the proven book on the venue', () => {
  it('rests a real post-only order at the reading’s price, then records the fill the venue reports', async () => {
    query.mockResolvedValueOnce([reading]);
    const placed = await ProvenTrader.runTick(NOW);
    expect(placed).toMatchObject({ placed: 1, resting: 1 });
    expect(venuePlaceEntry).toHaveBeenCalledWith(-13, 'BTC', 'LONG', 1000, 85_000, `proven_BTC_${Math.floor((NOW - 30_000) / 1000)}`);
    const [entry] = state.get('proven-trader:resting-entries') as Array<{ venueOrderId: string }>;
    expect(entry.venueOrderId).toBe(`proven_BTC_${Math.floor((NOW - 30_000) / 1000)}`);

    venueEntryState.mockResolvedValueOnce({ state: 'filled', position: { asset: 'BTC', side: 'LONG', entryPrice: 85_000, size: 0.01176, notionalUsd: 999.6, leverage: 1, openedAt: NOW + MIN, openFeeUsd: 0.15, slippageOpenUsd: 0 } });
    const filled = await ProvenTrader.runTick(NOW + MIN);
    expect(filled).toMatchObject({ filled: 1, active: 1, resting: 0 });
    expect(createHedge.mock.calls[0][0]).toMatchObject({ portfolioId: -13, entryPrice: 85_000, notionalValue: 999.6, metadata: { execution: 'venue-testnet', venueAccount: 'ProvenSub111', venueOpenFeeUsd: 0.15 } });

    const closed = await ProvenTrader.runTick(NOW - 30_000 + 60 * MIN);
    expect(closed).toMatchObject({ closed: 1, active: 0 });
    expect(venueCloseLot).toHaveBeenCalledTimes(1);
    expect(settleHedgeRow.mock.calls[0][0]).toMatchObject({ reason: 'horizon-expiry', result: { realizedPnlUsd: 2.95 } });
  });

  it('an entry the venue refuses is not kept; one that lapses unfilled is cancelled', async () => {
    query.mockResolvedValueOnce([reading]);
    venuePlaceEntry.mockRejectedValueOnce(new Error('perp venue /api/v1/orders/create: post only would cross'));
    expect(await ProvenTrader.runTick(NOW)).toMatchObject({ placed: 0, resting: 0 });

    query.mockResolvedValueOnce([reading]);
    await ProvenTrader.runTick(NOW + 1);
    venueEntryState.mockResolvedValueOnce({ state: 'gone' });
    expect(await ProvenTrader.runTick(NOW + 20 * MIN)).toMatchObject({ cancelled: 1, resting: 0, filled: 0 });
  });
});
