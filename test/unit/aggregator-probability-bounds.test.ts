/**
 * A probability is 0-100. One source built from an unbounded formula
 * (strike distance × 5000) reported 143% on a 1.9% implied move and the
 * aggregate carried it to the dashboard.
 */
import { describe, it, expect } from '@jest/globals';
import { calculateAggregation } from '@/lib/services/market-data/aggregator-math';
import type { PredictionSource } from '@/lib/services/market-data/PredictionAggregatorService';

const source = (probability: number, weight: number): PredictionSource => ({
  name: `s${probability}`,
  type: 'short_term',
  direction: 'UP',
  confidence: 70,
  probability,
  weight,
  fetchedAt: Date.now(),
});

describe('aggregate probability stays within 0-100', () => {
  it('an out-of-range source cannot push the aggregate past 100', () => {
    const out = calculateAggregation([source(143, 0.5), source(96, 0.5)]);
    expect(out.probability).toBeLessThanOrEqual(100);
    expect(out.probability).toBeCloseTo(98, 5);
  });

  it('or below 0', () => {
    expect(calculateAggregation([source(-40, 1)]).probability).toBe(0);
  });

  it('in-range sources are unchanged', () => {
    expect(calculateAggregation([source(60, 0.5), source(70, 0.5)]).probability).toBeCloseTo(65, 5);
  });
});
