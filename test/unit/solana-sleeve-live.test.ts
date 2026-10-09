/**
 * Live execution for the sleeve, against a fake venue: a fill is the
 * position appearing, a result is the change in equity, and the guards stop
 * new entries on their own.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async (k: string) => state.get(k) ?? null),
  setCronState: jest.fn(async (k: string, v: unknown) => void state.set(k, v)),
}));

type Pos = { symbol: string; side: 'LONG' | 'SHORT'; size: number; entryPrice: number };
const venue = {
  configured: true,
  positions: [] as Pos[],
  /** What the position list becomes once an order has been sent. */
  afterOrder: null as Pos[] | null,
  equity: 500,
  available: 500,
  mark: 82_000,
  orders: [] as Array<{ symbol: string; side: string; size: number; reduceOnly: boolean; orderId: string }>,
};
jest.mock('@/lib/services/solana/perp-venue', () => ({
  perpNetwork: () => 'testnet',
  perpVenueConfigured: () => venue.configured,
  getMarket: jest.fn(async (symbol: string) => ({ symbol, lotSize: 0.00001, minOrderUsd: 10, maxLeverage: 50 })),
  getMarkPrice: jest.fn(async () => venue.mark),
  getAccount: jest.fn(async () => ({ balanceUsd: venue.equity, equityUsd: venue.equity, availableToSpendUsd: venue.available })),
  getPositions: jest.fn(async () => venue.positions),
  sizeForNotional: (usd: number, price: number, lot: number) => Number((Math.floor(usd / price / lot + 1e-9) * lot).toFixed(5)),
  submitMarketOrder: jest.fn(async (o: { symbol: string; side: string; size: number; reduceOnly: boolean; orderId: string }) => {
    venue.orders.push(o);
    if (venue.afterOrder) venue.positions = venue.afterOrder;
    return { orderId: 1 };
  }),
}));

import {
  sleeveLiveEnabled,
  openLive,
  closeLive,
  flattenUntracked,
  liveEntryBlock,
  recordLiveOutcome,
} from '@/lib/services/solana/sleeve-live';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  state.clear();
  Object.assign(venue, { configured: true, positions: [], afterOrder: null, equity: 500, available: 500, mark: 82_000, orders: [] });
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  delete process.env.SOLANA_SLEEVE_LIVE_ENABLED;
  delete process.env.SOLANA_SLEEVE_LIVE_MAX_NOTIONAL_USD;
});
afterEach(() => jest.useRealTimers());

/** Run something that sleeps between venue reads, without waiting for real time. */
async function settle<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const guarded = work.finally(() => { done = true; });
  while (!done) await jest.advanceTimersByTimeAsync(800);
  return guarded;
}

describe('the switch', () => {
  it('is off by default, and off when the venue is not configured', () => {
    expect(sleeveLiveEnabled()).toBe(false);
    process.env.SOLANA_SLEEVE_LIVE_ENABLED = '1';
    expect(sleeveLiveEnabled()).toBe(true);
    venue.configured = false;
    expect(sleeveLiveEnabled()).toBe(false);
  });
});

describe('openLive', () => {
  it('a fill is the position appearing: size and entry come from the venue', async () => {
    venue.afterOrder = [{ symbol: 'BTC', side: 'LONG', size: 0.00121, entryPrice: 82_010 }];
    const r = await settle(openLive({ asset: 'BTC', side: 'LONG', notionalUsd: 300, orderId: 'o1' }));
    expect(r).toEqual({ ok: true, size: 0.00121, entryPrice: 82_010, equityBeforeUsd: 500 });
    // $300 asked, $100 cap: 100 / 82,000 = 0.00121 after rounding down to the lot.
    expect(venue.orders).toEqual([{ symbol: 'BTC', side: 'LONG', size: 0.00121, reduceOnly: false, orderId: 'o1' }]);
  });

  it('an accepted order with no position is not a fill, and says an order is out', async () => {
    const r = await settle(openLive({ asset: 'BTC', side: 'LONG', notionalUsd: 100, orderId: 'o1' }));
    expect(r).toMatchObject({ ok: false, sent: true });
    expect(venue.orders).toHaveLength(1);
  });

  it('sends nothing when the venue already holds the market, the order is too small, or collateral is short', async () => {
    venue.positions = [{ symbol: 'BTC', side: 'SHORT', size: 0.001, entryPrice: 80_000 }];
    expect(await openLive({ asset: 'BTC', side: 'LONG', notionalUsd: 100, orderId: 'o1' })).toMatchObject({ ok: false, sent: false });
    venue.positions = [];
    expect(await openLive({ asset: 'BTC', side: 'LONG', notionalUsd: 5, orderId: 'o2' })).toMatchObject({ ok: false, sent: false, reason: expect.stringContaining('minimum order') });
    venue.available = 40;
    expect(await openLive({ asset: 'BTC', side: 'LONG', notionalUsd: 100, orderId: 'o3' })).toMatchObject({ ok: false, sent: false, reason: expect.stringContaining('does not cover') });
    expect(venue.orders).toEqual([]);
  });
});

