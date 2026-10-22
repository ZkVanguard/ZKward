/**
 * The paper books pay the venue's funding as it was settled, hour by hour,
 * not a flat 11% a year (about twice what longs paid from 2025-07 to 2026-10,
 * and never negative, which real funding is in about 15% of hours).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => state.get(k) ?? null),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { loadFundingHistory, mergeHours, venueHourlyFunding } from '@/lib/services/paper-trader/funding-rate';
import { FUNDING_APR, fundingForHold, markToMarket, setFundingHistory, simulateClose, simulateOpen } from '@/lib/services/paper-trader/simulated-executor';

const H = 3_600_000;
const NOW = Date.parse('2026-10-22T20:00:00Z');
/** n hourly settlements ending at `end`, each at `rate`. */
const hours = (n: number, rate: number, end = NOW): Array<[number, number]> => Array.from({ length: n }, (_, i) => [end - (n - 1 - i) * H, rate]);

beforeEach(() => { state.clear(); setFundingHistory({}); });

describe('fundingForHold', () => {
  it('a long pays exactly the hours settled while it was open; a short collects them', () => {
    setFundingHistory({ BTC: [...hours(10, 1e-5, NOW - 10 * H), ...hours(10, 3e-5)] });
    // open at NOW - 5 h: the five settlements after it, at 3e-5 each
    expect(fundingForHold(1000, 'BTC', 'LONG', NOW - 5 * H, NOW)).toBeCloseTo(-1000 * 5 * 3e-5, 9);
    expect(fundingForHold(1000, 'BTC', 'SHORT', NOW - 5 * H, NOW)).toBeCloseTo(1000 * 5 * 3e-5, 9);
  });

  it('negative funding pays a long', () => {
    setFundingHistory({ ETH: hours(24, -2e-5) });
    expect(fundingForHold(1000, 'ETH', 'LONG', NOW - 24 * H, NOW)).toBeGreaterThan(0);
  });

  it('the part of a hold before the kept history is charged the kept average', () => {
    setFundingHistory({ BTC: hours(10, 2e-5) });
    // 5 hours before the first kept settlement at 2e-5 average, plus all 10 kept settlements
    expect(fundingForHold(1000, 'BTC', 'LONG', NOW - 14 * H, NOW)).toBeCloseTo(-1000 * (5 + 10) * 2e-5, 9);
  });

  it('the past is not re-priced: a later, higher reading does not change hours already settled', () => {
    setFundingHistory({ BTC: hours(5, 1e-5, NOW) });
    // opened inside the kept hours (the first is at NOW - 4 h)
    const before = fundingForHold(1000, 'BTC', 'LONG', NOW - 3.5 * H, NOW);
    setFundingHistory({ BTC: [...hours(5, 1e-5, NOW), [NOW + H, 9e-4]] });
    expect(fundingForHold(1000, 'BTC', 'LONG', NOW - 3.5 * H, NOW)).toBeCloseTo(before, 12);
  });

  it('a coin with no history is charged the old assumption', () => {
    expect(fundingForHold(1000, 'XRP', 'LONG', NOW - 24 * H, NOW)).toBeCloseTo(-1000 * FUNDING_APR / 365, 6);
  });

  it('close and mark-to-market both charge it', () => {
    setFundingHistory({ BTC: hours(48, 1e-5) });
    const pos = simulateOpen({ asset: 'BTC', side: 'LONG', notionalUsd: 1000, leverage: 1, entryPrice: 80_000 }, NOW - 24 * H);
    expect(markToMarket(pos, 80_000, NOW).fundingAccruedUsd).toBeCloseTo(-1000 * 24 * 1e-5, 9);
    expect(simulateClose(pos, 80_000, NOW).fundingUsd).toBeCloseTo(-1000 * 24 * 1e-5, 9);
  });
});

describe('mergeHours', () => {
  it('one settlement per hour, in order, nothing older than 90 days', () => {
    const merged = mergeHours([[NOW - 100 * 24 * H, 1e-5], [NOW - 2 * H, 1e-5]], [[NOW - 2 * H, 2e-5], [NOW - H, 3e-5]], NOW);
    expect(merged).toEqual([[NOW - 2 * H, 2e-5], [NOW - H, 3e-5]]);
  });
});

describe('loadFundingHistory', () => {
  it('reads the venue at most once an hour and hands the hours to the executor', async () => {
    const read = jest.fn(async (coin: string) => (coin === 'BTC' ? hours(48, 1e-5) : []));
    await loadFundingHistory(NOW, read);
    const calls = read.mock.calls.length;
    await loadFundingHistory(NOW + 30 * 60_000, read);
    expect(read.mock.calls.length).toBe(calls);
    await loadFundingHistory(NOW + H, read);
    expect(read.mock.calls.length).toBe(2 * calls);
    expect(fundingForHold(1000, 'BTC', 'LONG', NOW - 24 * H, NOW)).toBeCloseTo(-1000 * 24 * 1e-5, 9);
  });

  it('a coin that cannot be read keeps its kept hours', async () => {
    await loadFundingHistory(NOW, async () => hours(48, 1e-5));
    await loadFundingHistory(NOW + H, async (coin: string) => { if (coin === 'BTC') throw new Error('HTTP 502'); return []; });
    expect((state.get('paper:funding-hours') as { hours: Record<string, unknown[]> }).hours.BTC).toHaveLength(48);
  });

  it('when nothing can be read, nothing is written and the next tick tries again', async () => {
    await loadFundingHistory(NOW, async () => hours(48, 1e-5));
    const before = JSON.stringify(state.get('paper:funding-hours'));
    const read = jest.fn(async () => { throw new Error('down'); });
    await loadFundingHistory(NOW + H, read);
    expect(JSON.stringify(state.get('paper:funding-hours'))).toBe(before);
    await loadFundingHistory(NOW + H + 60_000, read);
    expect(read.mock.calls.length).toBeGreaterThan(6); // tried again on the next tick
  });
});

describe('venueHourlyFunding', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('drops prints beyond the venue\'s 0.1%-an-hour cap', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { fundingRateE9: '6500', fundingTimeAtMillis: NOW - H },
      { fundingRateE9: '91260708000', fundingTimeAtMillis: NOW - 2 * H }, // a launch-period print
    ]), { status: 200 })) as typeof fetch;
    expect(await venueHourlyFunding('BTC', NOW)).toEqual([[NOW - H, 6.5e-6]]);
  });

  it('a failed read is an error, not an empty history', async () => {
    globalThis.fetch = (async () => new Response('busy', { status: 503 })) as typeof fetch;
    await expect(venueHourlyFunding('BTC', NOW)).rejects.toThrow(/503/);
  });
});
