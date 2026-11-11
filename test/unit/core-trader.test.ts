/**
 * The core book (portfolio -11): the floor rule's exposure, a coin held only
 * on its trend, spot lots, and interest on the cash kept apart from the
 * trading result. The plain floor books keep every coin when no filter is given.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => (state.has(k) ? state.get(k) : null)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
const rows: Array<{ order_id: string; asset: string; entry: number; notional: number; held_ms: number; portfolio: number; market: string }> = [];
const query = jest.fn(async (sql: string, params: unknown[]) => {
  if (sql.includes("status = 'active'")) return rows.filter((r) => r.portfolio === params[0]);
  return [{ realized: 0 }];
});
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, p: unknown[]) => query(sql, p) }));
const createHedge = jest.fn(async (a: { orderId: string; asset: string; entryPrice: number; notionalValue: number; portfolioId: number; market: string }) => {
  rows.push({ order_id: a.orderId, asset: a.asset, entry: a.entryPrice, notional: a.notionalValue, held_ms: 0, portfolio: a.portfolioId, market: a.market });
});
jest.mock('@/lib/db/hedges', () => ({ createHedge: (a: never) => createHedge(a) }));
const settleHedgeRow = jest.fn(async (a: { orderId: string }) => {
  const i = rows.findIndex((r) => r.order_id === a.orderId);
  if (i >= 0) rows.splice(i, 1);
  return true;
});
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({ settleHedgeRow: (a: never) => settleHedgeRow(a) }));
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getMultiSourceValidatedPrice: async (asset: string) => ({ price: asset === 'BTC' ? 80_000 : 2_500 }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { CORE_PORTFOLIO_ID, interestFor, runCoreTick, type CoreState } from '@/lib/services/paper-trader/CoreTrader';
import { planFloorRebalance } from '@/lib/services/paper-trader/floor-rule';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-12T00:10:00Z');
const rising = Array.from({ length: 101 }, (_, i) => 100 + i);
const falling = Array.from({ length: 101 }, (_, i) => 300 - i);
const core = () => state.get('core-trader:state') as CoreState;

beforeEach(() => { jest.clearAllMocks(); state.clear(); rows.length = 0; });

describe('the rule', () => {
  it('interest: 4% a year on the cash, nothing on no cash or no time', () => {
    expect(interestFor(100_000, 365 * DAY)).toBeCloseTo(4_000, 6);
    expect(interestFor(0, DAY)).toBe(0);
    expect(interestFor(-5, DAY)).toBe(0);
    expect(interestFor(100_000, 0)).toBe(0);
  });

  it('a coin off its trend is sold to nothing, and the other keeps only its own half', () => {
    const plan = planFloorRebalance({ valueUsd: 100_000, peakUsd: 100_000, heldUsd: { BTC: 3_000, ETH: 3_000 }, assets: ['BTC', 'ETH'], holding: { BTC: true, ETH: false } });
    expect(plan.lots).toEqual({ BTC: 5, ETH: -3 }); // BTC toward its $15,000 half, five lots a tick
  });

  it('without a filter every coin is held, as the plain floor books have it', () => {
    const plan = planFloorRebalance({ valueUsd: 100_000, peakUsd: 100_000, heldUsd: { BTC: 14_000, ETH: 14_000 }, assets: ['BTC', 'ETH'] });
    expect(plan.lots).toEqual({ BTC: 1, ETH: 1 });
  });
});

describe('the book', () => {
  it('buys spot lots of both coins on their trend, under its own id, five a coin a tick', async () => {
    const s = await runCoreTick(NOW, async () => rising);
    expect(s.bought).toBe(10);
    expect(rows.every((r) => r.portfolio === CORE_PORTFOLIO_ID && /^core_/.test(r.order_id) && /-SPOT$/.test(r.market))).toBe(true);
    expect(core().trend.BTC.on).toBe(true);
  });

  it('holds nothing while both coins are below their average', async () => {
    const s = await runCoreTick(NOW, async () => falling);
    expect(s.bought).toBe(0);
    expect(s.decided).toMatch(/BTC off/);
  });

  it('candles it cannot read mean no decision, and before a first decision nothing is held', async () => {
    const s = await runCoreTick(NOW, async () => { throw new Error('HTTP 502'); });
    expect(s.decided).toBeUndefined();
    expect(s.bought).toBe(0);
  });

  it('credits interest on the cash between ticks, apart from the trading result', async () => {
    await runCoreTick(NOW, async () => falling); // all cash
    const s = await runCoreTick(NOW + DAY, async () => falling);
    const day = 100_000 * 0.04 / 365;
    expect(s.interestUsd).toBeCloseTo(day, 6);
    expect(core().interestUsd).toBeCloseTo(day, 6);
    expect(core().valueUsd).toBeCloseTo(100_000 + day, 6);
  });

  it('sells a coin the day it turns off, settled before it is counted', async () => {
    await runCoreTick(NOW, async () => rising);
    const s = await runCoreTick(NOW + DAY, async (a: string) => (a === 'BTC' ? falling : rising));
    expect(s.sold).toBe(5);
    expect(settleHedgeRow).toHaveBeenCalledTimes(5);
    expect(rows.filter((r) => r.asset === 'BTC')).toHaveLength(0);
  });
});
