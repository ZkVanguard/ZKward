/**
 * The strike ladder tells the dashboard how far the market prices a coin to
 * move. These tests hold it to what makes that figure worth showing: the
 * width it reports is the width the ladder was priced with, a ladder that
 * cannot be read is an error and never a calm market, and every locale has
 * the words for it.
 */
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { normalCdf } from '@/lib/services/hedging/quant-models';
import { getExpectedMove, pickLadder, readLadder, type LadderStrike } from '@/lib/services/market-data/StrikeLadderService';

const NOW = Date.parse('2026-10-13T07:00:00Z');
const HOUR = 3_600_000;

/** A ladder priced from a lognormal forecast: even odds at `middle`, one standard deviation of `width`. */
const ladder = (middle: number, width: number, strikes: number[]): LadderStrike[] =>
  strikes.map((strike) => ({ strike, yes: normalCdf(Math.log(middle / strike) / width) }));
const BTC_STRIKES = [74_000, 76_000, 78_000, 80_000, 82_000, 84_000, 86_000, 88_000, 90_000, 92_000, 94_000];

describe('readLadder', () => {
  it('recovers the width and the middle the ladder was priced with', () => {
    const r = readLadder(ladder(83_700, 0.021, BTC_STRIKES));
    expect(r).not.toBeNull();
    expect(r!.width).toBeCloseTo(0.021, 4);
    expect(r!.middle / 83_700).toBeCloseTo(1, 4);
  });

  it('reads a wider ladder as a larger move', () => {
    const calm = readLadder(ladder(83_700, 0.015, BTC_STRIKES))!;
    const wild = readLadder(ladder(83_700, 0.045, BTC_STRIKES))!;
    expect(wild.width).toBeGreaterThan(2.5 * calm.width);
  });

  it('lists the strikes under the middle, nearest first, with the chance of ending below each', () => {
    const r = readLadder(ladder(83_700, 0.03, BTC_STRIKES))!;
    // 78,000 and under are priced as all but certain, so they are decided and not listed.
    expect(r.downside.map((d) => d.price)).toEqual([82_000, 80_000]);
    expect(r.downside[0].chance).toBeCloseTo(1 - normalCdf(Math.log(83_700 / 82_000) / 0.03), 6);
    expect(r.downside[0].chance).toBeGreaterThan(r.downside[1].chance);
  });

  it('does not depend on the order the strikes arrive in', () => {
    const strikes = ladder(83_700, 0.021, BTC_STRIKES);
    expect(readLadder([...strikes].reverse())).toEqual(readLadder(strikes));
  });

  it('refuses a ladder with fewer than three undecided strikes: two points do not show a width', () => {
    expect(readLadder(ladder(83_700, 0.004, BTC_STRIKES))).toBeNull();
    expect(readLadder([])).toBeNull();
  });

  it('refuses prices that are not a ladder: a higher strike cannot be the likelier one', () => {
    const strikes = ladder(83_700, 0.021, BTC_STRIKES);
    strikes[6] = { strike: 86_000, yes: 0.9 };
    expect(readLadder(strikes)).toBeNull();
  });

  it('ignores a market with no usable price instead of reading it as zero', () => {
    const strikes = [...ladder(83_700, 0.021, BTC_STRIKES), { strike: 85_000, yes: NaN }, { strike: 0, yes: 0.5 }];
    expect(readLadder(strikes)!.width).toBeCloseTo(0.021, 4);
  });
});

describe('pickLadder', () => {
  const at = (h: number) => ({ resolvesAtMs: NOW + h * HOUR });

  it('takes the first ladder far enough ahead to still have undecided strikes', () => {
    expect(pickLadder([at(57), at(9), at(33)], NOW)).toEqual(at(33));
    expect(pickLadder([at(12), at(36)], NOW)).toEqual(at(12));
  });

  it('has nothing to read when every ladder is about to resolve', () => {
    expect(pickLadder([at(2), at(11.9)], NOW)).toBeNull();
  });
});

