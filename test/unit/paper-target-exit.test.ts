/**
 * Target-exit levels: the take-profit sits in the trade's favour, the stop
 * against it, and a position without a take-profit is never closed by one.
 */
import { describe, it, expect } from '@jest/globals';
import { targetExitLevels, takeProfitHit } from '@/lib/services/paper-trader/target-exit';
import { categorizeCloseReason } from '@/lib/services/paper-trader/close-pipeline';

describe('targetExitLevels', () => {
  it('LONG: take-profit above entry, stop below', () => {
    const l = targetExitLevels('LONG', 100, 25, 200, 1440);
    expect(l.takeProfitPrice).toBeCloseTo(100.25, 8);
    expect(l.stopLossPrice).toBeCloseTo(98, 8);
    expect(l.maxHoldMin).toBe(1440);
  });

  it('SHORT: take-profit below entry, stop above', () => {
    const l = targetExitLevels('SHORT', 100, 25, 200, 1440);
    expect(l.takeProfitPrice).toBeCloseTo(99.75, 8);
    expect(l.stopLossPrice).toBeCloseTo(102, 8);
  });

  it('the default take-profit clears round-trip friction of about 17 bp', () => {
    const l = targetExitLevels('LONG', 10_000);
    expect((l.takeProfitPrice - 10_000) / 10_000 * 10_000).toBeGreaterThan(17);
  });
});

describe('takeProfitHit', () => {
  it('LONG hits at or above the level, not below', () => {
    const pos = { side: 'LONG' as const, takeProfitPrice: 100.25 };
    expect(takeProfitHit(pos, 100.24)).toBe(false);
    expect(takeProfitHit(pos, 100.25)).toBe(true);
    expect(takeProfitHit(pos, 101)).toBe(true);
  });

  it('SHORT hits at or below the level, not above', () => {
    const pos = { side: 'SHORT' as const, takeProfitPrice: 99.75 };
    expect(takeProfitHit(pos, 99.76)).toBe(false);
    expect(takeProfitHit(pos, 99.75)).toBe(true);
    expect(takeProfitHit(pos, 99)).toBe(true);
  });

  it('a position opened before the policy has no take-profit and never hits', () => {
    expect(takeProfitHit({ side: 'LONG' as const }, 1_000_000)).toBe(false);
  });
});

describe('close reason', () => {
  it('a take-profit close is its own category', () => {
    expect(categorizeCloseReason('take-profit: mark $100.30 reached $100.25')).toBe('take-profit');
  });
});
