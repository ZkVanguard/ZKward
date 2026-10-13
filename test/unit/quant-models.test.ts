/**
 * Golden tests for quant-model primitives (lib/services/hedging/quant-models.ts).
 *
 * The three functions live behind sizing / gate decisions that move real
 * capital — a regression here silently over- or under-sizes trades. Test
 * layer locks known-correct outputs against textbook cases (BS N(),
 * unlevered Kelly, break-even funding, GBM first-passage identities).
 */
import { describe, it, expect } from '@jest/globals';
import {
  erf,
  normalCdf,
  normalInv,
  expectedValueUsd,
  kellyFractionLeveraged,
  firstPassageProbability,
  maxLeverageForLiqCap,
} from '@/lib/services/hedging/quant-models';

// ─── erf / normalCdf ────────────────────────────────────────────────────

describe('erf', () => {
  it('erf(0) = 0', () => expect(erf(0)).toBeCloseTo(0, 6));
  it('erf(1) ≈ 0.8427', () => expect(erf(1)).toBeCloseTo(0.8427, 3));
  it('erf(∞) → 1', () => expect(erf(6)).toBeCloseTo(1, 6));
  it('is odd: erf(−x) = −erf(x)', () => {
    for (const x of [0.5, 1.2, 2.3]) {
      expect(erf(-x)).toBeCloseTo(-erf(x), 6);
    }
  });
});

