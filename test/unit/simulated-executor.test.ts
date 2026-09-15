/**
 * Unit tests for SimulatedTradeExecutor pure helpers.
 *
 * Locks the fee + funding + PnL math against handcrafted scenarios so
 * dashboard NAV numbers can't silently drift when the fee model is tuned.
 */
import { describe, it, expect } from '@jest/globals';
import {
  FEE_BPS_PER_SIDE,
  FUNDING_APR,
  computeFeeUsd,
  computeFundingUsd,
  computeGrossPnl,
  simulateOpen,
  simulateClose,
  markToMarket,
} from '@/lib/services/paper-trader/simulated-executor';

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('computeFeeUsd', () => {
  it('applies 6.5 bp on $1000 notional = $0.65', () => {
    expect(computeFeeUsd(1000)).toBeCloseTo(0.65, 6);
  });
  it('scales linearly with notional', () => {
    expect(computeFeeUsd(10_000)).toBeCloseTo(6.5, 6);
    expect(computeFeeUsd(100_000)).toBeCloseTo(65, 6);
  });
  it('accepts custom bps', () => {
    expect(computeFeeUsd(1000, 20)).toBeCloseTo(2.0, 6);
  });
  it('FEE_BPS_PER_SIDE constant is 6.5 → 13 bp round-trip', () => {
    expect(FEE_BPS_PER_SIDE).toBe(6.5);
  });
});

describe('computeFundingUsd', () => {
  it('LONG pays funding (negative sign) — 11% APR × $100k for 1 day', () => {
    const funding = computeFundingUsd(100_000, 'LONG', DAY_MS);
    // 100_000 × 0.11 × (86400 / 31_536_000) ≈ -30.14
    expect(funding).toBeCloseTo(-30.1369, 3);
    expect(funding).toBeLessThan(0);
  });
  it('SHORT collects funding (positive sign) — symmetric magnitude', () => {
    const longPays = computeFundingUsd(100_000, 'LONG', DAY_MS);
    const shortReceives = computeFundingUsd(100_000, 'SHORT', DAY_MS);
    expect(shortReceives).toBeCloseTo(-longPays, 6);
    expect(shortReceives).toBeGreaterThan(0);
  });
  it('scales linearly with hold duration', () => {
    const oneHr = computeFundingUsd(100_000, 'LONG', HOUR_MS);
    const twoHr = computeFundingUsd(100_000, 'LONG', 2 * HOUR_MS);
    expect(twoHr).toBeCloseTo(2 * oneHr, 6);
  });
  it('zero-hold funding is zero', () => {
    expect(computeFundingUsd(100_000, 'LONG', 0)).toBeCloseTo(0, 9);
  });
  it('negative-hold funding clamps to zero (defensive)', () => {
    expect(computeFundingUsd(100_000, 'LONG', -1000)).toBeCloseTo(0, 9);
  });
  it('FUNDING_APR constant is 0.11 (11% APR)', () => {
    expect(FUNDING_APR).toBe(0.11);
  });
});

describe('computeGrossPnl', () => {
  it('LONG profits on price up: $10k notional, +1% = +$100', () => {
    expect(computeGrossPnl('LONG', 100, 101, 10_000)).toBeCloseTo(100, 6);
  });
  it('LONG loses on price down: $10k notional, -1% = -$100', () => {
    expect(computeGrossPnl('LONG', 100, 99, 10_000)).toBeCloseTo(-100, 6);
  });
  it('SHORT profits on price down: $10k notional, -1% = +$100', () => {
    expect(computeGrossPnl('SHORT', 100, 99, 10_000)).toBeCloseTo(100, 6);
  });
  it('SHORT loses on price up: $10k notional, +1% = -$100', () => {
    expect(computeGrossPnl('SHORT', 100, 101, 10_000)).toBeCloseTo(-100, 6);
  });
  it('zero-move: gross PnL is zero', () => {
    expect(computeGrossPnl('LONG', 100, 100, 10_000)).toBeCloseTo(0, 6);
    expect(computeGrossPnl('SHORT', 100, 100, 10_000)).toBeCloseTo(0, 6);
  });
  it('invalid entry price → 0 (defensive)', () => {
    expect(computeGrossPnl('LONG', 0, 100, 10_000)).toBe(0);
  });
});

describe('simulateOpen', () => {
  it('computes size = notional / entry, records open fee', () => {
    const pos = simulateOpen(
      { asset: 'BTC', side: 'LONG', notionalUsd: 65_000, leverage: 3, entryPrice: 65_000 },
      NOW,
    );
    expect(pos.size).toBeCloseTo(1, 6);
    expect(pos.openFeeUsd).toBeCloseTo(65_000 * 0.00065, 6); // 42.25
    expect(pos.openedAt).toBe(NOW);
  });
  it('throws on invalid entry price', () => {
    expect(() =>
      simulateOpen(
        { asset: 'BTC', side: 'LONG', notionalUsd: 1000, leverage: 3, entryPrice: 0 },
        NOW,
      ),
    ).toThrow(/entryPrice/);
  });
  it('throws on invalid notional', () => {
    expect(() =>
      simulateOpen(
        { asset: 'BTC', side: 'LONG', notionalUsd: 0, leverage: 3, entryPrice: 65_000 },
        NOW,
      ),
    ).toThrow(/notionalUsd/);
  });
});

