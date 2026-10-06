/**
 * Golden tests for the T1-A hedgeability clamp
 * (lib/services/sui/cron/hedgeable-allocation.ts).
 *
 * Locks the behavior that drops un-hedgeable assets and redistributes
 * their share to assets whose perp leg can clear BlueFin's minQty.
 * Regression risk: future refactors that "simplify" the redistribute
 * math could silently produce naked-long exposure at small NAV — the
 * exact bug class flagged as a production hazard (naked spot at small NAV).
 */
import { describe, it, expect } from '@jest/globals';
import {
  isHedgeable,
  clampAllocationsToHedgeable,
} from '@/lib/services/sui/cron/hedgeable-allocation';
import { hedgeSizeBase } from '@/lib/services/sui/cron/hedge-sizing';
import { readFileSync } from 'fs';
import { join } from 'path';

// BlueFin minQty / stepSize per BLUEFIN_PAIRS in BluefinService.ts.
const SPECS = {
  BTC: { minQuantity: 0.001, stepSize: 0.001 },
  ETH: { minQuantity: 0.01,  stepSize: 0.01  },
  SUI: { minQuantity: 1,     stepSize: 1     },
};

// Realistic prices (2026-05).
const PRICES = { BTC: 75_000, ETH: 2_000, SUI: 1 };

describe('perp size does not scale with leverage', () => {
  it('the size is the notional over price, whatever the leverage tier', () => {
    // $500 NAV, 40% SUI, ratio 1.0, SUI at $1: the hedge offsets $200 of spot, so 200 SUI.
    // Multiplying by a 5x tier made this 1,000 SUI: net short four times the allocation.
    const r = isHedgeable(500, 40, 1.0, 1, SPECS.SUI);
    expect(r.snappedSize).toBe(200);
    expect(r.notional).toBe(200);
    expect(hedgeSizeBase(500, 40, 1.0, 1)).toBe(200);
  });

  it('a bearish hedge at ratio 1.0 is delta-neutral against its spot leg', () => {
    for (const [nav, pct, price] of [[500, 40, 1], [10_000, 30, 2_000], [1_000_000, 45, 75_000]] as const) {
      const spotUsd = nav * (pct / 100);
      const shortUsd = hedgeSizeBase(nav, pct, 1.0, price) * price;
      expect(shortUsd).toBeCloseTo(spotUsd, 6);
    }
  });

  it('a missing price sizes nothing', () => {
    expect(hedgeSizeBase(500, 40, 1.0, 0)).toBe(0);
  });

  it('the auto-hedge step sizes through the same function', () => {
    const step8 = readFileSync(join(process.cwd(), 'lib/services/sui/cron/step-8-auto-hedge.ts'), 'utf8');
    expect(step8).toContain('hedgeSizeBase(navUsd, allocation, hedgeRatio, price)');
    expect(step8).not.toMatch(/hedgeValueUSD \* leverage/);
  });
});

describe('isHedgeable', () => {
  it('rejects when NAV × alloc% × ratio × leverage / price < minQty', () => {
    // $50 NAV, 45% BTC, ratio 1.0, leverage 5x → hedgeValue $22.50,
    // effective $112.50, size 0.0015 BTC. Steps to 0.001 → just clears
    // minQty 0.001. Edge of hedgeable.
    expect(isHedgeable(250, 45, 1.0, 75_000, SPECS.BTC).ok).toBe(true);

    // $20 NAV, 30% BTC, 5x → $6.00 × 5 = $30.00, size 0.0004 BTC.
    // Floors to 0.000. Below minQty 0.001 → not hedgeable.
    expect(isHedgeable(100, 30, 1.0, 75_000, SPECS.BTC).ok).toBe(false);

    // $50 NAV, 15% SUI, 5x at $1/SUI → $7.50 × 5 = $37.50, 37 SUI.
    // Clears SUI's minQty=1.
    expect(isHedgeable(250, 15, 1.0, 1, SPECS.SUI).ok).toBe(true);
  });

  it('rejects zero/negative inputs cleanly', () => {
    expect(isHedgeable(250, 0, 1.0, 75_000, SPECS.BTC).ok).toBe(false);
    expect(isHedgeable(250, 45, 1.0, 0, SPECS.BTC).ok).toBe(false);
    expect(isHedgeable(0, 45, 1.0, 75_000, SPECS.BTC).ok).toBe(false);
  });

  it('respects step-size flooring (BTC step 0.001)', () => {
    // sizeBase=0.0019, snapped to 0.001 — still hedgeable at exactly minQty.
    const r = isHedgeable(750, 30, 1.0, 75_000, SPECS.BTC);
    expect(r.ok).toBe(true);
    expect(r.snappedSize).toBeCloseTo(0.003, 6);
  });
});

