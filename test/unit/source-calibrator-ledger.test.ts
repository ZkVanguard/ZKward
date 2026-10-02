/**
 * Source weights from the ledger: a (source, asset, horizon) cell rates the
 * source's TIMING over independent windows. Wrong-way sources are removed,
 * proven ones lifted, everything else keeps its base weight — whatever the
 * hit rate says.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async () => null),
  getCronStateOr: jest.fn(async (_k: string, def: unknown) => def),
  setCronState: jest.fn(async () => undefined),
}));
jest.mock('@/lib/services/market-data/ledger-cells', () => {
  const actual = jest.requireActual('@/lib/services/market-data/ledger-cells') as Record<string, unknown>;
  const cell = (source: string, asset: string, hitRate: number, timingBp: number, timingSeBp: number, windows = 40) =>
    ({ source, asset, horizonMin: 60, n: 150, hitRate, windows, timingBp, timingSeBp });
  return {
    ...actual,
    getLedgerCells: jest.fn(async () => [
      // 58% "right" by drift alone: said DOWN all week in a falling week. Timing is nil.
      cell('on_chain:bybit-xrp-funding', 'XRP', 0.58, 0.2, 4),
      // 55% hit rate, but wrong-way on timing.
      cell('short_term:kalshi-xrp', 'XRP', 0.55, -9, 4),
      // 49% hit rate, yet it gains against drift.
      cell('short_term:orderbook-xrp-depth-imbalance', 'XRP', 0.49, 12, 5),
      // Wrong-way mean, but only a handful of windows: says nothing yet.
      cell('medium_term:options-skew-xrp-risk-reversal', 'XRP', 0.3, -30, 5, 6),
    ]),
  };
});

import { applyCalibrationToSources } from '@/lib/services/ai/source-calibrator';

const src = (name: string, type: string, weight = 0.1) => ({ name, type, weight, direction: 'UP' as const });
const XRP_SOURCES = () => [
  src('Bybit XRP Funding', 'on_chain'),
  src('Kalshi XRP', 'short_term'),
  src('Orderbook XRP depth-imbalance', 'short_term'),
  src('Options-skew XRP risk-reversal', 'medium_term'),
  src('Polymarket 5-Min XRP', 'short_term'),
];

describe('applyCalibrationToSources with ledger cells', () => {
  it('removes a wrong-way source even though its hit rate is above a coin flip', async () => {
    const out = await applyCalibrationToSources(XRP_SOURCES(), { asset: 'XRP', horizonMin: 60 });
    expect(out.map((s) => s.name)).not.toContain('Kalshi XRP');
  });

  it('lifts a source with proven timing even though its hit rate is below a coin flip', async () => {
    const out = await applyCalibrationToSources(XRP_SOURCES(), { asset: 'XRP', horizonMin: 60 });
    const book = out.find((s) => s.name === 'Orderbook XRP depth-imbalance')!;
    const unmeasured = out.find((s) => s.name === 'Polymarket 5-Min XRP')!;
    expect(book.weight / unmeasured.weight).toBeCloseTo(1.5, 6);
    expect(out.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 6);
  });

  it('gives a drift-only hit rate no boost: a one-sided source keeps its base weight', async () => {
    const out = await applyCalibrationToSources(XRP_SOURCES(), { asset: 'XRP', horizonMin: 60 });
    const funding = out.find((s) => s.name === 'Bybit XRP Funding')!;
    const unmeasured = out.find((s) => s.name === 'Polymarket 5-Min XRP')!;
    expect(funding.weight).toBeCloseTo(unmeasured.weight, 6);
  });

  it('does not remove a source on too few independent windows', async () => {
    const out = await applyCalibrationToSources(XRP_SOURCES(), { asset: 'XRP', horizonMin: 60 });
    expect(out.map((s) => s.name)).toContain('Options-skew XRP risk-reversal');
  });

  it('cells are per asset: nothing measured for BTC leaves BTC sources alone', async () => {
    const out = await applyCalibrationToSources([src('Kalshi BTC', 'short_term'), src('Polymarket 5-Min BTC', 'short_term')], { asset: 'BTC', horizonMin: 60 });
    expect(out).toHaveLength(2);
  });

  it('without an asset the ledger is not consulted (per-trade buckets only)', async () => {
    const out = await applyCalibrationToSources([src('Kalshi XRP', 'short_term'), src('Bybit XRP Funding', 'on_chain')]);
    expect(out).toHaveLength(2);
    expect(out[0].weight).toBeCloseTo(0.5, 6);
  });
});