describe('simulateClose — realistic scenarios', () => {
  it('LONG BTC, +2% move over 1 hour, net PnL = gross − fees − funding', () => {
    const pos = simulateOpen(
      { asset: 'BTC', side: 'LONG', notionalUsd: 100_000, leverage: 1, entryPrice: 65_000 },
      NOW,
    );
    const result = simulateClose(pos, 66_300, NOW + HOUR_MS);
    // gross = 100k × 2% = +2000
    expect(result.grossPnlUsd).toBeCloseTo(2000, 3);
    // open + close fees = 2 × 65 = 130
    expect(result.openFeeUsd).toBeCloseTo(65, 3);
    expect(result.closeFeeUsd).toBeCloseTo(65, 3);
    // funding = -100k × 0.11 × (3600/31_536_000) ≈ -1.256
    expect(result.fundingUsd).toBeCloseTo(-1.2557, 3);
    // realized = 2000 - 65 - 65 - 1.256 ≈ 1868.74
    expect(result.realizedPnlUsd).toBeCloseTo(1868.7443, 3);
    expect(result.holdSeconds).toBe(3600);
  });

  it('SHORT ETH, price flat, held 12h — pure fee+funding drag with funding credit', () => {
    const pos = simulateOpen(
      { asset: 'ETH', side: 'SHORT', notionalUsd: 50_000, leverage: 2, entryPrice: 3000 },
      NOW,
    );
    const result = simulateClose(pos, 3000, NOW + 12 * HOUR_MS);
    expect(result.grossPnlUsd).toBeCloseTo(0, 6);
    // fees = 2 × 32.5 = 65
    expect(result.openFeeUsd + result.closeFeeUsd).toBeCloseTo(65, 3);
    // SHORT collects funding: 50k × 0.11 × (43200/31_536_000) ≈ +7.53
    expect(result.fundingUsd).toBeGreaterThan(0);
    expect(result.fundingUsd).toBeCloseTo(7.5342, 3);
    // net = 0 - 65 + 7.53 ≈ -57.47
    expect(result.realizedPnlUsd).toBeCloseTo(-57.4658, 3);
  });

  it('LONG with tiny move (< fee floor) → loss', () => {
    const pos = simulateOpen(
      { asset: 'SOL', side: 'LONG', notionalUsd: 20_000, leverage: 3, entryPrice: 150 },
      NOW,
    );
    // +0.05% move = $10 gross, fees $26, funding negligible over 5 min
    const result = simulateClose(pos, 150.075, NOW + 5 * 60 * 1000);
    expect(result.grossPnlUsd).toBeCloseTo(10, 3);
    expect(result.realizedPnlUsd).toBeLessThan(-15);
    expect(result.realizedPnlUsd).toBeGreaterThan(-17);
  });

  it('LONG catastrophic drawdown — 10% down', () => {
    const pos = simulateOpen(
      { asset: 'BTC', side: 'LONG', notionalUsd: 10_000, leverage: 5, entryPrice: 70_000 },
      NOW,
    );
    const result = simulateClose(pos, 63_000, NOW + 2 * HOUR_MS);
    expect(result.grossPnlUsd).toBeCloseTo(-1000, 3);
    expect(result.realizedPnlUsd).toBeLessThan(-1000);
  });
});

describe('markToMarket', () => {
  it('LONG in profit — unrealized reflects gross - open fee + funding accrued', () => {
    const pos = simulateOpen(
      { asset: 'BTC', side: 'LONG', notionalUsd: 10_000, leverage: 1, entryPrice: 65_000 },
      NOW,
    );
    const m = markToMarket(pos, 66_950, NOW + HOUR_MS); // +3%
    expect(m.unrealizedPnlUsd).toBeCloseTo(300 - 6.5 - 0.1256, 2);
    expect(m.fundingAccruedUsd).toBeCloseTo(-0.1256, 3);
  });
  it('close fee is NOT deducted in mark-to-market (only realized on close)', () => {
    const pos = simulateOpen(
      { asset: 'BTC', side: 'LONG', notionalUsd: 10_000, leverage: 1, entryPrice: 65_000 },
      NOW,
    );
    const m = markToMarket(pos, 65_000, NOW); // 0-hold, no move
    // Should reflect open fee only, not double
    expect(m.unrealizedPnlUsd).toBeCloseTo(-6.5, 3);
  });
});
