/**
 * Fix G (2026-09-25) — short-window rolling-loss halt.
 *
 * Verifies the check that walks paper trader losses in the trailing
 * PAPER_ROLLING_LOSS_WINDOW_MIN minutes and halts on:
 *   - loss count ≥ PAPER_ROLLING_LOSS_COUNT_TRIP
 *   - OR |loss sum| ≥ PAPER_ROLLING_LOSS_USD_TRIP
 *
 * Uses jest mocks for cron_state + query (no DB access). Reaches the
 * private method via bracket-notation cast.
 */
type QueryFn = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

const cronState = new Map<string, unknown>();
const mockQuery: jest.MockedFunction<QueryFn> = jest.fn();

jest.mock('../../lib/db/cron-state', () => ({
  getCronState: jest.fn(async <T,>(key: string): Promise<T | null> => (cronState.get(key) as T | null) ?? null),
  setCronState: jest.fn(async (key: string, value: unknown) => { cronState.set(key, value); }),
}));

jest.mock('../../lib/db/postgres', () => ({
  query: (...args: unknown[]) => (mockQuery as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));

jest.mock('../../lib/utils/discord-notify', () => ({
  notifyDiscord: jest.fn(async () => undefined),
}));

// Env before import so the constants freeze at expected values.
process.env.PAPER_TRADER_ROLLING_LOSS_WINDOW_MIN = '90';
process.env.PAPER_TRADER_ROLLING_LOSS_COUNT_TRIP = '5';
process.env.PAPER_TRADER_ROLLING_LOSS_USD_TRIP = '500';
process.env.PAPER_TRADER_ROLLING_LOSS_HALT_HOURS = '4';

import { PaperTrader } from '../../lib/services/paper-trader/PaperTrader';

// Bracket-notation cast to reach the private static.
const check = (PaperTrader as unknown as {
  shortWindowLossCheck: (now: number) => Promise<string | null>;
}).shortWindowLossCheck;

function mockDbResult(loss_count: number, loss_sum: number) {
  mockQuery.mockResolvedValueOnce([{ loss_count: String(loss_count), loss_sum: String(loss_sum) }] as never);
}

describe('Fix G — short-window rolling-loss halt', () => {
  const NOW = 1_790_000_000_000;

  beforeEach(() => {
    cronState.clear();
    mockQuery.mockReset();
  });

  it('no losses → no halt', async () => {
    mockDbResult(0, 0);
    const r = await check(NOW);
    expect(r).toBeNull();
  });

  it('4 losses below both thresholds → no halt', async () => {
    mockDbResult(4, -300);
    const r = await check(NOW);
    expect(r).toBeNull();
  });

  it('5 losses of any magnitude → halt (count trip)', async () => {
    mockDbResult(5, -50);
    const r = await check(NOW);
    expect(r).toContain('short-window-loss halt');
    expect(r).toContain('count');
  });

  it('4 losses summing to $700 → halt (usd trip)', async () => {
    mockDbResult(4, -700);
    const r = await check(NOW);
    expect(r).toContain('usd');
  });

  it('halt state persists — second call returns countdown message', async () => {
    mockDbResult(5, -600);
    const first = await check(NOW);
    expect(first).toContain('halted');
    const second = await check(NOW + 60_000);
    expect(second).toContain('remaining');
    // second call should NOT re-query DB (halt short-circuits)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('re-check debounce — <5min since last check returns null without query', async () => {
    mockDbResult(0, 0);
    await check(NOW);
    const second = await check(NOW + 60_000); // 1 min later
    expect(second).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
