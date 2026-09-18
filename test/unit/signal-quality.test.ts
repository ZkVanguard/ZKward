import { describe, it, expect } from '@jest/globals';
import { majorityAgreementPct } from '@/lib/services/paper-trader/signal-quality';

describe('majorityAgreementPct — kills the 22% win rate root cause', () => {
  it('returns 1.0 when all sources agree with aggregate', () => {
    const srcs = [{ direction: 'UP' }, { direction: 'UP' }, { direction: 'UP' }];
    expect(majorityAgreementPct('UP', srcs)).toBe(1.0);
  });

  it('returns 0.5 for exact tie (rejected at default 0.6 threshold)', () => {
    const srcs = [{ direction: 'UP' }, { direction: 'DOWN' }];
    expect(majorityAgreementPct('UP', srcs)).toBe(0.5);
  });

  it('exposes the ETH bug: aggregate UP with only 3/7 agreeing = 43%', () => {
    // Real observed data 2026-09-18: aggregate=HEDGE_LONG, only 3/7 sources UP
    const srcs = [
      { direction: 'UP' }, { direction: 'UP' }, { direction: 'UP' },
      { direction: 'DOWN' }, { direction: 'DOWN' }, { direction: 'DOWN' }, { direction: 'DOWN' },
    ];
    const pct = majorityAgreementPct('UP', srcs);
    expect(pct).toBeCloseTo(3 / 7, 2);
    expect(pct).toBeLessThan(0.6); // Would trip the default filter
  });

  it('returns 0 for NEUTRAL aggregate (can\'t count NEUTRAL agreement)', () => {
    const srcs = [{ direction: 'UP' }, { direction: 'DOWN' }];
    expect(majorityAgreementPct('NEUTRAL', srcs)).toBe(0);
  });

  it('returns 0 for empty source list', () => {
    expect(majorityAgreementPct('UP', [])).toBe(0);
  });

  it('ignores NEUTRAL sources in the count (they don\'t agree with UP or DOWN)', () => {
    const srcs = [
      { direction: 'UP' }, { direction: 'UP' },
      { direction: 'NEUTRAL' }, { direction: 'NEUTRAL' },
    ];
    // 2 UP out of 4 total = 50%
    expect(majorityAgreementPct('UP', srcs)).toBe(0.5);
  });
});
