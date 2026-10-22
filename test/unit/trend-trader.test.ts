/**
 * The slow trend book (portfolio -10): the replayed rule exactly (yesterday's
 * close against the average of its last 100 closes), decided once a day,
 * never on missing candles, held as spot, and kept apart from the other books.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => (state.has(k) ? state.get(k) : null)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
// open rows live here, as the table would hold them
const rows: Array<{ order_id: string; asset: string; entry: number; notional: number; held_ms: number; portfolio: number }> = [];
const query = jest.fn(async (sql: string, params: unknown[]) => {
  if (sql.includes("status = 'active'")) return rows.filter((r) => r.portfolio === params[0]);
  return [{ realized: 0 }];
});
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, p: unknown[]) => query(sql, p) }));
const createHedge = jest.fn(async (a: { orderId: string; asset: string; entryPrice: number; notionalValue: number; portfolioId: number }) => {
  rows.push({ order_id: a.orderId, asset: a.asset, entry: a.entryPrice, notional: a.notionalValue, held_ms: 0, portfolio: a.portfolioId });
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

import { decisionDay, runTrendTick, spotClose, spotOpen, targetLots, trendOn, TREND_PORTFOLIO_ID } from '@/lib/services/paper-trader/TrendTrader';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T00:10:00Z'); // past 00:05 UTC: yesterday's candle has closed
const rising = Array.from({ length: 101 }, (_, i) => 100 + i); // last close above its 100-day average
const falling = Array.from({ length: 101 }, (_, i) => 300 - i);

beforeEach(() => { jest.clearAllMocks(); state.clear(); rows.length = 0; });

describe('the rule', () => {
  it('ON when the last close is above the average of the last 100 closes, the last one included', () => {
    expect(trendOn(rising)!.on).toBe(true);
    expect(trendOn(falling)!.on).toBe(false);
    expect(trendOn(rising)!.average).toBeCloseTo((101 + 200) / 2, 9); // closes 101..200
  });

  it('no decision on fewer than 100 closes or a bad close', () => {
    expect(trendOn(rising.slice(0, 99))).toBeNull();
    expect(trendOn([...rising.slice(0, 100), 0])).toBeNull();
  });

  it('an ON coin holds its half of 25% of the book, rounded down to whole $1,000 lots', () => {
    expect(targetLots(true, 100_000)).toBe(12); // $12,500 due, $12,000 held
    expect(targetLots(false, 100_000)).toBe(0);
  });

  it('decides only after 00:05 UTC, on yesterday\'s close', () => {
    expect(decisionDay(Date.parse('2026-10-23T00:03:00Z'))).toBeNull();
    expect(decisionDay(NOW)).toBe('2026-10-22');
  });

  it('spot: 10 bp in and 10 bp out, no funding', () => {
    const pos = spotOpen('BTC', 1000, 80_000, NOW - 30 * DAY);
    const r = spotClose(pos, 88_000, NOW);
    expect(r.realizedPnlUsd).toBeCloseTo(100 - 1 - 1, 9);
    expect(r.fundingUsd).toBe(0);
  });
});

describe('a day of the book', () => {
  it('buys both coins on an ON day, under its own id and order ids, and does not decide twice', async () => {
    const s = await runTrendTick(NOW, async () => rising);
    expect(s.bought).toBe(24);
    expect(createHedge.mock.calls.every(([a]) => a.portfolioId === TREND_PORTFOLIO_ID && /^trend_/.test(a.orderId))).toBe(true);
    const again = await runTrendTick(NOW + 60_000, async () => { throw new Error('should not be read'); });
    expect(again.decided).toBeUndefined();
    expect(again.bought + again.sold).toBe(0);
  });

  it('sells everything the day a coin turns OFF, settled before it is counted', async () => {
    await runTrendTick(NOW, async () => rising);
    const s = await runTrendTick(NOW + DAY, async (a: string) => (a === 'BTC' ? falling : rising));
    expect(s.sold).toBe(12);
    expect(settleHedgeRow).toHaveBeenCalledTimes(12);
    expect(rows.filter((r) => r.asset === 'BTC')).toHaveLength(0);
    expect(rows.filter((r) => r.asset === 'ETH')).toHaveLength(12);
  });

  it('candles it cannot read mean no decision: the lots stay, and the next tick tries again', async () => {
    await runTrendTick(NOW, async () => rising);
    const fail = async (a: string) => { if (a === 'ETH') throw new Error('HTTP 502'); return falling; };
    const s = await runTrendTick(NOW + DAY, fail);
    expect(s.decided).toBeUndefined();
    expect(s.sold).toBe(0); // BTC was readable, but there is no half decision
    const later = await runTrendTick(NOW + DAY + 60_000, async () => falling);
    expect(later.sold).toBe(24);
  });

  it('a buy that fails is retried on the next tick, not the next day', async () => {
    createHedge.mockImplementationOnce(async () => { throw new Error('db busy'); });
    const s = await runTrendTick(NOW, async () => rising);
    expect(s.bought).toBe(23);
    const next = await runTrendTick(NOW + 60_000, async () => rising);
    expect(next.bought).toBe(1);
  });
});
