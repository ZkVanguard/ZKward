/**
 * The floor book's proof: its result against holding the coins from the same
 * start prices, shown on the paper scoreboard.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@/lib/db/cron-state', () => ({ getCronStateStrict: jest.fn(async () => null), getCronState: jest.fn(async () => null), setCronState: jest.fn(async () => {}) }));
jest.mock('@/lib/db/postgres', () => ({ query: jest.fn(async () => []) }));

import { floorProof, floorProofLine, type FloorStateView } from '@/lib/services/paper-trader/floor-proof';
import { scoreboardEmbed, FLOOR_FIELD } from '@/lib/services/paper-trader/notifications';

// The book's real state and marks on 2026-10-19.
const STATE: FloorStateView = {
  startedAtMs: Date.parse('2026-10-13T16:26:27Z'),
  startPrices: { BTC: 83_506.09, ETH: 2_518.39 },
  valueUsd: 98_905.99,
  maxDrawdown: 0.01882,
  exposureUsd: 26_093.1,
};
const MARKS = new Map([['BTC', 81_910], ['ETH', 2_396.77]]);
const NOW = Date.parse('2026-10-19T18:00:00Z');

describe('floorProof', () => {
  it('sets the book against holding half BTC and half ETH from its start prices', () => {
    const p = floorProof(STATE, MARKS, NOW)!;
    expect(p.bookPct).toBeCloseTo(-1.094, 2);
    expect(p.coinPct.BTC).toBeCloseTo(-1.911, 2);
    expect(p.coinPct.ETH).toBeCloseTo(-4.829, 2);
    expect(p.holdPct).toBeCloseTo(-3.370, 2);
    expect(p.avoidedShare).toBeCloseTo(1 - 1.094 / 3.370, 2);
    expect(p.worstFallPct).toBeCloseTo(1.882, 3);
  });

  it('claims no avoided fall when holding is up', () => {
    expect(floorProof(STATE, new Map([['BTC', 90_000], ['ETH', 2_700]]), NOW)!.avoidedShare).toBeNull();
  });

  it('a missing mark or start price gives no proof rather than a wrong one', () => {
    expect(floorProof(STATE, new Map([['BTC', 81_910]]), NOW)).toBeNull();
    expect(floorProof({ ...STATE, startPrices: { BTC: 83_506 } }, MARKS, NOW)).toBeNull();
  });

  it('reads as one plain line', () => {
    const line = floorProofLine(floorProof(STATE, MARKS, NOW)!);
    expect(line).toContain('−1.1 % vs holding −3.4 % (BTC −1.9 %, ETH −4.8 %)');
    expect(line).toContain('avoided 68 % of the fall');
    expect(line).toContain('worst fall 1.9 %');
    expect(line).toContain('day 7');
  });
});

describe('the scoreboard', () => {
  it('shows the floor line when there is one, and nothing when there is not', () => {
    const base = { market: [], open: [], books: [], longLabel: '7 d' };
    const withFloor = scoreboardEmbed({ ...base, floor: 'X' }, NOW);
    expect(withFloor.fields?.find((f) => f.name === FLOOR_FIELD)?.value).toBe('X');
    expect(scoreboardEmbed({ ...base, floor: null }, NOW).fields?.some((f) => f.name === FLOOR_FIELD)).toBe(false);
  });
});
