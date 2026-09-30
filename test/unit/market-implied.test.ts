/**
 * Market-implied direction — the forecast is the YES price read against
 * spot, never the question's wording. Titles below are real feed titles.
 */
import { describe, it, expect } from '@jest/globals';
import {
  marketImpliedSide,
  marketImpliedDirection,
  parseMarketQuestion,
} from '@/lib/services/market-data/market-implied';

const BTC = 84_000;

describe('marketImpliedSide — trade the odds, not the wording', () => {
  it('"above $88k" at 70% with BTC at $84k → LONG (must rise past the strike)', () => {
    expect(marketImpliedSide('UP', 0.7, 84_000, 88_000)).toBe('LONG');
  });
  it('"above $88k" at 3% with BTC at $84k → no trade (likely outcome already true: stays below)', () => {
    expect(marketImpliedSide('UP', 0.03, 84_000, 88_000)).toBeNull();
  });
  it('"above $80k" at 90% with BTC at $83.7k → no trade (the losing pattern of the six real trades)', () => {
    expect(marketImpliedSide('UP', 0.9, 83_700, 80_000)).toBeNull();
  });
  it('"above $80k" at 20% with BTC at $83.7k → SHORT (market expects a drop below the strike)', () => {
    expect(marketImpliedSide('UP', 0.2, 83_700, 80_000)).toBe('SHORT');
  });
  it('"below $81k" at 70% with BTC at $84k → SHORT; at 20% → no trade', () => {
    expect(marketImpliedSide('DOWN', 0.7, 84_000, 81_000)).toBe('SHORT');
    expect(marketImpliedSide('DOWN', 0.2, 84_000, 81_000)).toBeNull();
  });
  it('coin-flip odds, missing price or strike, or non-directional condition → no trade', () => {
    expect(marketImpliedSide('UP', 0.55, 84_000, 88_000)).toBeNull();
    expect(marketImpliedSide('UP', null, 84_000, 88_000)).toBeNull();
    expect(marketImpliedSide('UP', 0.7, 84_000, null)).toBeNull();
    expect(marketImpliedSide('BINARY_YES', 0.9, 84_000, 88_000)).toBeNull();
  });
});

describe('parseMarketQuestion', () => {
  it('terminal comparisons keep their wording', () => {
    expect(parseMarketQuestion('Will the price of Bitcoin be above $86,000 on September 30?'))
      .toEqual({ kind: 'threshold', wording: 'UP', touch: false, strike: 86_000 });
    expect(parseMarketQuestion('Will Bitcoin be higher than $77,777 at the end of 2025?'))
      .toEqual({ kind: 'threshold', wording: 'UP', touch: false, strike: 77_777 });
    expect(parseMarketQuestion('Will XRP be under $2.10 on October 1?'))
      .toEqual({ kind: 'threshold', wording: 'DOWN', touch: false, strike: 2.1 });
  });

  it('touch verbs are flagged as touch, with k/M units', () => {
    expect(parseMarketQuestion('Will Bitcoin dip to $82,500 in September?'))
      .toEqual({ kind: 'threshold', wording: 'DOWN', touch: true, strike: 82_500 });
    expect(parseMarketQuestion('Will bitcoin rise to 105k before the Strategic Bitcoin Reserve is funded?'))
      .toEqual({ kind: 'threshold', wording: 'UP', touch: true, strike: 105_000 });
    expect(parseMarketQuestion('Bitcoin price reaches 75k USD at any point before 2027?'))
      .toEqual({ kind: 'threshold', wording: 'UP', touch: true, strike: 75_000 });
    expect(parseMarketQuestion('Will Bitcoin hit $1.5M by 2035?'))
      .toEqual({ kind: 'threshold', wording: 'UP', touch: true, strike: 1_500_000 });
  });

  it('up/down binaries are their own kind', () => {
    expect(parseMarketQuestion('Bitcoin Up or Down on September 30?')).toEqual({ kind: 'updown' });
  });

  it('ranges, events, percents, counts, and self-contradicting questions → null', () => {
    for (const q of [
      'Will the price of Bitcoin be between $82,000 and $84,000 on September 30?',
      'Rippling wins its lawsuit against Deel',
      'Will there be a "DOGE Dividend," even if it is not called that?',
      'Will ETH staking yields remain above 4% APY? (ETH: $2,600, 24h: +1.00%)',
      'Will Bitcoin maintain bearish momentum this week? (24h: -1.20%, Price: $84,000)',
      '⚡ 5-Min BTC Signal: UP (11:30AM-11:35AM ET)',
      'Will XRP be in the top 10 by market cap?',
      'Will DOGE see over 1 billion transactions this year?',
      'Will Bitcoin hit $100k or dip to $70k first?',
    ]) {
      expect(parseMarketQuestion(q)).toBeNull();
    }
  });
});

