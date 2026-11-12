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
/** Hours from the reading to the ladder's resolution. */
const lead = { hours: 24 };
jest.mock('@/lib/services/market-data/StrikeLadderService', () => ({
  getExpectedMove: async (asset: string, now: number) => ({
    movePct: moves[asset],
    resolvesAt: new Date(now + lead.hours * 3_600_000).toISOString(),
  }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { ladderMultiplier, ladderSizing, movePerDay, FloorLadderTrader, FLOOR_LADDER_PORTFOLIO_ID } from '@/lib/services/paper-trader/FloorLadderTrader';
import { FLOOR_PORTFOLIO_ID } from '@/lib/services/paper-trader/FloorTrader';

const NOW = Date.parse('2026-10-19T20:00:00Z');
const MIN = 60_000;

beforeEach(() => {
  jest.clearAllMocks();
  state.clear();
  moves.BTC = 2; moves.ETH = 3;
  lead.hours = 24;
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

describe('movePerDay', () => {
  it('reads the same market the same at any distance from resolution', () => {
    // A coin priced to move 2 % a day: its ladder shows 2 × √1.5 % 36 hours out and 2 × √0.5 % 12 hours out.
    expect(movePerDay(2 * Math.sqrt(1.5), NOW + 36 * 60 * MIN, NOW)).toBeCloseTo(2, 9);
    expect(movePerDay(2 * Math.sqrt(0.5), NOW + 12 * 60 * MIN, NOW)).toBeCloseTo(2, 9);
    expect(movePerDay(2, NOW + 24 * 60 * MIN, NOW)).toBeCloseTo(2, 9);
  });

  it('cannot scale a ladder that has resolved, has no time or has no width', () => {
    expect(movePerDay(2, NOW, NOW)).toBeNull();
    expect(movePerDay(2, NOW - MIN, NOW)).toBeNull();
    expect(movePerDay(2, Number.NaN, NOW)).toBeNull();
    expect(movePerDay(0, NOW + 24 * 60 * MIN, NOW)).toBeNull();
  });
});

describe('ladderSizing', () => {
  it('the clock alone does not move the multiplier: one market read through a day sizes the same', async () => {
    let sizing: Record<string, unknown> | undefined;
    const multipliers: number[] = [];
    // 40 readings, 30 minutes apart, of a market priced at 2 % (BTC) and 3 % (ETH) a day, the ladder 36 down to 12 hours out.
    for (let i = 0; i < 40; i++) {
      lead.hours = 36 - (i % 49) * 0.5;
      moves.BTC = 2 * Math.sqrt(lead.hours / 24);
      moves.ETH = 3 * Math.sqrt(lead.hours / 24);
      const r = await ladderSizing(sizing, NOW + i * 30 * MIN);
      sizing = r.sizing;
      multipliers.push(r.multiplier);
    }
    for (const m of multipliers) expect(m).toBeCloseTo(3, 9);
  });

  it('leaves behind readings stored before they were scaled to one day', async () => {
    const stored = { history: Array(30).fill(1).concat([5]), lastTryAtMs: NOW - 31 * MIN, lastOkAtMs: NOW - 31 * MIN, multiplier: 1.5 };
    const r = await ladderSizing(stored, NOW, async () => 2.5);
    expect(r.sizing.dayMoves).toEqual([2.5]);
    expect(r.sizing).not.toHaveProperty('history');
    expect(r.multiplier).toBe(3); // one reading: back to the base until 20 exist
  });

  it('reads the market at most every 30 minutes and remembers the reading', async () => {
    const read = jest.fn(async () => 2.5);
    const a = await ladderSizing(undefined, NOW, read);
    const b = await ladderSizing(a.sizing, NOW + 10 * MIN, read);
    const c = await ladderSizing(b.sizing, NOW + 31 * MIN, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect((c.sizing.dayMoves as number[]).length).toBe(2);
  });

  it('a failed read keeps the last multiplier for up to 6 hours, then falls back to 3', async () => {
    const history = Array(30).fill(2.5).concat([5]);
    const stored = { dayMoves: history, lastTryAtMs: NOW - 31 * MIN, lastOkAtMs: NOW - 31 * MIN, multiplier: 1.5 };
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
    const st = state.get('floor-ladder-trader:state') as { multiplier: number; sizing: { dayMoves: number[] } };
    expect(st.multiplier).toBe(3); // one reading so far
    expect(st.sizing.dayMoves).toEqual([2.5]); // average of BTC 2 % and ETH 3 %
  });
});
