/**
 * The floor book's twin: the same rule with a multiplier that follows the
 * move the market prices. These tests hold it to the replayed formula, to its
 * no-look-ahead start, to its fall-back on an unread market, and to complete
 * isolation from the plain book (its own id, state key and order ids).
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => (state.has(k) ? state.get(k) : null)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown[]>>();
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, params: unknown[]) => query(sql, params) }));
const createHedge = jest.fn(async (_: Record<string, unknown>) => {});
jest.mock('@/lib/db/hedges', () => ({ createHedge: (a: Record<string, unknown>) => createHedge(a) }));
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({ settleHedgeRow: jest.fn(async () => true) }));
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getMultiSourceValidatedPrice: async (asset: string) => ({ price: asset === 'BTC' ? 80_000 : 2_500 }),
}));
const moves: Record<string, number> = { BTC: 2, ETH: 3 };
jest.mock('@/lib/services/market-data/StrikeLadderService', () => ({
  getExpectedMove: async (asset: string) => ({ movePct: moves[asset] }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { ladderMultiplier, ladderSizing, FloorLadderTrader, FLOOR_LADDER_PORTFOLIO_ID } from '@/lib/services/paper-trader/FloorLadderTrader';
import { FLOOR_PORTFOLIO_ID } from '@/lib/services/paper-trader/FloorTrader';

const NOW = Date.parse('2026-10-19T20:00:00Z');
const MIN = 60_000;

beforeEach(() => {
  jest.clearAllMocks();
  state.clear();
  moves.BTC = 2; moves.ETH = 3;
  query.mockImplementation(async (sql: string) => (sql.includes("status = 'active'") ? [] : [{ realized: 0 }]));
});

describe('ladderMultiplier', () => {
  it('stays at 3 until 20 readings exist: nothing is judged against a normal it has not seen', () => {
    expect(ladderMultiplier(Array(18).fill(2.5).concat([5]))).toBe(3); // 19 readings
    expect(ladderMultiplier(Array(19).fill(2.5).concat([5]))).toBeCloseTo(1.5, 6); // the 20th starts it
  });

  it('holds less when the market prices a bigger move than normal, more when calmer, within 1.5 to 4.5', () => {
    const normal = Array(30).fill(2.5);
    expect(ladderMultiplier([...normal, 5])).toBeCloseTo(1.5, 6); // twice the normal move: half the multiplier, at the floor of the range
    expect(ladderMultiplier([...normal, 3.125])).toBeCloseTo(2.4, 6); // 25 % above normal
    expect(ladderMultiplier([...normal, 1])).toBeCloseTo(4.5, 6); // very calm: capped
    expect(ladderMultiplier([...normal, 2.5])).toBeCloseTo(3, 6);
  });
});

describe('ladderSizing', () => {
  it('reads the market at most every 30 minutes and remembers the reading', async () => {
    const read = jest.fn(async () => 2.5);
    const a = await ladderSizing(undefined, NOW, read);
    const b = await ladderSizing(a.sizing, NOW + 10 * MIN, read);
    const c = await ladderSizing(b.sizing, NOW + 31 * MIN, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect((c.sizing.history as number[]).length).toBe(2);
  });

  it('a failed read keeps the last multiplier for up to 6 hours, then falls back to 3', async () => {
    const history = Array(30).fill(2.5).concat([5]);
    const stored = { history, lastTryAtMs: NOW - 31 * MIN, lastOkAtMs: NOW - 31 * MIN, multiplier: 1.5 };
    const fail = async () => null;
    expect((await ladderSizing(stored, NOW, fail)).multiplier).toBe(1.5);
    const old = { ...stored, lastTryAtMs: NOW - 7 * 60 * MIN, lastOkAtMs: NOW - 7 * 60 * MIN };
    expect((await ladderSizing(old, NOW, fail)).multiplier).toBe(3);
  });
});

describe('FloorLadderTrader', () => {
  it('trades under its own id, state key and order ids, never the plain book\'s', async () => {
    const s = await FloorLadderTrader.runTick(NOW);
    expect(s.bought).toBeGreaterThan(0);
    for (const [row] of createHedge.mock.calls) {
      expect(row.portfolioId).toBe(FLOOR_LADDER_PORTFOLIO_ID);
      expect(String(row.orderId)).toMatch(/^floorladder_/);
    }
    expect(FLOOR_LADDER_PORTFOLIO_ID).not.toBe(FLOOR_PORTFOLIO_ID);
    expect(state.has('floor-ladder-trader:state')).toBe(true);
    expect(state.has('floor-trader:state')).toBe(false);
    expect(query.mock.calls.every(([, params]) => (params as unknown[])[0] === FLOOR_LADDER_PORTFOLIO_ID)).toBe(true);
  });

  it('records the multiplier it used and the market reading behind it', async () => {
    await FloorLadderTrader.runTick(NOW);
    const st = state.get('floor-ladder-trader:state') as { multiplier: number; sizing: { history: number[] } };
    expect(st.multiplier).toBe(3); // one reading so far
    expect(st.sizing.history).toEqual([2.5]); // average of BTC 2 % and ETH 3 %
  });
});
