import { describe, it, expect, jest, afterEach } from '@jest/globals';

jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { getHourlyRealizedVolPct } from '@/lib/services/paper-trader/volatility-gate';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe('getHourlyRealizedVolPct', () => {
  it('annualizes the last 24 closed hours and ignores the hour still open', async () => {
    const now = Date.UTC(2026, 10, 4, 18, 30);
    const openHour = Date.UTC(2026, 10, 4, 18) / 1000;
    // Newest first, alternating ±1%; the open hour carries a wild price that must not count.
    const rows = [[openHour, 0, 0, 0, 999, 0]];
    for (let i = 1; i <= 30; i++) rows.push([openHour - i * 3600, 0, 0, 0, i % 2 ? 100 : 101, 0]);
    global.fetch = (async () => ({ ok: true, json: async () => rows })) as unknown as typeof fetch;
    const vol = await getHourlyRealizedVolPct('AAA', now);
    const r = Math.log(101 / 100);
    expect(vol).toBeCloseTo(r * Math.sqrt(365 * 24) * 100, 0);
  });

  it('fails open (null) when the source refuses', async () => {
    global.fetch = (async () => ({ ok: false, status: 451 })) as unknown as typeof fetch;
    expect(await getHourlyRealizedVolPct('BBB')).toBeNull();
  });
});
