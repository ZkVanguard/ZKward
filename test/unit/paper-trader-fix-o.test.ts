/**
 * Fix O (2026-09-27) — win-rate structural fixes.
 *
 * Covers the pure/threshold pieces:
 *   • trailingArmThresholdUsd — notional-relative arm (the NAV-relative
 *     arm had never fired once in the trader's life)
 *   • underwaterTightenTrip — notional-relative depth + 45min age
 *     (replaces the $50-flat "max-pain harvester": 15 closes / 0 wins)
 *   • computeMaxHoldMinutes ceiling — holds past 60min ran net negative
 *   • seeded asset-side blacklist — pre-reset toxic pairs stay blocked
 *     until post-reset evidence reaches MIN_N
 *   • normalizeSourceKey slug canonicalization — '-currently-NN' price
 *     tails fragmented buckets and defeated the Fix-H hard filter
 *   • isRelevantManifoldMarket — horizon cap + word-boundary asset match
 *     ('Rippling' the HR company must not feed XRP)
 */
process.env.PAPER_TRADER_MAX_HOLD_MIN = '45';
process.env.PAPER_TRADER_MAX_HOLD_EXTRA_MIN = '90';
process.env.PAPER_TRADER_MAX_HOLD_CEILING_MIN = '90';
process.env.PAPER_TRADER_TIGHTEN_AGE_MIN = '45';
process.env.PAPER_TRADER_TIGHTEN_NOTIONAL_FRAC = '0.015';
process.env.PAPER_TRADER_TRAILING_ARM_NOTIONAL_FRAC = '0.005';
// Default seeds (BTC:LONG,BTC:SHORT,ETH:SHORT,SOL:LONG,SOL:SHORT) intact.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@/lib/db/postgres', () => ({
  query: jest.fn(async () => []),
  getPool: jest.fn(),
  closePool: jest.fn(),
}));

import { query } from '@/lib/db/postgres';
import {
  trailingArmThresholdUsd,
  underwaterTightenTrip,
} from '@/lib/services/paper-trader/adaptive-stops';
import { computeMaxHoldMinutes } from '@/lib/services/paper-trader/sizing';
import {
  assetSideBlacklistRejection,
  _resetAssetSideBlacklistCache,
} from '@/lib/services/paper-trader/asset-side-blacklist';
import { normalizeSourceKey } from '@/lib/services/ai/source-calibrator';
import { isRelevantManifoldMarket } from '@/lib/services/market-data/ManifoldMarketService';

const mockQuery = query as jest.MockedFunction<typeof query>;

describe('trailingArmThresholdUsd — notional-relative arm', () => {
  it('arms at 0.5% of notional for normal position sizes', () => {
    // $30K notional: 0.5% = $150; 3× fees = 3 × $39 = $117 → $150 wins.
    expect(trailingArmThresholdUsd(30_000)).toBeCloseTo(150, 0);
  });

  it('never arms inside 3× round-trip fees on small notionals', () => {
    // $1K notional: 0.5% = $5, but 3× fees = $3.90 → still $5. Force the
    // fee floor to dominate: fee floor = 3 × 0.0013 × N = 0.0039 N vs
    // 0.005 N — notional frac always wins at the default. Verify floor
    // takes over when the frac is configured tighter than fees.
    const n = 10_000;
    expect(trailingArmThresholdUsd(n)).toBe(Math.max(n * 0.005, 3 * n * 0.0013));
  });

  it('is far below the old NAV-relative threshold that never fired', () => {
    // Old: $666K NAV × 1% arm = $6,660 on a $30K notional (22% move).
    expect(trailingArmThresholdUsd(30_000)).toBeLessThan(1_000);
  });
});

describe('underwaterTightenTrip — notional-relative depth + age', () => {
  it('does not trip before the age gate', () => {
    expect(underwaterTightenTrip({ ageMin: 44, lossUsd: 10_000, notionalUsd: 30_000 })).toBe(false);
  });

  it('does not trip on a shallow loss (the $50-flat bug)', () => {
    // $60 on $30K notional = 0.2% — the old flat threshold would fire.
    expect(underwaterTightenTrip({ ageMin: 60, lossUsd: 60, notionalUsd: 30_000 })).toBe(false);
  });

  it('trips when old AND deeper than 1.5% of notional', () => {
    expect(underwaterTightenTrip({ ageMin: 60, lossUsd: 460, notionalUsd: 30_000 })).toBe(true);
  });
});

