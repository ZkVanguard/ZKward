/**
 * Stake multipliers that replace hard blocks: CHOP regime entries size at
 * PAPER_CHOP_STAKE_MULT and blacklisted pairs at
 * PAPER_BLACKLIST_PROBE_STAKE_MULT (both default 0.25).
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@/lib/services/paper-trader/vol-autotune', () => ({
  getVolMultiplier: jest.fn(async () => 1),
}));
jest.mock('@/lib/services/paper-trader/sizing', () => {
  const actual = jest.requireActual('@/lib/services/paper-trader/sizing') as object;
  return { ...actual, computeCalibrationBoost: jest.fn(async () => 1) };
});

import { sizeCandidate, type PickedCandidate } from '@/lib/services/paper-trader/entry-helpers';
import {
  PAPER_CHOP_STAKE_MULT,
  PAPER_BLACKLIST_PROBE_STAKE_MULT,
  PAPER_HALT_ENTRIES_IN_CHOP,
  PAPER_STAKE_PCT,
  PAPER_MAX_STAKE_PCT,
} from '@/lib/services/paper-trader/config';

const NAV = 100_000;
const pick = (regime: PickedCandidate['regime'], probe: string | null = null): PickedCandidate =>
  ({
    asset: 'BTC',
    side: 'LONG',
    score: 1,
    regime,
    probe,
    prediction: { confidence: 72, consensus: 60, sources: [] },
  }) as unknown as PickedCandidate;

describe('chop-regime sizing', () => {
  it('defaults: no full halt, quarter stake in CHOP', () => {
    expect(PAPER_HALT_ENTRIES_IN_CHOP).toBe(false);
    expect(PAPER_CHOP_STAKE_MULT).toBe(0.25);
  });

  it('CHOP stake = trending stake math × 0.25 (then the NAV cap)', async () => {
    const trend = await sizeCandidate(pick('TRENDING_UP'), NAV, 1);
    const chop = await sizeCandidate(pick('CHOP'), NAV, 1);
    expect(trend.regimeStakeMult).toBe(1);
    expect(chop.regimeStakeMult).toBe(0.25);
    const expected = Math.min(NAV * PAPER_STAKE_PCT * chop.signalScalar * 0.25, NAV * PAPER_MAX_STAKE_PCT);
    expect(chop.stakeUsd).toBeCloseTo(expected, 6);
    expect(chop.stakeUsd).toBeLessThan(trend.stakeUsd);
  });

  it('unknown regime (classifier down) sizes like trending — never zero', async () => {
    const r = await sizeCandidate(pick(null), NAV, 1);
    expect(r.regimeStakeMult).toBe(1);
    expect(r.stakeUsd).toBeGreaterThan(0);
  });
});

describe('blacklist probe sizing', () => {
  const capped = (mult: number, signalScalar: number) =>
    Math.min(NAV * PAPER_STAKE_PCT * signalScalar * mult, NAV * PAPER_MAX_STAKE_PCT);

  it('a blacklisted pair trades at probe stake instead of being blocked', async () => {
    expect(PAPER_BLACKLIST_PROBE_STAKE_MULT).toBe(0.25);
    const full = await sizeCandidate(pick('TRENDING_UP'), NAV, 1);
    const probe = await sizeCandidate(pick('TRENDING_UP', 'asset-side-blacklist: BTC LONG'), NAV, 1);
    expect(full.probeStakeMult).toBe(1);
    expect(probe.probeStakeMult).toBe(0.25);
    expect(probe.stakeUsd).toBeCloseTo(capped(0.25, probe.signalScalar), 6);
    expect(probe.stakeUsd).toBeGreaterThan(0);
  });

  it('probe and chop stack', async () => {
    const both = await sizeCandidate(pick('CHOP', 'asset-side-blacklist: BTC SHORT'), NAV, 1);
    expect(both.stakeUsd).toBeCloseTo(capped(0.25 * 0.25, both.signalScalar), 6);
  });
});
