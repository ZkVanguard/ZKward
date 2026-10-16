/**
 * Open paper positions carry their mark on the row, so an open -500 bp cannot
 * show as 0, and a position a strategy book holds past its stop or time limit
 * raises one warning after it has stayed there for more than two ticks.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => state.get(k) ?? null),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
const rows: unknown[] = [];
const query = jest.fn(async (sql: string) => (sql.trim().startsWith('SELECT') ? rows : []));
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, p: unknown[]) => query(sql, p) }));
const notifyDiscord = jest.fn(async () => {});
jest.mock('@/lib/services/paper-trader/notifications', () => ({ notifyPaper: (...a: unknown[]) => notifyDiscord(...(a as [])) }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { markOpenRow, markOpenPaperPositions } from '@/lib/services/paper-trader/open-marks';
import { PAPER_TARGET_MAX_HOLD_MIN } from '@/lib/services/paper-trader/config';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  order_id: 'paper_ETH_1', portfolio_id: -3, asset: 'ETH', side: 'LONG', entry_price: '4000',
  notional_value: '1000', stop_loss: '3920', created_at: new Date(NOW - 60 * 60_000), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  state.clear();
  rows.length = 0;
});

describe('markOpenRow', () => {
  it('marks a long and a short in bp and dollars of notional', () => {
    expect(markOpenRow(row(), 3800, NOW)).toMatchObject({ markBp: expect.closeTo(-500, 6), markUsd: expect.closeTo(-50, 6) });
    expect(markOpenRow(row({ side: 'SHORT', stop_loss: '4080' }), 3800, NOW).markBp).toBeGreaterThan(0);
  });

  it('a strategy book past its stop or its time limit is overdue; inside both it is not', () => {
    expect(markOpenRow(row(), 3800, NOW).overdue).toMatch(/past its stop/);
    expect(markOpenRow(row(), 3990, NOW).overdue).toBeNull();
    const old = new Date(NOW - (PAPER_TARGET_MAX_HOLD_MIN + 61) * 60_000);
    expect(markOpenRow(row({ created_at: old }), 3990, NOW).overdue).toMatch(/time limit/);
  });

  it('a book that closes at a horizon or by a rule is marked but never overdue', () => {
    expect(markOpenRow(row({ portfolio_id: -8, created_at: new Date(NOW - 30 * 86_400_000) }), 3000, NOW).overdue).toBeNull();
  });
});

describe('markOpenPaperPositions', () => {
  it('writes the mark to the row, and warns once after more than two ticks past the exit', async () => {
    rows.push(row());
    const price = async () => 3800;
    for (let i = 0; i < 2; i++) expect((await markOpenPaperPositions(price, NOW)).overdue).toEqual([]);
    expect((await markOpenPaperPositions(price, NOW)).overdue).toHaveLength(1);
    expect((await markOpenPaperPositions(price, NOW)).overdue).toEqual([]);
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE hedges'));
    expect(update?.[1]).toEqual([3800, expect.closeTo(-50, 6), 'paper_ETH_1']);
  });

  it('no price: the row keeps its last mark and nothing is written for it', async () => {
    rows.push(row());
    const s = await markOpenPaperPositions(async () => { throw new Error('no feed'); }, NOW);
    expect(s.marked).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE hedges'))).toBe(false);
  });
});