describe('clampAllocationsToHedgeable — passthrough when everything fits', () => {
  it('returns originals when all assets hedgeable', () => {
    // $500 NAV, 5x lev — BTC 0.0033 SUI ~33 ETH 0.025 — all clear minQty.
    const out = clampAllocationsToHedgeable({
      navUsd: 2500,
      allocations: { BTC: 45, ETH: 40, SUI: 15 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
    });
    expect(out.dropped).toEqual([]);
    expect(out.redistributed).toBe(false);
    expect(out.allocations).toEqual({ BTC: 45, ETH: 40, SUI: 15 });
  });
});

describe('clampAllocationsToHedgeable — small-NAV drops + redistribution', () => {
  it('drops BTC at $50 NAV and redistributes to ETH + SUI', () => {
    // The canonical $50 case for the "BTC minQty problem"
    // example. With BTC 45% at $50 NAV and 5x leverage:
    //   $50 × 0.45 × 1.0 × 5 / $75k = 0.0015 BTC, floors to 0.001 — clears!
    // Actually let's use a NAV where BTC genuinely can't clear:
    //   $30 NAV × 0.45 × 5 / $75k = 0.0009 BTC, floors to 0.000 — drop.
    const out = clampAllocationsToHedgeable({
      navUsd: 150,
      allocations: { BTC: 45, ETH: 40, SUI: 15 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
    });
    expect(out.redistributed).toBe(true);
    expect(out.dropped.find(d => d.asset === 'BTC')).toBeDefined();
    expect(out.allocations.BTC).toBe(0);
    // ETH had 40 of (40+15)=55 survivor pct → ~72.73% rounded
    // SUI had 15 of 55 → ~27.27%. Total = 100.
    const total = Object.values(out.allocations).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(100, 1);
    expect(out.allocations.ETH).toBeGreaterThan(70);
    expect(out.allocations.SUI).toBeGreaterThan(20);
  });

  it('preserves total = 100 when last survivor absorbs rounding remainder', () => {
    // Three survivors with shares that don't add to 100 cleanly should
    // still produce a sum of exactly 100 (last gets the residue).
    const out = clampAllocationsToHedgeable({
      navUsd: 1000,
      allocations: { BTC: 33, ETH: 33, SUI: 34 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
    });
    const total = Object.values(out.allocations).reduce((s, v) => s + v, 0);
    expect(total).toBe(100);
  });
});

describe('clampAllocationsToHedgeable — no survivor edge case', () => {
  it('returns originals unchanged when NO asset is hedgeable', () => {
    // $1 NAV — nothing can hedge anything. Pool must fall back to all-USDC.
    const out = clampAllocationsToHedgeable({
      navUsd: 5,
      allocations: { BTC: 45, ETH: 40, SUI: 15 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
    });
    expect(out.redistributed).toBe(false);
    expect(out.dropped.length).toBe(3);
    expect(out.allocations).toEqual({ BTC: 45, ETH: 40, SUI: 15 });
  });
});

describe('clampAllocationsToHedgeable — missing price is unhedgeable', () => {
  it('drops asset with price=0 even if other params are fine', () => {
    // Price-feed glitch shouldn't authorise unhedged spot exposure.
    const out = clampAllocationsToHedgeable({
      navUsd: 5000,
      allocations: { BTC: 50, SUI: 50 },
      prices: { BTC: 0, SUI: 1 },
      hedgeRatio: 1.0,
      perpSpecs: { BTC: SPECS.BTC, SUI: SPECS.SUI },
    });
    expect(out.dropped.find(d => d.asset === 'BTC')?.reason).toMatch(/no price/);
    expect(out.allocations.BTC).toBe(0);
    expect(out.allocations.SUI).toBe(100);
  });
});

describe('clampAllocationsToHedgeable — OI guard (T3-B integration)', () => {
  it('drops asset whose hedge notional exceeds maxOiPct of venue OI', () => {
    // $5000 NAV, 40% ETH alloc, 3x lev → hedge notional = $6000.
    // BlueFin ETH OI ~$40k (real number observed 2026-06-01); 5% of that
    // = $2000. $6000 > $2000 → drop ETH, redistribute to BTC + SUI.
    const out = clampAllocationsToHedgeable({
      navUsd: 15000,
      allocations: { BTC: 40, ETH: 40, SUI: 20 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
      openInterestUsd: { BTC: 1_660_000, ETH: 40_000, SUI: 1_470_000 },
      maxOiPct: 5,
    });
    const ethDrop = out.dropped.find(d => d.asset === 'ETH');
    expect(ethDrop).toBeDefined();
    expect(ethDrop?.reason).toMatch(/% of venue OI/);
    expect(out.allocations.ETH).toBe(0);
    expect(out.redistributed).toBe(true);
  });

  it('passes through when all assets fit BOTH minQty and OI cap', () => {
    // Same NAV but smaller allocations that fit OI cap.
    const out = clampAllocationsToHedgeable({
      navUsd: 1500,
      allocations: { BTC: 50, ETH: 30, SUI: 20 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
      openInterestUsd: { BTC: 1_660_000, ETH: 40_000, SUI: 1_470_000 },
      maxOiPct: 5,
    });
    // $500 × 30% × 1.0 × 3 = $450 notional ETH, < $2k OI cap → ok
    expect(out.dropped).toEqual([]);
    expect(out.redistributed).toBe(false);
  });

  it('skips OI check when openInterestUsd is omitted', () => {
    // Same conditions as the first OI test but no OI data — should pass.
    const out = clampAllocationsToHedgeable({
      navUsd: 15000,
      allocations: { BTC: 40, ETH: 40, SUI: 20 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
      // openInterestUsd omitted
    });
    expect(out.dropped).toEqual([]);
    expect(out.redistributed).toBe(false);
  });

  it('uses default maxOiPct=5 when not supplied', () => {
    // ETH notional $6000 / $40k OI = 15% — exceeds default 5%.
    const out = clampAllocationsToHedgeable({
      navUsd: 15000,
      allocations: { BTC: 40, ETH: 40, SUI: 20 },
      prices: PRICES,
      hedgeRatio: 1.0,
      perpSpecs: SPECS,
      openInterestUsd: { BTC: 1_660_000, ETH: 40_000, SUI: 1_470_000 },
      // maxOiPct omitted — should default to 5
    });
    expect(out.dropped.find(d => d.asset === 'ETH')).toBeDefined();
  });
});

describe('clampAllocationsToHedgeable — unknown symbols pass through', () => {
  it('keeps allocation for asset without a spec (caller responsibility)', () => {
    const out = clampAllocationsToHedgeable({
      navUsd: 1000,
      allocations: { BTC: 50, CRO: 50 },
      prices: { BTC: 75_000, CRO: 0.1 },
      hedgeRatio: 1.0,
      perpSpecs: { BTC: SPECS.BTC }, // CRO spec missing
    });
    // No drop for CRO — it's the caller's responsibility (might be hedged
    // via a different venue or simulated). Don't second-guess.
    expect(out.dropped.find(d => d.asset === 'CRO')).toBeUndefined();
    expect(out.allocations.CRO).toBe(50);
  });
});