describe('marketImpliedDirection — live-feed cases that voted wrong on 2026-09-30', () => {
  it('"above $86,000" at 8% (BTC $84k) was DOWN@95 → now no forecast', () => {
    expect(marketImpliedDirection('Will the price of Bitcoin be above $86,000 on September 30?', 0.08, BTC)).toBeNull();
  });
  it('"dip to $82,500" at 10% was DOWN@95 (inverted) → now no forecast', () => {
    expect(marketImpliedDirection('Will Bitcoin dip to $82,500 in September?', 0.1, BTC)).toBeNull();
  });
  it('"rise to 105k" at 21% was DOWN → now no forecast', () => {
    expect(marketImpliedDirection('Will bitcoin rise to 105k before the Strategic Bitcoin Reserve is funded?', 0.21, BTC)).toBeNull();
  });
});

describe('marketImpliedDirection — markets that do forecast a move', () => {
  it('terminal ladder: needs a cross from spot', () => {
    expect(marketImpliedDirection('Will the price of Bitcoin be above $86,000 on September 30?', 0.7, BTC)).toBe('UP');
    expect(marketImpliedDirection('Will the price of Bitcoin be above $82,000 on September 30?', 0.2, BTC)).toBe('DOWN');
    expect(marketImpliedDirection('Will the price of Bitcoin be above $82,000 on September 30?', 0.9, BTC)).toBeNull();
  });
  it('touch markets point toward the strike, whatever the verb', () => {
    expect(marketImpliedDirection('Will Bitcoin dip to $82,500 in September?', 0.75, BTC)).toBe('DOWN');
    expect(marketImpliedDirection('Will Bitcoin reach $85,000 on September 29?', 0.7, BTC)).toBe('UP');
    // "reaches 75k" from 84k is a move DOWN: likely → DOWN, unlikely → nothing
    expect(marketImpliedDirection('Bitcoin price reaches 75k USD at any point before 2027?', 0.7, BTC)).toBe('DOWN');
    expect(marketImpliedDirection('Bitcoin price reaches 75k USD at any point before 2027?', 0.2, BTC)).toBeNull();
  });
  it('up/down binaries use the YES price directly with a small dead band', () => {
    expect(marketImpliedDirection('Bitcoin Up or Down on September 30?', 0.56, BTC)).toBe('UP');
    expect(marketImpliedDirection('Bitcoin Up or Down on September 30?', 0.44, BTC)).toBe('DOWN');
    expect(marketImpliedDirection('Bitcoin Up or Down on September 30?', 0.51, BTC)).toBeNull();
    expect(marketImpliedDirection('Bitcoin Up or Down on September 30?', 0.56, null)).toBe('UP');
  });
  it('mis-parsed or foregone strikes (outside spot/4 .. spot×4), and missing inputs → null', () => {
    expect(marketImpliedDirection('Will bitcoin go below $9,000 at the end of 2025?', 0.95, BTC)).toBeNull();
    expect(marketImpliedDirection('Will Bitcoin hit $1.5M by 2035?', 0.05, BTC)).toBeNull();
    expect(marketImpliedDirection('Will Bitcoin reach $85,000 on September 29?', null, BTC)).toBeNull();
    expect(marketImpliedDirection('Will Bitcoin reach $85,000 on September 29?', 0.7, undefined)).toBeNull();
  });
});
