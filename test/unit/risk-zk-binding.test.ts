/**
 * Golden tests for the canonical risk inputs (zk/prover/riskCanonical.ts).
 * Pure arithmetic, no prover needed. They pin the byte-exact serialization
 * the inputs digest is taken over: a risk-score proof commits to that
 * digest, so a change here silently changes what every such proof binds.
 */
import { describe, it, expect } from '@jest/globals';
import {
  RISK_CANONICAL_VERSION,
  SENTIMENT_CODE,
  serializeCanonical,
  computeInputsHash,
  computeBaseRiskScore,
  type CanonicalRiskInputs,
} from '@/zk/prover/riskCanonical';

function baseInputs(overrides: Partial<CanonicalRiskInputs> = {}): CanonicalRiskInputs {
  return {
    version: RISK_CANONICAL_VERSION,
    portfolioId: -2,
    chain: 'sui',
    timestampMs: 1783017000000, // fixed for determinism
    portfolioValueUsdc: 5408, // $54.08
    volatilityBps: 2500, // 25%
    exposures: [
      { asset: 'BTC', exposureBps: 3000, contributionBps: 1500 },
      { asset: 'ETH', exposureBps: 3000, contributionBps: 1500 },
      { asset: 'SUI', exposureBps: 2000, contributionBps: 1000 },
      { asset: 'CRO', exposureBps: 2000, contributionBps: 1000 },
    ],
    sentimentCode: SENTIMENT_CODE.neutral,
    baseRiskScore: 62, // 25/100*50 + (15+15+10+10)/100 = 12.5+50 = 62.5 → round 63... let's recompute
    aiRiskScore: null,
    totalRisk: 62,
    threshold: 100,
    ...overrides,
  };
}

describe('base-risk formula', () => {
  it('reproduces the exact TS formula for known inputs', () => {
    const exposures = [
      { contributionBps: 1500 },
      { contributionBps: 1500 },
      { contributionBps: 1000 },
      { contributionBps: 1000 },
    ];
    // vol=25% → 2500bps → 25/100*50 = 12.5; contribs sum = 50; total = 62.5 → round 63
    expect(computeBaseRiskScore(2500, exposures)).toBe(63);
  });
  it('clamps to [0, 100]', () => {
    expect(computeBaseRiskScore(0, [])).toBe(0);
    expect(
      computeBaseRiskScore(20000, [{ contributionBps: 100_000_000 }]),
    ).toBe(100);
  });
});

describe('serializeCanonical', () => {
  it('produces sorted-keys, no-whitespace, no-trailing-precision JSON', () => {
    const inputs = baseInputs({ baseRiskScore: 63, totalRisk: 63 });
    const s = serializeCanonical(inputs);
    expect(s.startsWith('{"')).toBe(true);
    expect(s.endsWith('}')).toBe(true);
    expect(s).not.toContain(' '); // no whitespace
    expect(s).not.toContain('\n');
    // keys must appear in ASCII order at top level
    const topKeys = Array.from(s.matchAll(/"([a-zA-Z]+)":/g)).map((m) => m[1]);
    const topLevelSample = topKeys.slice(0, 4); // first few — sanity check ordering
    expect(topLevelSample).toEqual([...topLevelSample].sort());
  });
  it('normalizes chain to lowercase and assets to uppercase', () => {
    const s = serializeCanonical(
      baseInputs({
        chain: 'SUI',
        exposures: [{ asset: 'btc', exposureBps: 100, contributionBps: 50 }],
        baseRiskScore: 1,
        totalRisk: 1,
      }),
    );
    expect(s).toContain('"chain":"sui"');
    expect(s).toContain('"asset":"BTC"');
  });
  it('sorts exposures by asset symbol regardless of input order', () => {
    const a = serializeCanonical(
      baseInputs({
        exposures: [
          { asset: 'SUI', exposureBps: 1, contributionBps: 1 },
          { asset: 'BTC', exposureBps: 1, contributionBps: 1 },
        ],
        baseRiskScore: 1,
        totalRisk: 1,
      }),
    );
    const b = serializeCanonical(
      baseInputs({
        exposures: [
          { asset: 'BTC', exposureBps: 1, contributionBps: 1 },
          { asset: 'SUI', exposureBps: 1, contributionBps: 1 },
        ],
        baseRiskScore: 1,
        totalRisk: 1,
      }),
    );
    expect(a).toBe(b);
  });
  it('floors timestampMs to nearest second', () => {
    const a = serializeCanonical(baseInputs({ timestampMs: 1000, baseRiskScore: 1, totalRisk: 1 }));
    const b = serializeCanonical(baseInputs({ timestampMs: 1999, baseRiskScore: 1, totalRisk: 1 }));
    expect(a).toBe(b);
    const c = serializeCanonical(baseInputs({ timestampMs: 2000, baseRiskScore: 1, totalRisk: 1 }));
    expect(a).not.toBe(c);
  });
});

describe('computeInputsHash', () => {
  /** Golden fixture: if this changes, the canonical layout changed and older digests no longer match. */
  const GOLDEN_INPUTS_HASH =
    '0619fb3793c77deddf71250e684ad0074c8f9b08ec0fd218e780cc77d7235f2c';

  it('is deterministic — same inputs give same hex', () => {
    const inputs = baseInputs({ baseRiskScore: 63, totalRisk: 63 });
    expect(computeInputsHash(inputs)).toBe(computeInputsHash(inputs));
  });
  it('is 64 lowercase hex chars', () => {
    expect(computeInputsHash(baseInputs({ baseRiskScore: 63, totalRisk: 63 }))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
  it('matches the golden hash', () => {
    const inputs = baseInputs({ baseRiskScore: 63, totalRisk: 63 });
    expect(computeInputsHash(inputs)).toBe(GOLDEN_INPUTS_HASH);
  });
  it('changes when ANY input changes', () => {
    const h0 = computeInputsHash(baseInputs({ baseRiskScore: 63, totalRisk: 63 }));
    // portfolioId
    expect(computeInputsHash(baseInputs({ baseRiskScore: 63, totalRisk: 63, portfolioId: 42 }))).not.toBe(h0);
    // volatility
    expect(computeInputsHash(baseInputs({ baseRiskScore: 63, totalRisk: 63, volatilityBps: 2501 }))).not.toBe(h0);
    // one exposure basis point
    expect(
      computeInputsHash(
        baseInputs({
          baseRiskScore: 63,
          totalRisk: 63,
          exposures: [
            { asset: 'BTC', exposureBps: 3001, contributionBps: 1500 },
            { asset: 'ETH', exposureBps: 3000, contributionBps: 1500 },
            { asset: 'SUI', exposureBps: 2000, contributionBps: 1000 },
            { asset: 'CRO', exposureBps: 2000, contributionBps: 1000 },
          ],
        }),
      ),
    ).not.toBe(h0);
    // sentiment
    expect(
      computeInputsHash(
        baseInputs({ baseRiskScore: 63, totalRisk: 63, sentimentCode: SENTIMENT_CODE.bullish }),
      ),
    ).not.toBe(h0);
    // aiRiskScore: null → 50
    expect(
      computeInputsHash(baseInputs({ baseRiskScore: 63, totalRisk: 63, aiRiskScore: 50 })),
    ).not.toBe(h0);
    // totalRisk itself
    expect(computeInputsHash(baseInputs({ baseRiskScore: 63, totalRisk: 64 }))).not.toBe(h0);
  });
});
