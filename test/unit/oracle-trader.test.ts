/**
 * OracleTrader (portfolio -5) — native-horizon interpreter book.
 *
 * The candidate filter is the risk surface: it decides which oracle
 * calls become positions and when they close. Pin its rules:
 * directional-only, priceable assets, entry anchor required, horizon
 * window enforced, uncertainty tag from the threshold band.
 */
import { describe, it, expect } from '@jest/globals';
import { selectOracleCandidates, marketImpliedSide, type InterpRow } from '@/lib/services/paper-trader/OracleTrader';

const NOW = 1_790_600_000_000;
const H = 3_600_000;

function row(over: Partial<InterpRow>): InterpRow {
  return {
    slug: over.slug ?? 'btc-above-80k',
    asset: 'BTC',
    direction: 'UP',
    threshold: 84_000,
    entry_price_usd: 84_100,
    horizon_end: new Date(NOW + 6 * H).toISOString(),
    interpreted_at: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

describe('selectOracleCandidates', () => {
  it('accepts a directional, priceable, anchored, in-window row', () => {
    const out = selectOracleCandidates([row({})], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].side).toBe('LONG');
    expect(out[0].closeAtMs).toBe(NOW + 6 * H);
  });

  it('maps DOWN to SHORT', () => {
    expect(selectOracleCandidates([row({ direction: 'DOWN' })], NOW)[0].side).toBe('SHORT');
  });

  it('rejects NEUTRAL/BINARY directions', () => {
    expect(selectOracleCandidates([row({ direction: 'NEUTRAL' })], NOW)).toHaveLength(0);
    expect(selectOracleCandidates([row({ direction: 'BINARY_YES' })], NOW)).toHaveLength(0);
  });

  it('rejects stale rows — the entry anchor must be at-market', () => {
    const stale = row({ interpreted_at: new Date(NOW - 2 * H).toISOString() });
    expect(selectOracleCandidates([stale], NOW)).toHaveLength(0);
  });

  it('rejects unpriceable assets and missing entry anchors', () => {
    expect(selectOracleCandidates([row({ asset: 'PEPE' })], NOW)).toHaveLength(0);
    expect(selectOracleCandidates([row({ entry_price_usd: null })], NOW)).toHaveLength(0);
  });

  it('enforces the horizon window (30min .. 48h)', () => {
    expect(selectOracleCandidates([row({ horizon_end: new Date(NOW + 10 * 60_000).toISOString() })], NOW)).toHaveLength(0);
    expect(selectOracleCandidates([row({ horizon_end: new Date(NOW + 72 * H).toISOString() })], NOW)).toHaveLength(0);
    expect(selectOracleCandidates([row({ horizon_end: null })], NOW)).toHaveLength(0);
  });

  it('tags uncertainty by the threshold-vs-spot band (8%)', () => {
    // threshold 0.5% from spot → uncertain (real alpha zone)
    expect(selectOracleCandidates([row({ threshold: 84_000, entry_price_usd: 84_400 })], NOW)[0].uncertain).toBe(true);
    // threshold 20% away → foregone conclusion, still traded but tagged certain
    expect(selectOracleCandidates([row({ threshold: 100_000, entry_price_usd: 84_000 })], NOW)[0].uncertain).toBe(false);
    // no threshold → not uncertain
    expect(selectOracleCandidates([row({ threshold: null })], NOW)[0].uncertain).toBe(false);
  });

  it('caps opens per tick', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ slug: `s${i}` }));
    expect(selectOracleCandidates(rows, NOW, 3)).toHaveLength(3);
  });
});

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
  it('"dip to $81k" at 70% with BTC at $84k → SHORT; at 20% → no trade', () => {
    expect(marketImpliedSide('DOWN', 0.7, 84_000, 81_000)).toBe('SHORT');
    expect(marketImpliedSide('DOWN', 0.2, 84_000, 81_000)).toBeNull();
  });
  it('coin-flip odds, missing price or strike, or non-directional wording → no trade', () => {
    expect(marketImpliedSide('UP', 0.55, 84_000, 88_000)).toBeNull();
    expect(marketImpliedSide('UP', null, 84_000, 88_000)).toBeNull();
    expect(marketImpliedSide('UP', 0.7, 84_000, null)).toBeNull();
    expect(marketImpliedSide('BINARY_YES', 0.9, 84_000, 88_000)).toBeNull();
  });
});
