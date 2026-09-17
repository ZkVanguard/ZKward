/**
 * Treasury pure-logic tests.
 *
 * Locks the money-path invariants: free-balance math, affordability gate,
 * runway calculation. DB-side idempotency is covered by the ON CONFLICT
 * clause in ensureTreasuryTable — integration test worth adding later,
 * not required here.
 */
import { describe, it, expect } from '@jest/globals';
import {
  canAffordReinvestment,
  runwayMonths,
  type TreasuryState,
} from '@/lib/db/treasury';

function state(overrides: Partial<TreasuryState>): TreasuryState {
  return {
    totalPnlUsd: 0,
    totalOpsUsd: 0,
    totalReinvestUsd: 0,
    bufferUsd: 100,
    freeBalanceUsd: -100,
    healthy: false,
    entries: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('treasury — canAffordReinvestment', () => {
  it('allows spend when it leaves a positive balance', () => {
    const s = state({ freeBalanceUsd: 500 });
    expect(canAffordReinvestment(s, 200)).toBe(true);
  });

  it('rejects spend that would drop free balance to zero', () => {
    const s = state({ freeBalanceUsd: 500 });
    expect(canAffordReinvestment(s, 500)).toBe(false);
  });

  it('rejects spend that would overdraft', () => {
    const s = state({ freeBalanceUsd: 100 });
    expect(canAffordReinvestment(s, 250)).toBe(false);
  });

  it('rejects any spend when already underwater', () => {
    const s = state({ freeBalanceUsd: -50 });
    expect(canAffordReinvestment(s, 1)).toBe(false);
  });

  it('takes the absolute value of the proposed spend (negatives are cost too)', () => {
    const s = state({ freeBalanceUsd: 200 });
    expect(canAffordReinvestment(s, -300)).toBe(false);
    expect(canAffordReinvestment(s, -100)).toBe(true);
  });
});

describe('treasury — runwayMonths', () => {
  it('returns months of runway at the given burn rate', () => {
    const s = state({ freeBalanceUsd: 500 });
    expect(runwayMonths(s, 100)).toBe(5);
  });

  it('returns null when free balance is zero or negative', () => {
    expect(runwayMonths(state({ freeBalanceUsd: 0 }), 100)).toBeNull();
    expect(runwayMonths(state({ freeBalanceUsd: -50 }), 100)).toBeNull();
  });

  it('returns null when burn rate is zero or negative', () => {
    const s = state({ freeBalanceUsd: 500 });
    expect(runwayMonths(s, 0)).toBeNull();
    expect(runwayMonths(s, -10)).toBeNull();
  });

  it('handles fractional months', () => {
    const s = state({ freeBalanceUsd: 375 });
    expect(runwayMonths(s, 100)).toBeCloseTo(3.75);
  });
});
