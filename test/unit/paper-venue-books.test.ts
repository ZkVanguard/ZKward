/**
 * Paper books on the venue's test network: a lot is the venue's real fill for our order id, never an accepted
 * order; a close is sent once per lot and a retry reads its fill; a lot's funding is its share of the real
 * payments; the venue and the rows are held to the same position; and only the test network is ever used.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const submitMarketOrder = jest.fn<(a: Record<string, unknown>) => Promise<{ orderId: number }>>(async () => ({ orderId: 1 }));
const submitLimitOrder = jest.fn<(a: Record<string, unknown>) => Promise<{ orderId: number }>>(async () => ({ orderId: 2 }));
const cancelOrder = jest.fn<(a: Record<string, unknown>) => Promise<void>>(async () => {});
const getPositions = jest.fn<(account: string) => Promise<Array<{ symbol: string; side: 'LONG' | 'SHORT'; size: number; entryPrice: number }>>>(async () => []);
const getFundingHistory = jest.fn<(account: string, limit?: number) => Promise<Array<{ symbol: string; positionSize: number; payoutUsd: number; atMs: number }>>>(async () => []);
jest.mock('@/lib/services/venue/perp-venue', () => {
  const actual = jest.requireActual('@/lib/services/venue/perp-venue') as Record<string, unknown>;
  return {
    ...actual,
    perpNetwork: () => ((process.env.SOLANA_PERPS_NETWORK || '').trim() === 'mainnet' ? 'mainnet' : 'testnet'),
    getMarket: async (symbol: string) => ({ symbol, lotSize: 0.00001, minOrderUsd: 10, maxLeverage: 50, tickSize: 1 }),
    getMarkPrice: async () => 65_000,
    submitMarketOrder: (a: Record<string, unknown>) => submitMarketOrder(a),
    submitLimitOrder: (a: Record<string, unknown>) => submitLimitOrder(a),
    cancelOrder: (a: Record<string, unknown>) => cancelOrder(a),
    getPositions: (a: string) => getPositions(a),
    getFundingHistory: (a: string, l?: number) => getFundingHistory(a, l),
  };
});

import { clientOrderId, signerFromSecret, type VenueFill, type VenueOrder } from '@/lib/services/venue/perp-venue';
import {
  bookActor, closeOrderIdOf, lotFundingUsd, reconcileVenueBook, settledFill, venueBookIds, venueCloseLot, venueEntryState,
  type VenueDeps,
} from '@/lib/services/paper-trader/venue-books';
import type { SimulatedPosition } from '@/lib/services/paper-trader/simulated-executor';

// A throwaway test key (64 bytes, base58 of a fixed seed), never a real one.
const SECRET = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256));
const NOW = Date.parse('2026-11-14T20:00:00Z');
const order = (orderId: string, over: Partial<VenueOrder> = {}): VenueOrder => ({ clientOrderId: clientOrderId(orderId), symbol: 'BTC', status: 'filled', size: 0.0002, filledSize: 0.0002, avgPrice: 65_000, ...over });
const fill = (orderId: string, over: Partial<VenueFill> = {}): VenueFill => ({ clientOrderId: clientOrderId(orderId), symbol: 'BTC', side: 'open_long', size: 0.0002, price: 65_000, feeUsd: 0.0052, atMs: NOW, ...over });
const deps = (orders: VenueOrder[][], fills: VenueFill[]): VenueDeps & { slept: number } => {
  let i = 0;
  const d = {
    slept: 0,
    getOrderHistory: (async () => orders[Math.min(i++, orders.length - 1)]) as VenueDeps['getOrderHistory'],
    getFills: (async () => fills) as VenueDeps['getFills'],
    sleep: async (ms: number) => { d.slept += ms; },
  };
  return d;
};
const lot = (orderId: string, over: Partial<SimulatedPosition> = {}) => ({
  orderId,
  position: { asset: 'BTC', side: 'LONG' as const, entryPrice: 64_000, size: 0.0002, notionalUsd: 12.8, leverage: 1, openedAt: NOW - 3_600_000, openFeeUsd: 0.005, slippageOpenUsd: 0, ...over },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SOLANA_PERPS_SIGNER_SECRET = SECRET;
  process.env.SOLANA_PERPS_NETWORK = 'testnet';
});
afterEach(() => { delete process.env.SOLANA_PERPS_SIGNER_SECRET; delete process.env.SOLANA_PERPS_NETWORK; delete process.env.PAPER_VENUE_BOOKS; });

describe('which books trade on the venue', () => {
  it('the listed books, on the test network only', () => {
    expect([...venueBookIds({ SOLANA_PERPS_NETWORK: 'testnet', PAPER_VENUE_BOOKS: '-10, -12,x,5' })]).toEqual([-10, -12]);
    expect(venueBookIds({ SOLANA_PERPS_NETWORK: 'mainnet', PAPER_VENUE_BOOKS: '-10' }).size).toBe(0);
    expect(venueBookIds({ PAPER_VENUE_BOOKS: '-10' }).size).toBe(0);
  });

  it('each book has its own subaccount, derived from the test key, never the main account', () => {
    const a = bookActor(-11, SECRET), b = bookActor(-12, SECRET);
    expect(a.account).not.toBe(b.account);
    expect(bookActor(-11, SECRET).account).toBe(a.account);
    expect(a.account).not.toBe(signerFromSecret(SECRET).publicKey);
  });
});

describe('a fill', () => {
  it('is the venue fills for our order id once the order is finished, waiting through a rate limit', async () => {
    const d = deps([[order('x', { status: 'open', filledSize: 0 })], [order('x')]], [fill('x', { size: 0.0001, price: 64_990, feeUsd: 0.0026 }), fill('x', { size: 0.0001, price: 65_010, feeUsd: 0.0026 }), fill('other')]);
    const real = d.getOrderHistory;
    let first = true;
    d.getOrderHistory = (async (a: string, l?: number) => { if (first) { first = false; throw new Error('perp venue /x: HTTP 429'); } return real(a, l); }) as VenueDeps['getOrderHistory'];
    const f = await settledFill('acct', 'x', d);
    expect(f.size).toBeCloseTo(0.0002, 12);
    expect(f.price).toBeCloseTo(65_000, 6);
    expect(f.feeUsd).toBeCloseTo(0.0052, 9);
  });

  it('an order the venue cancelled unfilled is no fill; one that never finishes is an error, not a guess', async () => {
    expect((await settledFill('acct', 'x', deps([[order('x', { status: 'cancelled', filledSize: 0 })]], []))).size).toBe(0);
    await expect(settledFill('acct', 'x', deps([[order('x', { status: 'open', filledSize: 0 })]], []))).rejects.toThrow(/did not settle/);
  });
});

describe('a close', () => {
  it('is sent once per lot: a retry reads the earlier close instead of sending another', async () => {
    const l = lot('core_BTC_1_0');
    const cid = closeOrderIdOf(l.orderId);
    const d = deps([[order(cid)]], [fill(cid, { side: 'close_long', price: 66_000, feeUsd: 0.0053 })]);
    getFundingHistory.mockResolvedValue([{ symbol: 'BTC', positionSize: 0.0004, payoutUsd: -0.02, atMs: NOW - 1_000 }]);
    const r = await venueCloseLot(-11, l.position, l.orderId, NOW, d);
    expect(submitMarketOrder).not.toHaveBeenCalled();
    expect(r.exitPrice).toBe(66_000);
    expect(r.grossPnlUsd).toBeCloseTo(0.4, 9); // (66,000 − 64,000) × 0.0002
    expect(r.fundingUsd).toBeCloseTo(-0.01, 9); // half the position paid it
    expect(r.realizedPnlUsd).toBeCloseTo(0.4 - 0.005 - 0.0053 - 0.01, 9);
  });

  it('a first close is sent reduce-only, opposite the lot, under the lot’s own close id', async () => {
    const l = lot('short_ETH_1_0', { asset: 'ETH', side: 'SHORT', entryPrice: 2_000, size: 0.5 });
    const cid = closeOrderIdOf(l.orderId);
    const d = deps([[], [order(cid, { symbol: 'ETH', size: 0.5, filledSize: 0.5 })]], [fill(cid, { symbol: 'ETH', side: 'close_short', size: 0.5, price: 1_900, feeUsd: 0.38 })]);
    const r = await venueCloseLot(-12, l.position, l.orderId, NOW, d);
    expect(submitMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ETH', side: 'LONG', size: 0.5, reduceOnly: true, orderId: cid }));
    expect(r.grossPnlUsd).toBeCloseTo(50, 9); // a short gains as ETH falls
  });

  it('funding: each payment while the lot was open, by the lot’s share of the position', async () => {
    getFundingHistory.mockResolvedValue([
      { symbol: 'BTC', positionSize: 0.0002, payoutUsd: 0.03, atMs: NOW - 1_000 },
      { symbol: 'BTC', positionSize: 0.0008, payoutUsd: 0.08, atMs: NOW - 2_000 },
      { symbol: 'BTC', positionSize: 0.0002, payoutUsd: 9, atMs: NOW - 7_200_000 }, // before the lot opened
      { symbol: 'ETH', positionSize: 1, payoutUsd: 9, atMs: NOW - 1_000 },
    ]);
    expect(await lotFundingUsd('acct', lot('x').position, NOW)).toBeCloseTo(0.03 + 0.02, 9);
  });
});

describe('the venue and the rows hold the same position', () => {
  it('exposure no row owns is flattened, and a lot whose close already filled comes back to be settled', async () => {
    const kept = lot('core_BTC_1_0');
    const gone = lot('core_BTC_1_1');
    const cid = closeOrderIdOf(gone.orderId);
    getPositions.mockResolvedValue([{ symbol: 'BTC', side: 'LONG', size: 0.0005, entryPrice: 64_000 }]);
    const d = deps([[order(cid)]], [fill(cid, { side: 'close_long', price: 65_000 })]);
    const r = await reconcileVenueBook(-11, [kept, gone], NOW, d);
    expect(r.closed.map((c) => c.lot.orderId)).toEqual([gone.orderId]);
    // The venue holds 0.0005; the one lot still open owns 0.0002: 0.0003 is unowned.
    expect(submitMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC', side: 'SHORT', size: 0.0003, reduceOnly: true }));
    expect(r.flattened).toEqual(['BTC LONG 0.0003']);
  });

  it('a venue holding exactly the rows is left alone', async () => {
    getPositions.mockResolvedValue([{ symbol: 'BTC', side: 'LONG', size: 0.0002, entryPrice: 64_000 }]);
    const r = await reconcileVenueBook(-11, [lot('core_BTC_1_0')], NOW, deps([[]], []));
    expect(submitMarketOrder).not.toHaveBeenCalled();
    expect(r).toEqual({ closed: [], flattened: [] });
  });
});

describe('a resting entry on the venue', () => {
  it('waits while it rests, is cancelled when it lapses, and becomes the position it filled', async () => {
    expect(await venueEntryState(-13, 'BTC', 'LONG', 'p1', false, NOW, deps([[order('p1', { status: 'open', filledSize: 0 })]], []))).toEqual({ state: 'resting' });
    expect(await venueEntryState(-13, 'BTC', 'LONG', 'p1', true, NOW, deps([[order('p1', { status: 'open', filledSize: 0 })], [order('p1', { status: 'cancelled', filledSize: 0 })]], []))).toEqual({ state: 'gone' });
    expect(cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC', orderId: 'p1' }));
    const filled = await venueEntryState(-13, 'BTC', 'LONG', 'p1', false, NOW, deps([[order('p1')]], [fill('p1', { feeUsd: 0.002 })]));
    expect(filled).toMatchObject({ state: 'filled', position: { entryPrice: 65_000, size: 0.0002, openFeeUsd: 0.002, side: 'LONG' } });
  });
});