describe('closeLive', () => {
  it('sends the opposite side reduce-only for the whole position; the result is the change in equity', async () => {
    venue.positions = [{ symbol: 'ETH', side: 'SHORT', size: 0.04, entryPrice: 2500 }];
    venue.afterOrder = [];
    venue.equity = 497.3; // fees and a small loss, as the venue charged them
    venue.mark = 2510;
    const r = await settle(closeLive({ asset: 'ETH', side: 'SHORT', orderId: 'o1', equityBeforeUsd: 500, now: NOW }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.realizedUsd).toBeCloseTo(-2.7, 6);
      expect(r.exitPrice).toBe(2510);
    }
    expect(venue.orders[0]).toMatchObject({ symbol: 'ETH', side: 'LONG', size: 0.04, reduceOnly: true });
  });

  it('a close that leaves the position on the venue is not a close', async () => {
    venue.positions = [{ symbol: 'ETH', side: 'SHORT', size: 0.04, entryPrice: 2500 }];
    const r = await settle(closeLive({ asset: 'ETH', side: 'SHORT', orderId: 'o1', equityBeforeUsd: 500, now: NOW }));
    expect(r).toMatchObject({ ok: false });
  });

  it('a position already gone from the venue is settled without sending anything', async () => {
    venue.equity = 512;
    const r = await closeLive({ asset: 'ETH', side: 'SHORT', orderId: 'o1', equityBeforeUsd: 500, now: NOW });
    expect(r).toMatchObject({ ok: true, realizedUsd: 12 });
    expect(venue.orders).toEqual([]);
  });
});

describe('flattenUntracked', () => {
  it('closes positions on the sleeve markets that it has no record of, and leaves other markets alone', async () => {
    venue.positions = [
      { symbol: 'SOL', side: 'LONG', size: 0.9, entryPrice: 110 },
      { symbol: 'DOGE', side: 'LONG', size: 100, entryPrice: 0.1 },
    ];
    expect(await flattenUntracked(['BTC', 'ETH', 'SOL'], NOW)).toEqual(['SOL LONG 0.9']);
    expect(venue.orders).toEqual([expect.objectContaining({ symbol: 'SOL', side: 'SHORT', size: 0.9, reduceOnly: true })]);
  });
});

describe('guards', () => {
  it('three losses in a row halt new entries for a day, then release', async () => {
    expect(await liveEntryBlock(NOW)).toBeNull();
    expect(await recordLiveOutcome(-1, NOW)).toEqual({ halted: false });
    expect(await recordLiveOutcome(-1, NOW)).toEqual({ halted: false });
    expect(await recordLiveOutcome(-1, NOW)).toEqual({ halted: true });
    expect(await liveEntryBlock(NOW + 60_000)).toContain('live halt');
    expect(await liveEntryBlock(NOW + 25 * 3_600_000)).toBeNull();
  });

  it('a win resets the streak', async () => {
    await recordLiveOutcome(-1, NOW);
    await recordLiveOutcome(-1, NOW);
    await recordLiveOutcome(2, NOW);
    expect(await recordLiveOutcome(-1, NOW)).toEqual({ halted: false });
  });

  it('the daily loss cap blocks until the next UTC day', async () => {
    await recordLiveOutcome(-25, NOW);
    expect(await liveEntryBlock(NOW + 60_000)).toContain('daily loss cap');
    expect(await liveEntryBlock(NOW + 13 * 3_600_000)).toBeNull();
  });
});
