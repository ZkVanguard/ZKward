/**
 * Ledger cells decide the hold horizon and admission: pick the horizon
 * with the best measured edge, skip measured assets with none, let cold
 * assets through on the default hold.
 */
import { describe, it, expect } from '@jest/globals';
import { assetHoldPlan, findCell, LEDGER_MIN_N, LEDGER_RECENT_MIN_N, type LedgerCell } from '@/lib/services/market-data/ledger-cells';
import { computeMaxHoldMinutes } from '@/lib/services/paper-trader/sizing';
import { PAPER_MAX_HOLD_CEILING_MIN } from '@/lib/services/paper-trader/config';

const cell = (asset: string, horizonMin: number, hitRate: number, n = 100, source = 'aggregate'): LedgerCell =>
  ({ source, asset, horizonMin, hitRate, n });

const CELLS: LedgerCell[] = [
  cell('BTC', 60, 0.51),
  cell('BTC', 240, 0.61),
  cell('BTC', 1440, 0.32),
  cell('ETH', 60, 0.48),
  cell('ETH', 240, 0.49),
  cell('DOGE', 240, 0.57, LEDGER_MIN_N - 1),
  cell('XRP', 60, 0.76, 59, 'on_chain:bybit-xrp-funding'),
];

describe('assetHoldPlan', () => {
  it('picks the horizon with the best edge among the candidates', () => {
    expect(assetHoldPlan(CELLS, 'BTC')).toEqual({ plan: { horizonMin: 240, hitRate: 0.61, n: 100 }, measured: true });
  });
  it('never picks a horizon outside the candidates (24h is inverted)', () => {
    expect(assetHoldPlan(CELLS, 'btc', [60])).toEqual({ plan: { horizonMin: 60, hitRate: 0.51, n: 100 }, measured: true });
  });
  it('measured asset with no edge → no plan (the entry gate skips it)', () => {
    expect(assetHoldPlan(CELLS, 'ETH')).toEqual({ plan: null, measured: true });
  });
  it('cold asset (below LEDGER_MIN_N or absent) → unmeasured, caller keeps its default hold', () => {
    expect(assetHoldPlan(CELLS, 'DOGE')).toEqual({ plan: null, measured: false });
    expect(assetHoldPlan(CELLS, 'SOL')).toEqual({ plan: null, measured: false });
  });
  it('only the aggregate row decides holds, not single sources', () => {
    expect(assetHoldPlan(CELLS, 'XRP')).toEqual({ plan: null, measured: false });
    expect(findCell(CELLS, 'on_chain:bybit-xrp-funding', 'xrp', 60)?.hitRate).toBe(0.76);
  });
});

describe('assetHoldPlan recency gate', () => {
  it('a horizon whose edge is gone in the recent window is passed over for the next one that still works', () => {
    const recent = [cell('BTC', 240, 0.42, 25), cell('BTC', 60, 0.55, 25)];
    expect(assetHoldPlan(CELLS, 'BTC', undefined, recent)).toEqual({ plan: { horizonMin: 60, hitRate: 0.51, n: 100 }, measured: true });
  });
  it('a thin recent cell (below LEDGER_RECENT_MIN_N) does not override the window decision', () => {
    const recent = [cell('BTC', 240, 0.3, LEDGER_RECENT_MIN_N - 1)];
    expect(assetHoldPlan(CELLS, 'BTC', undefined, recent).plan?.horizonMin).toBe(240);
  });
  it('every candidate failing recently → measured, no plan (the entry gate skips the asset)', () => {
    const recent = [cell('BTC', 240, 0.4, 30), cell('BTC', 60, 0.45, 30)];
    expect(assetHoldPlan(CELLS, 'BTC', undefined, recent)).toEqual({ plan: null, measured: true });
  });
  it('a recent cell above a coin flip keeps the window choice', () => {
    const recent = [cell('BTC', 240, 0.58, 40)];
    expect(assetHoldPlan(CELLS, 'BTC', undefined, recent).plan?.horizonMin).toBe(240);
  });
});

describe('computeMaxHoldMinutes with a ledger horizon', () => {
  it('the ledger horizon replaces the heuristic hold, capped by the ceiling', () => {
    expect(computeMaxHoldMinutes(0.4, 1, 240)).toBe(Math.min(240, PAPER_MAX_HOLD_CEILING_MIN));
    expect(computeMaxHoldMinutes(2.0, 3, 60)).toBe(60);
  });
  it('without a ledger horizon the heuristic hold still applies', () => {
    expect(computeMaxHoldMinutes(0.4, 1)).toBe(45);
    expect(computeMaxHoldMinutes(0.4, 1, null)).toBe(45);
  });
  it('the default ceiling is the 4-hour horizon the ledger measured', () => {
    expect(PAPER_MAX_HOLD_CEILING_MIN).toBe(240);
  });
});