describe('getExpectedMove', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const event = (hoursAhead: number, strikes: LadderStrike[]) => ({
    endDate: new Date(NOW + hoursAhead * HOUR).toISOString(),
    markets: strikes.map((s) => ({ groupItemTitle: s.strike.toLocaleString('en-US'), outcomePrices: JSON.stringify([String(s.yes), String(1 - s.yes)]) })),
  });
  const answer = (body: unknown, ok = true, status = 200) => {
    global.fetch = jest.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
  };

  it('reports the move of the ladder that resolves next but not too soon, in percent', async () => {
    answer([event(9, ladder(83_700, 0.01, BTC_STRIKES)), event(33, ladder(83_700, 0.021, BTC_STRIKES)), event(57, ladder(83_700, 0.03, BTC_STRIKES))]);
    const move = await getExpectedMove('BTC', NOW);
    expect(move.resolvesAt).toBe(new Date(NOW + 33 * HOUR).toISOString());
    expect(move.movePct).toBeCloseTo(2.1, 1);
    expect(move.downside[0]).toEqual({ price: 82_000, chancePct: expect.any(Number) });
    expect(move.downside[0].chancePct).toBeGreaterThan(10);
    expect(move.strikes).toBeGreaterThanOrEqual(3);
  });

  it('asks the venue for the open ladders of the coin', async () => {
    answer([event(33, ladder(2_530, 0.03, [2_300, 2_400, 2_500, 2_600, 2_700, 2_800]))]);
    await getExpectedMove('ETH', NOW);
    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toMatch(/series_id=42/);
    expect(url).toMatch(/closed=false/);
  });

  it('an unread ladder is an error, never a calm market', async () => {
    answer([], false, 503);
    await expect(getExpectedMove('BTC', NOW)).rejects.toThrow(/503/);
    answer([event(33, ladder(83_700, 0.004, BTC_STRIKES))]);
    await expect(getExpectedMove('BTC', NOW)).rejects.toThrow(/not readable/);
    answer([event(3, ladder(83_700, 0.021, BTC_STRIKES))]);
    await expect(getExpectedMove('BTC', NOW)).rejects.toThrow(/far enough ahead/);
    answer({ unexpected: 'shape' });
    await expect(getExpectedMove('BTC', NOW)).rejects.toThrow();
  });

  it('has no ladder for a coin the venue does not list one for', async () => {
    await expect(getExpectedMove('DOGE', NOW)).rejects.toThrow(/no strike ladder/);
  });
});

describe('the priced move on the dashboard', () => {
  const root = path.resolve(__dirname, '../..');

  it('every locale has its strings', () => {
    const locales = fs.readdirSync(path.join(root, 'messages')).filter((f) => f.endsWith('.json'));
    expect(locales.length).toBeGreaterThanOrEqual(13);
    for (const f of locales) {
      const board = JSON.parse(fs.readFileSync(path.join(root, 'messages', f), 'utf8')).dashboard.marketBoard;
      const missing = ['pricedMove', 'pricedBy', 'chanceBelow', 'pricedSource', 'pricedFooter'].filter((k) => typeof board[k] !== 'string' || !board[k]);
      expect({ locale: f, missing }).toEqual({ locale: f, missing: [] });
      for (const [key, slot] of [['pricedMove', '{pct}'], ['pricedBy', '{when}'], ['chanceBelow', '{pct}'], ['chanceBelow', '{price}']]) {
        expect({ locale: f, key, has: String(board[key]).includes(slot) }).toEqual({ locale: f, key, has: true });
      }
    }
  });

  it('the route may be served stale while it refreshes, and a failed read is not cached as an answer', () => {
    const src = fs.readFileSync(path.join(root, 'app/api/predictions/expected-move/route.ts'), 'utf8');
    expect(src).toMatch(/stale-while-revalidate=86400/);
    expect(src).toMatch(/withOriginCache\(/);
    expect(src).toMatch(/success: false[\s\S]*status: 502/);
  });
});
