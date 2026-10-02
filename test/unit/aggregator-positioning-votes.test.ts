/**
 * Positioning votes. A funding rate votes only when the market is crowded;
 * the rate these markets pay when nothing is happening is not a signal. The
 * old thresholds sat below that resting rate, so three funding sources and a
 * long/short ratio voted DOWN almost permanently and carried most of the
 * aggregate's weight on every asset but BTC.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { crowdedFundingDirection, FUNDING_CROWDED_RATE } from '@/lib/services/market-data/aggregator-math';

describe('crowdedFundingDirection', () => {
  it('the resting rate (about 1 bp per 8 h) is not a vote, in either sign', () => {
    for (const rate of [0, 0.00005, 0.0001, -0.0001, 0.0002, -0.0002]) expect(crowdedFundingDirection(rate)).toBeNull();
  });

  it('the threshold itself is not crowded; beyond it the vote is contrarian', () => {
    expect(crowdedFundingDirection(FUNDING_CROWDED_RATE)).toBeNull();
    expect(crowdedFundingDirection(FUNDING_CROWDED_RATE * 1.5)).toBe('DOWN');
    expect(crowdedFundingDirection(-FUNDING_CROWDED_RATE * 1.5)).toBe('UP');
  });

  it('crowded means about 33% a year or more', () => {
    expect(FUNDING_CROWDED_RATE * 3 * 365).toBeGreaterThanOrEqual(0.3);
  });

  it('a missing or broken rate is not a vote', () => {
    expect(crowdedFundingDirection(Number.NaN)).toBeNull();
    expect(crowdedFundingDirection(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('the aggregator source list', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib/services/market-data/PredictionAggregatorService.ts'), 'utf8');

  it('every funding vote goes through crowdedFundingDirection', () => {
    const fundingVotes = src.match(/name: `\w+ \$\{asset\} Funding`/g) ?? [];
    expect(fundingVotes).toHaveLength(3);
    expect(src.match(/crowdedFundingDirection\(/g) ?? []).toHaveLength(3);
    expect(src).not.toMatch(/funding(Rate)? > 0 \? 'DOWN' : 'UP'/);
  });

  it('has no long/short account-ratio vote', () => {
    expect(src).not.toMatch(/Long\/Short`/);
    expect(src).not.toMatch(/longShortRatio/);
  });
});
