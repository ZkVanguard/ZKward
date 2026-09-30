/**
 * CHOP regime entries size at PAPER_CHOP_STAKE_MULT (default 0.25) instead
 * of being halted; trending entries are untouched.
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
  PAPER_HALT_ENTRIES_IN_CHOP,
  PAPER_STAKE_PCT,
  PAPER_MAX_STAKE_PCT,
} from '@/lib/services/paper-trader/config';

const NAV = 100_000;
const pick = (regime: PickedCandidate['regime']): PickedCandidate =>
  ({
    asset: 'BTC',
    side: 'LONG',
    score: 1,
    regime,
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
