/**
 * A close the venue did not confirm must change nothing. On 2026-10-07 the
 * trader booked such a close, counted the trade and cleared its record; the
 * position stayed on the venue, unmanaged, for days.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const setCronState = jest.fn(async (_k: string, _v: unknown) => {});
jest.mock('@/lib/db/cron-state', () => ({
  ...(jest.requireActual('@/lib/db/cron-state') as object),
  setCronState: (k: string, v: unknown) => setCronState(k, v),
}));
const notifyDiscord = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/utils/discord-notify', () => ({ notifyDiscord: (...a: unknown[]) => notifyDiscord(...a) }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const recordOutcome = jest.fn(async (_a: unknown) => {});
jest.mock('@/lib/services/ai/probability-calibrator', () => ({ recordOutcome: (a: unknown) => recordOutcome(a) }));
jest.mock('@/lib/services/sui/BluefinService', () => ({ BluefinService: class {} }));

import { finalizeClosingExit, CloseNotConfirmedError } from '@/app/api/cron/polymarket-edge-trader/handlers/state-transitions';
import { KEY_ACTIVE, KEY_STATS, KEY_DAILY } from '@/app/api/cron/polymarket-edge-trader/handlers/config';

type Args = Parameters<typeof finalizeClosingExit>[0];
const active = {
  symbol: 'SOL-PERP', asset: 'SOL', side: 'LONG', size: 0.2, entryPrice: 118.03, stakeUsd: 5,
  confidence: 80, openedAt: 0, closeBy: 0,
} as unknown as Args['active'];
const stats = { trades: 242, wins: 141, losses: 101, totalPnlUsd: -22.2, peakPnlUsd: 0.07, consecutiveLosses: 0, lastUpdatedMs: 0, haltAnchorPnlUsd: -22 };
const daily = { utcDayKey: '2026-10-07', pnlUsd: 0.2, trades: 2 };
const run = (closeHedge: () => Promise<unknown>) =>
  finalizeClosingExit({ bf: { closeHedge } as unknown as Args['bf'], active, refPrice: 117.5, safeStats: stats, daily, haltedUntil: 0 });

beforeEach(() => jest.clearAllMocks());

describe('a close the venue did not confirm', () => {
  it('books nothing, keeps the trade on record and says so', async () => {
    await expect(run(async () => ({ success: false, error: 'silent reject' }))).rejects.toBeInstanceOf(CloseNotConfirmedError);
    expect(setCronState).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(notifyDiscord.mock.calls[0][1]).toBe('ERROR');
    expect(String(notifyDiscord.mock.calls[0][0])).toMatch(/SOL-PERP LONG was not confirmed.*silent reject.*Nothing was booked/);
  }, 10_000);

  it('a close call that throws is the same case', async () => {
    await expect(run(async () => { throw new Error('venue 503'); })).rejects.toThrow(/venue 503/);
    expect(setCronState).not.toHaveBeenCalled();
  }, 10_000);
});

describe('a confirmed close', () => {
  it('is booked once, carries the halt anchor forward, and clears the trade last', async () => {
    const r = await run(async () => ({ success: true, executionPrice: 117.53, fees: 0.01 }));
    expect(r.realized).toBeCloseTo((117.53 - 118.03) * 0.2 - 0.01, 6);
    const keys = setCronState.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([KEY_STATS, KEY_DAILY, KEY_ACTIVE]);
    expect(setCronState.mock.calls[0][1]).toMatchObject({ trades: 243, haltAnchorPnlUsd: -22 });
    expect(setCronState.mock.calls[2][1]).toBeNull();
  });
});
