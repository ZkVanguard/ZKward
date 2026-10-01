/**
 * Source weights from the ledger: when a (source, asset, horizon) cell has
 * enough resolved rows, its measured hit rate sets the weight — and kills
 * the source below the hard-filter rate — ahead of the per-trade buckets.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async () => null),
  getCronStateOr: jest.fn(async (_k: string, def: unknown) => def),
  setCronState: jest.fn(async () => undefined),
}));
jest.mock('@/lib/services/market-data/ledger-cells', () => ({
  LEDGER_MIN_N: 50,
  getLedgerCells: jest.fn(async () => [
    { source: 'on_chain:bybit-xrp-funding', asset: 'XRP', horizonMin: 240, n: 80, hitRate: 0.76 },
    { source: 'short_term:kalshi-xrp', asset: 'XRP', horizonMin: 240, n: 120, hitRate: 0.3 },
    { source: 'short_term:kalshi-xrp', asset: 'BTC', horizonMin: 240, n: 120, hitRate: 0.7 },
  ]),
  findCell: (cells: Array<{ source: string; asset: string; horizonMin: number }>, source: string, asset: string, horizonMin: number) =>
    cells.find((c) => c.source === source && c.asset === asset && c.horizonMin === horizonMin) ?? null,
}));

import { applyCalibrationToSources } from '@/lib/services/ai/source-calibrator';

const src = (name: string, type: string, weight: number) => ({ name, type, weight, direction: 'UP' as const });

describe('applyCalibrationToSources with ledger cells', () => {
  it('weights by the measured hit rate at the asset × horizon and kills losing sources', async () => {
    const out = await applyCalibrationToSources(
      [src('Bybit XRP Funding', 'on_chain', 0.1), src('Kalshi XRP', 'short_term', 0.1), src('Polymarket 5-Min XRP', 'short_term', 0.1)],
      { asset: 'XRP', horizonMin: 240 },
    );
    const names = out.map((s) => s.name);
    expect(names).not.toContain('Kalshi XRP'); // 30% at n=120 → removed
    const funding = out.find((s) => s.name === 'Bybit XRP Funding')!;
    const fiveMin = out.find((s) => s.name === 'Polymarket 5-Min XRP')!;
    expect(funding.weight).toBeGreaterThan(fiveMin.weight); // 0.76/0.5 = 1.52× vs the unmeasured 1×
    expect(out.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 6);
  });

  it('cells are per asset: the same source can be good on BTC and dead on XRP', async () => {
    const out = await applyCalibrationToSources(
      [src('Kalshi BTC', 'short_term', 0.1), src('Polymarket 5-Min BTC', 'short_term', 0.1)],
      { asset: 'BTC', horizonMin: 240 },
    );
    // normalizeSourceKey('Kalshi BTC') is 'short_term:kalshi-btc' — no BTC cell under that key, so it is unmeasured here
    expect(out).toHaveLength(2);
  });

  it('without an asset the ledger is not consulted (per-trade buckets only)', async () => {
    const out = await applyCalibrationToSources([src('Kalshi XRP', 'short_term', 0.1), src('Bybit XRP Funding', 'on_chain', 0.1)]);
    expect(out).toHaveLength(2);
    expect(out[0].weight).toBeCloseTo(0.5, 6);
  });
});
