/**
 * Target-exit levels: the take-profit sits in the trade's favour, the stop
 * against it. The take-profit fill itself is covered in
 * paper-resting-orders.test.ts.
 */
import { describe, it, expect } from '@jest/globals';
import { targetExitLevels } from '@/lib/services/paper-trader/target-exit';
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

describe('close reason', () => {
  it('a take-profit close is its own category', () => {
    expect(categorizeCloseReason('take-profit: mark $100.30 reached $100.25')).toBe('take-profit');
  });
});
