/**
 * The floor book exists to show, on live prices, what a rule with no forecast
 * does to a deposit. These tests hold it to what makes that showing honest:
 * exposure follows the cushion and each coin always keeps one lot, the book's value is
 * read from its rows, a missing figure is never taken for zero, and a close
 * someone else settled counts for nothing.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
const getCronStateStrict = jest.fn(async (k: string) => (state.has(k) ? state.get(k) : null));
const setCronState = jest.fn(async (k: string, v: unknown) => { state.set(k, v); });
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: (k: string) => getCronStateStrict(k),
  setCronState: (k: string, v: unknown) => setCronState(k, v),
}));
const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown[]>>();
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, params: unknown[]) => query(sql, params) }));
const createHedge = jest.fn(async (_: Record<string, unknown>) => {});
jest.mock('@/lib/db/hedges', () => ({ createHedge: (a: Record<string, unknown>) => createHedge(a) }));
const settleHedgeRow = jest.fn<(a: Record<string, unknown>) => Promise<boolean>>();
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({ settleHedgeRow: (a: Record<string, unknown>) => settleHedgeRow(a) }));
const prices: Record<string, number | null> = {};
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getMultiSourceValidatedPrice: async (asset: string) => ({ price: prices[asset] ?? 0 }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { FloorTrader, FLOOR_PORTFOLIO_ID, FLOOR_START_USD } from '@/lib/services/paper-trader/FloorTrader';
import { FLOOR_RULE, floorTargetUsd, planFloorRebalance } from '@/lib/services/paper-trader/floor-rule';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const STATE = 'floor-trader:state';
const YEAR_MS = 365 * 24 * 3600 * 1000;
// What one $1,000 lot has paid on the way in: 6.5 bp taker fee and 1 bp slippage.
const OPEN_COST = 0.75;

interface Row { order_id: string; asset: string; entry: number; notional: number; held_ms: number }
let openRows: Row[] = [];
let realized = 0;
const lots = (asset: string, n: number, entry: number, heldMs = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ order_id: `floor_${asset}_${i}`, asset, entry, notional: 1_000, held_ms: heldMs }));
const started = (over: Record<string, unknown> = {}) =>
  state.set(STATE, { startedAtMs: NOW - 3_600_000, peakUsd: FLOOR_START_USD, lowUsd: FLOOR_START_USD, maxDrawdown: 0, startPrices: { BTC: 80_000, ETH: 2_500 }, valueUsd: FLOOR_START_USD, exposureUsd: 0, updatedAtMs: NOW - 60_000, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  state.clear();
  openRows = [];
  realized = 0;
  prices.BTC = 80_000;
  prices.ETH = 2_500;
  query.mockImplementation(async (sql: string) => (sql.includes("status = 'active'") ? openRows : [{ realized }]));
  settleHedgeRow.mockResolvedValue(true);
});

describe('floorTargetUsd', () => {
  it('a new book holds three times its cushion', () => {
    expect(floorTargetUsd(100_000, 100_000)).toBeCloseTo(30_000);
  });

  it('grows with the book, and never past the whole book', () => {
    expect(floorTargetUsd(120_000, 120_000)).toBeCloseTo(36_000);
    expect(floorTargetUsd(100_000, 70_000)).toBe(100_000);
  });

  it('is sold down as the book nears its floor', () => {
    expect(floorTargetUsd(92_000, 100_000)).toBeCloseTo(6_000);
  });

  it('at or under the floor the cushion is spent and the rule wants nothing', () => {
    expect(floorTargetUsd(90_000, 100_000)).toBe(0);
    expect(floorTargetUsd(85_000, 100_000)).toBe(0);
  });

  it('a book worth nothing, or with no readable value, wants nothing', () => {
    for (const bad of [0, -5, NaN]) expect(floorTargetUsd(bad, 100_000)).toBe(0);
  });
});

describe('planFloorRebalance', () => {
  const assets = ['BTC', 'ETH'];

  it('splits the target equally and works a large move over several ticks', () => {
    const plan = planFloorRebalance({ valueUsd: 100_000, peakUsd: 100_000, heldUsd: {}, assets });
    expect(plan.targetUsd).toBeCloseTo(30_000);
    expect(plan.lots).toEqual({ BTC: FLOOR_RULE.maxLotsPerTick, ETH: FLOOR_RULE.maxLotsPerTick });
  });

  it('trades nothing inside one lot, in either direction', () => {
    const plan = planFloorRebalance({ valueUsd: 100_000, peakUsd: 100_000, heldUsd: { BTC: 14_100, ETH: 15_900 }, assets });
    expect(plan.lots).toEqual({ BTC: 0, ETH: 0 });
  });

  it('sells when the book has fallen toward its floor', () => {
    const plan = planFloorRebalance({ valueUsd: 96_000, peakUsd: 100_000, heldUsd: { BTC: 12_500, ETH: 12_500 }, assets });
    expect(plan.targetUsd).toBeCloseTo(18_000);
    expect(plan.lots).toEqual({ BTC: -3, ETH: -3 });
  });

  it('at its floor each coin keeps one lot: a book that holds nothing could never earn its cushion back', () => {
    expect(planFloorRebalance({ valueUsd: 90_000, peakUsd: 100_000, heldUsd: {}, assets }).lots).toEqual({ BTC: 1, ETH: 1 });
    expect(planFloorRebalance({ valueUsd: 88_000, peakUsd: 100_000, heldUsd: { BTC: 900, ETH: 1_050 }, assets }).lots).toEqual({ BTC: 0, ETH: 0 });
    // Above the floor but with more than its share, a coin is sold down to the lot it keeps.
    expect(planFloorRebalance({ valueUsd: 90_100, peakUsd: 100_000, heldUsd: { BTC: 4_200, ETH: 1_000 }, assets }).lots).toEqual({ BTC: -3, ETH: 0 });
  });

  it('a new high raises the floor with it', () => {
    const plan = planFloorRebalance({ valueUsd: 110_000, peakUsd: 100_000, heldUsd: {}, assets });
    expect(plan.peakUsd).toBe(110_000);
    expect(plan.floorUsd).toBeCloseTo(99_000);
  });
});

describe('FloorTrader.runTick', () => {
  it('a new book buys toward its target a few lots at a time, one simulated row per lot', async () => {
    const s = await FloorTrader.runTick(NOW);
    expect(s).toMatchObject({ bought: 10, sold: 0, lots: 10, valueUsd: FLOOR_START_USD, floorUsd: 90_000 });
    expect(createHedge).toHaveBeenCalledTimes(10);
    expect(createHedge.mock.calls[0][0]).toMatchObject({
      portfolioId: FLOOR_PORTFOLIO_ID, asset: 'BTC', side: 'LONG', leverage: 1, notionalValue: 1_000, entryPrice: 80_000, simulationMode: true,
    });
    expect(new Set(createHedge.mock.calls.map((c) => c[0].orderId)).size).toBe(10);
    expect(state.get(STATE)).toMatchObject({ startedAtMs: NOW, peakUsd: FLOOR_START_USD, startPrices: { BTC: 80_000, ETH: 2_500 } });
  });

  it('reads its value from its rows: start, plus realized, plus open lots at the mark and at their age', async () => {
    started();
    realized = 500;
    prices.BTC = 84_000; // +5% on the BTC lots
    openRows = [...lots('BTC', 15, 80_000), ...lots('ETH', 14, 2_500), ...lots('ETH', 1, 2_500, YEAR_MS)];
    const s = await FloorTrader.runTick(NOW);
    // 15 BTC lots up $50 each, 15 ETH lots flat, every lot down its entry cost, and the year-old lot down a year of funding.
    const funding = 1_000 * 0.11;
    expect(s.valueUsd).toBeCloseTo(FLOOR_START_USD + 500 + 15 * 50 - 30 * OPEN_COST - funding, 6);
    expect(s.exposureUsd).toBeCloseTo(15 * 1_050 + 15 * 1_000, 6);
    expect(query.mock.calls.find(([sql]) => sql.includes("status = 'closed'"))?.[1]).toEqual([FLOOR_PORTFOLIO_ID, NOW - 3_600_000]);
  });

  it('does nothing without a trustworthy price for every asset: an unpriced book must not look like an empty one', async () => {
    started();
    prices.ETH = null;
    openRows = lots('BTC', 15, 80_000);
    const s = await FloorTrader.runTick(NOW);
    expect(s).toMatchObject({ bought: 0, sold: 0, skipped: 'no price for ETH' });
    expect(query).not.toHaveBeenCalled();
    expect(createHedge).not.toHaveBeenCalled();
    expect(settleHedgeRow).not.toHaveBeenCalled();
    expect(setCronState).not.toHaveBeenCalled();
  });

  it('a state store that does not answer stops the tick instead of starting the book again', async () => {
    getCronStateStrict.mockRejectedValueOnce(new Error('connection refused'));
    await expect(FloorTrader.runTick(NOW)).rejects.toThrow('connection refused');
    expect(createHedge).not.toHaveBeenCalled();
    expect(setCronState).not.toHaveBeenCalled();
  });

  it('rows that cannot be read stop the tick: realized P&L is never assumed to be zero', async () => {
    started();
    openRows = lots('BTC', 15, 80_000);
    query.mockImplementation(async (sql: string) => (sql.includes("status = 'active'") ? openRows : [{ realized: 'not-a-number' }]));
    await expect(FloorTrader.runTick(NOW)).rejects.toThrow();
    expect(createHedge).not.toHaveBeenCalled();
    expect(settleHedgeRow).not.toHaveBeenCalled();
  });

  it('a fall sells the oldest lots, settling each row before it is counted', async () => {
    started();
    prices.BTC = 72_000; // both coins down 10%
    prices.ETH = 2_250;
    openRows = [...lots('BTC', 15, 80_000), ...lots('ETH', 15, 2_500)];
    const s = await FloorTrader.runTick(NOW);
    // Book 96,977.50 over a floor of 90,000 wants 20,932 of exposure: 10,466 a coin against 13,500 held.
    expect(s).toMatchObject({ sold: 6, bought: 0, lots: 24 });
    expect(settleHedgeRow.mock.calls.map((c) => c[0].orderId)).toEqual(['floor_BTC_0', 'floor_BTC_1', 'floor_BTC_2', 'floor_ETH_0', 'floor_ETH_1', 'floor_ETH_2']);
    const first = settleHedgeRow.mock.calls[0][0] as { reason: string; result: { realizedPnlUsd: number; exitPrice: number } };
    expect(first.reason).toBe('floor-rebalance');
    expect(first.result.exitPrice).toBe(72_000);
    expect(first.result.realizedPnlUsd).toBeCloseTo(-100 - 2 * OPEN_COST, 6);
    expect(createHedge).not.toHaveBeenCalled();
    expect(state.get(STATE)).toMatchObject({ peakUsd: FLOOR_START_USD, lowUsd: s.valueUsd });
  });

  it('a lot another tick already closed is not sold again', async () => {
    started();
    prices.BTC = 72_000;
    prices.ETH = 2_250;
    openRows = [...lots('BTC', 15, 80_000), ...lots('ETH', 15, 2_500)];
    settleHedgeRow.mockResolvedValueOnce(false);
    const s = await FloorTrader.runTick(NOW);
    expect(s).toMatchObject({ sold: 5, lots: 24 });
  });

  it('under its floor the book still holds one lot a coin, so a recovery can reach it', async () => {
    started({ peakUsd: 120_000 });
    const s = await FloorTrader.runTick(NOW);
    // Worth 100,000 under a floor of 108,000: the cushion is spent, and the book is not left empty.
    expect(s).toMatchObject({ floorUsd: 108_000, bought: 2, sold: 0, lots: 2 });
    expect(createHedge.mock.calls.map((c) => c[0].asset)).toEqual(['BTC', 'ETH']);
  });
});