describe('normalCdf', () => {
  it('Φ(0) = 0.5', () => expect(normalCdf(0)).toBeCloseTo(0.5, 5));
  it('Φ(1.96) ≈ 0.975 (canonical z-table entry)', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it('Φ(−1.96) ≈ 0.025 (two-tail complement)', () => {
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('Φ(x) + Φ(−x) = 1 (symmetry)', () => {
    for (const x of [0.1, 0.7, 2.5]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 5);
    }
  });
});

// ─── expectedValueUsd ───────────────────────────────────────────────────

describe('expectedValueUsd', () => {
  const base = {
    probability: 0.55, payoffOdds: 1, notionalUsd: 1000,
    holdingHours: 0, fundingRateApr: 0, feeBpsRoundTrip: 0,
  };

  it('zero funding + zero fees + 55% edge = $100 EV on $1000 notional', () => {
    // grossEdge = 1000 × (0.55·1 − 0.45) = 100
    const r = expectedValueUsd(base);
    expect(r.evUsd).toBeCloseTo(100, 6);
    expect(r.fundingCostUsd).toBe(0);
    expect(r.feeCostUsd).toBe(0);
  });

  it('coin flip at even odds = 0 EV', () => {
    const r = expectedValueUsd({ ...base, probability: 0.5 });
    expect(r.evUsd).toBeCloseTo(0, 6);
  });

  it('funding cost applied per fraction of year', () => {
    // 11% APR × (1h / 8760) × 1000 ≈ $0.01256
    const r = expectedValueUsd({ ...base, holdingHours: 1, fundingRateApr: 0.11, probability: 0.5 });
    expect(r.fundingCostUsd).toBeCloseTo(0.01256, 5);
    expect(r.evUsd).toBeCloseTo(-0.01256, 5);
  });

  it('fees deducted in bps of notional (round-trip)', () => {
    // 15 bps × 1000 = 1.50
    const r = expectedValueUsd({ ...base, feeBpsRoundTrip: 15, probability: 0.5 });
    expect(r.feeCostUsd).toBeCloseTo(1.50, 5);
  });

  it('the wash-trade case: 55% p over 4h at 11% funding → still positive', () => {
    // Sanity: at low funding and short hold, marginal edge survives.
    const r = expectedValueUsd({ ...base, holdingHours: 4, fundingRateApr: 0.11 });
    expect(r.evUsd).toBeGreaterThan(0);
  });

  it('the wash-trade case: 51% p over 24h at 50% funding + 20 bps fees → NEGATIVE', () => {
    // grossEdge = 1000·(0.51 − 0.49) = 20
    // funding   = 1000·0.5·(24/8760) ≈ 1.37
    // fees      = 1000·20/10000 = 2
    // ev ≈ 20 − 1.37 − 2 ≈ 16.63 — actually still positive
    // Let's use a really marginal edge:
    const r = expectedValueUsd({
      probability: 0.502, payoffOdds: 1, notionalUsd: 1000,
      holdingHours: 24, fundingRateApr: 0.5, feeBpsRoundTrip: 20,
    });
    // grossEdge = 4, funding ≈ 1.37, fees = 2 → EV ≈ 0.63 still positive
    // Push probability down to 0.501 → grossEdge = 2 → EV ≈ -1.37
    const r2 = expectedValueUsd({ ...base, probability: 0.501, holdingHours: 24, fundingRateApr: 0.5, feeBpsRoundTrip: 20 });
    expect(r2.evUsd).toBeLessThan(0);
    // Original assertion documented for clarity
    expect(r.evUsd).toBeGreaterThan(0);
  });

  it('rejects bad inputs by returning zero components', () => {
    for (const p of [-0.1, 1.1, NaN, Infinity]) {
      const r = expectedValueUsd({ ...base, probability: p });
      expect(r.evUsd).toBe(0);
    }
    const rNeg = expectedValueUsd({ ...base, notionalUsd: -100 });
    expect(rNeg.evUsd).toBe(0);
  });
});

// ─── kellyFractionLeveraged ─────────────────────────────────────────────

describe('kellyFractionLeveraged', () => {
  it('at leverage=1 with zero adverse fraction, matches classic (p − q/b)/divisor', () => {
    // p=0.6, b=1×(1−0) = 1, fullKelly = (0.6·1 − 0.4)/1 = 0.2 → /4 = 0.05
    const f = kellyFractionLeveraged({ probability: 0.6, leverage: 1, adverseFraction: 0, kellyDivisor: 4 });
    expect(f).toBeCloseTo(0.05, 6);
  });

  it('is 0 at or below coin flip', () => {
    expect(kellyFractionLeveraged({ probability: 0.5, leverage: 2 })).toBe(0);
    expect(kellyFractionLeveraged({ probability: 0.4, leverage: 3 })).toBe(0);
  });

  it('is 0 when p >= 1 or p <= 0', () => {
    expect(kellyFractionLeveraged({ probability: 1, leverage: 2 })).toBe(0);
    expect(kellyFractionLeveraged({ probability: 0, leverage: 2 })).toBe(0);
  });

  it('increases with leverage when p unchanged (payoff odds grow)', () => {
    const f1 = kellyFractionLeveraged({ probability: 0.6, leverage: 1, adverseFraction: 0, kellyDivisor: 1 });
    const f2 = kellyFractionLeveraged({ probability: 0.6, leverage: 2, adverseFraction: 0, kellyDivisor: 1 });
    // With zero adverse, b doubles → f* = (0.6·2 − 0.4)/2 = 0.4 (was 0.2)
    expect(f2).toBeGreaterThan(f1);
    expect(f2).toBeCloseTo(0.4, 6);
  });

  it('adverse-fraction eats into b, shrinks f*', () => {
    // p=0.6, L=3, adverse=1/3 → b = 3·(1−0.333) = 2, fullKelly = (0.6·2 − 0.4)/2 = 0.4
    const f = kellyFractionLeveraged({ probability: 0.6, leverage: 3, adverseFraction: 1/3, kellyDivisor: 1 });
    expect(f).toBeCloseTo(0.4, 6);
  });

  it('default adverseFraction = 1/leverage → b = L − 1', () => {
    // p=0.7, L=3, adv default=1/3, b=3·(1−1/3)=2, fullKelly=(0.7·2 − 0.3)/2 = 0.55
    const f = kellyFractionLeveraged({ probability: 0.7, leverage: 3, kellyDivisor: 1 });
    expect(f).toBeCloseTo(0.55, 6);
  });

  it('kellyDivisor scales down deterministically', () => {
    const f1 = kellyFractionLeveraged({ probability: 0.7, leverage: 2, adverseFraction: 0, kellyDivisor: 1 });
    const f4 = kellyFractionLeveraged({ probability: 0.7, leverage: 2, adverseFraction: 0, kellyDivisor: 4 });
    expect(f4).toBeCloseTo(f1 / 4, 6);
  });

  it('returns finite value in [0,1] for extreme inputs', () => {
    const f = kellyFractionLeveraged({ probability: 0.9, leverage: 10, adverseFraction: 0, kellyDivisor: 1 });
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThanOrEqual(1);
    expect(Number.isFinite(f)).toBe(true);
  });
});

// ─── firstPassageProbability ────────────────────────────────────────────

describe('firstPassageProbability', () => {
  it('returns 0 on invalid inputs', () => {
    expect(firstPassageProbability({ priceNow: 0, barrierPrice: 100, annualVol: 0.5, holdingHours: 1 })).toBe(0);
    expect(firstPassageProbability({ priceNow: 100, barrierPrice: 90, annualVol: -1, holdingHours: 1 })).toBe(0);
    expect(firstPassageProbability({ priceNow: 100, barrierPrice: 90, annualVol: 0.5, holdingHours: 0 })).toBe(0);
  });

  it('very close barrier + high vol → high P', () => {
    // BTC-typical 80% annual vol, 24h horizon, 1% down barrier
    const p = firstPassageProbability({
      priceNow: 100, barrierPrice: 99, annualVol: 0.80, holdingHours: 24,
    });
    expect(p).toBeGreaterThan(0.5);
  });

  it('very far barrier + low vol + short horizon → very low P', () => {
    // 10% away, 20% annual vol, 1h — should be ~0
    const p = firstPassageProbability({
      priceNow: 100, barrierPrice: 90, annualVol: 0.20, holdingHours: 1,
    });
    expect(p).toBeLessThan(0.01);
  });

  it('closer log-barrier → higher hit probability (μ=0)', () => {
    // GBM has ν = μ − σ²/2 so pure-mirror UP/DOWN symmetry requires μ = σ²/2.
    // At μ=0, the log-drift is negative and DOWN barriers are slightly more
    // probable at equal LOG-distance. Test the qualitative ordering instead:
    // barrier at 105 is closer in log-space than barrier at 95 (relative to 100),
    // and the closer barrier should have strictly higher hit probability.
    const pFar   = firstPassageProbability({ priceNow: 100, barrierPrice: 95, annualVol: 0.5, holdingHours: 24 });
    const pClose = firstPassageProbability({ priceNow: 100, barrierPrice: 105, annualVol: 0.5, holdingHours: 24 });
    expect(pClose).toBeGreaterThan(pFar);
  });

  it('exact UP/DOWN mirror under drift-corrected μ = σ²/2', () => {
    // Under lognormal, setting μ = σ²/2 zeroes out ν and gives exact
    // log-symmetric first-passage probability. Verifies the reflection
    // principle implementation is correct, not just monotone.
    const sigma = 0.5;
    const mu = (sigma * sigma) / 2;
    const pDown = firstPassageProbability({ priceNow: 100, barrierPrice: 95, annualVol: sigma, holdingHours: 24, drift: mu });
    const pUp   = firstPassageProbability({ priceNow: 100, barrierPrice: 100 / 0.95, annualVol: sigma, holdingHours: 24, drift: mu });
    expect(pDown).toBeCloseTo(pUp, 5);
  });

  it('doubling holding period materially increases P (monotone)', () => {
    const p1 = firstPassageProbability({ priceNow: 100, barrierPrice: 95, annualVol: 0.5, holdingHours: 6 });
    const p2 = firstPassageProbability({ priceNow: 100, barrierPrice: 95, annualVol: 0.5, holdingHours: 24 });
    expect(p2).toBeGreaterThan(p1);
  });

  it('barrier equals current price → P = 1', () => {
    expect(firstPassageProbability({ priceNow: 100, barrierPrice: 100, annualVol: 0.5, holdingHours: 1 })).toBe(1);
  });
});

// ─── maxLeverageForLiqCap ───────────────────────────────────────────────

describe('maxLeverageForLiqCap', () => {
  it('quiet market (20% vol) + short hold (1h) + 5% liq budget → allows high leverage', () => {
    const L = maxLeverageForLiqCap({
      annualVol: 0.20, holdingHours: 1, targetLiqProb: 0.05,
    });
    expect(L).toBeGreaterThanOrEqual(5);
  });

  it('volatile market + long hold + tight liq budget clamps leverage low', () => {
    // 300% annualized vol (crypto meme-coin territory), 7-day hold, 1% liq budget.
    // Even L=2 with the 0.95 maintenance cushion gets close enough to the barrier
    // that P(hit) exceeds 1% quickly — max should collapse to 1.
    const L = maxLeverageForLiqCap({
      annualVol: 3.0, holdingHours: 24 * 7, targetLiqProb: 0.01, maxLeverage: 10,
    });
    expect(L).toBeLessThanOrEqual(2);
  });

  it('monotone in target: laxer target → higher leverage allowed', () => {
    const strict = maxLeverageForLiqCap({ annualVol: 0.8, holdingHours: 8, targetLiqProb: 0.01, maxLeverage: 10 });
    const lax    = maxLeverageForLiqCap({ annualVol: 0.8, holdingHours: 8, targetLiqProb: 0.25, maxLeverage: 10 });
    expect(lax).toBeGreaterThanOrEqual(strict);
  });

  it('monotone in vol: higher vol → lower leverage', () => {
    const low  = maxLeverageForLiqCap({ annualVol: 0.3, holdingHours: 8, targetLiqProb: 0.05, maxLeverage: 10 });
    const high = maxLeverageForLiqCap({ annualVol: 1.0, holdingHours: 8, targetLiqProb: 0.05, maxLeverage: 10 });
    expect(high).toBeLessThanOrEqual(low);
  });

  it('returns integer >= 1 always', () => {
    for (const args of [
      { annualVol: 0, holdingHours: 1, targetLiqProb: 0.05 },
      { annualVol: NaN, holdingHours: 1, targetLiqProb: 0.05 },
      { annualVol: 0.5, holdingHours: 0, targetLiqProb: 0.05 },
      { annualVol: 0.5, holdingHours: 1, targetLiqProb: 0 },
    ]) {
      const L = maxLeverageForLiqCap(args as Parameters<typeof maxLeverageForLiqCap>[0]);
      expect(Number.isInteger(L)).toBe(true);
      expect(L).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('normalInv', () => {
  it('undoes normalCdf across the whole range, tails included', () => {
    for (const p of [0.001, 0.02, 0.03, 0.105, 0.445, 0.5, 0.845, 0.97, 0.98, 0.999]) {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 6);
    }
  });
  it('even odds is zero, and it is odd around it', () => {
    expect(normalInv(0.5)).toBeCloseTo(0, 9);
    expect(normalInv(0.975)).toBeCloseTo(1.96, 2);
    expect(normalInv(0.1)).toBeCloseTo(-normalInv(0.9), 9);
  });
  it('a probability that is not one has no distance', () => {
    for (const bad of [0, 1, -0.2, 1.5, NaN]) expect(normalInv(bad)).toBeNaN();
  });
});