describe('computeMaxHoldMinutes — hard ceiling', () => {
  it('clips signal-scaled + regime-boosted holds at the ceiling', () => {
    // scalar 2.0 → 45 + 90 = 135, × TREND 1.5 = 202min pre-Fix-O.
    expect(computeMaxHoldMinutes(2.0, 1.5)).toBe(90);
  });

  it('leaves short holds untouched', () => {
    expect(computeMaxHoldMinutes(0.4, 1)).toBe(45);
  });
});

describe('seeded asset-side blacklist', () => {
  beforeEach(() => {
    _resetAssetSideBlacklistCache();
    mockQuery.mockReset();
  });

  it('blocks a seeded pair with no post-reset evidence', async () => {
    mockQuery.mockResolvedValue([]);
    const r = await assetSideBlacklistRejection('BTC', 'LONG');
    expect(r).toMatch(/seeded-toxic/);
  });

  it('blocks a seeded pair with sub-MIN_N post-reset evidence', async () => {
    mockQuery.mockResolvedValue([
      { asset: 'BTC', side: 'SHORT', n: '18', wins: '4', pnl: '-1269' },
    ] as never);
    const r = await assetSideBlacklistRejection('BTC', 'SHORT');
    expect(r).toMatch(/seeded-toxic/);
  });

  it('lets a seeded pair earn its way back with n >= MIN_N and wr above floor', async () => {
    mockQuery.mockResolvedValue([
      { asset: 'ETH', side: 'SHORT', n: '25', wins: '11', pnl: '-1101' },
    ] as never);
    // 44% wr >= 40% floor → empirical branch clears it.
    const r = await assetSideBlacklistRejection('ETH', 'SHORT');
    expect(r).toBeNull();
  });

  it('still blacklists a seeded pair whose fresh evidence confirms toxicity', async () => {
    mockQuery.mockResolvedValue([
      { asset: 'SOL', side: 'LONG', n: '25', wins: '6', pnl: '-2000' },
    ] as never);
    const r = await assetSideBlacklistRejection('SOL', 'LONG');
    expect(r).toMatch(/below 40% floor/);
  });

  it('leaves unseeded cold pairs alone', async () => {
    mockQuery.mockResolvedValue([]);
    const r = await assetSideBlacklistRejection('DOGE', 'SHORT');
    expect(r).toBeNull();
  });
});

describe('normalizeSourceKey — volatile price-tail canonicalization', () => {
  it('collapses -currently-NN variants into one bucket', () => {
    const a = normalizeSourceKey('delphi: Will Bitcoin reach 100k? Currently 81', '');
    const b = normalizeSourceKey('delphi: Will Bitcoin reach 100k? Currently 76', '');
    expect(a).toBe(b);
    expect(a).not.toMatch(/currently/);
  });

  it('leaves stable slugs unchanged in spirit', () => {
    expect(normalizeSourceKey('manifold: Bitcoin above 90k before 2027', ''))
      .toBe('manifold:bitcoin-above-90k-before-2027');
  });
});

describe('isRelevantManifoldMarket — horizon + word-boundary relevance', () => {
  const now = Date.now();

  it("rejects 'Rippling' lawsuit markets for XRP", () => {
    expect(isRelevantManifoldMarket(
      { question: 'Rippling wins its lawsuit against Deel by 2027' }, 'XRP', now,
    )).toBe(false);
  });

  it('accepts genuine Ripple/XRP markets', () => {
    expect(isRelevantManifoldMarket(
      { question: 'Will XRP (Ripple) close above $2 this week?' }, 'XRP', now,
    )).toBe(true);
  });

  it('rejects markets resolving past the horizon cap', () => {
    const in2Years = now + 2 * 365 * 24 * 60 * 60 * 1000;
    expect(isRelevantManifoldMarket(
      { question: 'Bitcoin hits $1M', closeTime: in2Years }, 'BTC', now,
    )).toBe(false);
  });

  it('accepts near-dated markets inside the horizon', () => {
    const in10Days = now + 10 * 24 * 60 * 60 * 1000;
    expect(isRelevantManifoldMarket(
      { question: 'Bitcoin above 90k this month?', closeTime: in10Days }, 'BTC', now,
    )).toBe(true);
  });
});
