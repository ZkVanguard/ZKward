/**
 * Ledger admission: a horizon is traded only when, across enough
 * independent windows, the mean return in the signal's direction clears
 * friction with a standard error to spare. Hit rate alone admits noise.
 */
import { describe, it, expect } from '@jest/globals';
import {
  assetHoldPlan,
  findCell,
  netEdgeBp,
  LEDGER_FRICTION_BP,
  LEDGER_MIN_WINDOWS,
  LEDGER_RECENT_MIN_WINDOWS,
  type LedgerCell,
} from '@/lib/services/market-data/ledger-cells';

const cell = (
  asset: string,
  horizonMin: number,
  meanBp: number,
  over: Partial<LedgerCell> = {},
): LedgerCell => ({ source: 'aggregate', asset, horizonMin, n: 200, hitRate: 0.55, windows: 40, meanBp, seBp: 4, ...over });

describe('netEdgeBp', () => {
  it('is the mean less one standard error less friction', () => {
    expect(netEdgeBp(cell('BTC', 60, 40))).toBeCloseTo(40 - 4 - LEDGER_FRICTION_BP, 6);
  });
  it('a cell without return evidence has no edge', () => {
    expect(netEdgeBp({ source: 'aggregate', asset: 'BTC', horizonMin: 60, n: 500, hitRate: 0.9 })).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('assetHoldPlan', () => {
  it('the case that prompted the rule: 55% over 202 rows was 9 windows at -4 bp, so nothing is admitted', () => {
    const cells = [
      cell('BTC', 240, -4.1, { n: 202, hitRate: 0.55, windows: 9, seBp: 8.3 }),
      cell('BTC', 60, 0.6, { n: 198, hitRate: 0.475, windows: 40, seBp: 3.8 }),
    ];
    expect(assetHoldPlan(cells, 'BTC')).toEqual({ plan: null, measured: true });
  });

  it('a hit rate above a coin flip does not admit a horizon whose mean is below friction', () => {
    expect(assetHoldPlan([cell('ETH', 60, 12, { hitRate: 0.62 })], 'ETH')).toEqual({ plan: null, measured: true });
  });

  it('admits the horizon whose expectancy clears friction, and reports the evidence', () => {
    const { plan, measured } = assetHoldPlan([cell('BTC', 60, 30), cell('BTC', 240, 60)], 'btc');
    expect(measured).toBe(true);
    expect(plan).toEqual({ horizonMin: 240, hitRate: 0.55, n: 200, windows: 40, meanBp: 60 });
  });

  it('prefers a smaller mean with a tight error over a larger mean that is mostly noise', () => {
    const cells = [cell('SOL', 60, 40, { seBp: 3 }), cell('SOL', 240, 70, { seBp: 45 })];
    expect(assetHoldPlan(cells, 'SOL').plan?.horizonMin).toBe(60);
  });

  it('respects the candidate horizons', () => {
    const cells = [cell('BTC', 60, 30), cell('BTC', 240, 60)];
    expect(assetHoldPlan(cells, 'BTC', [60]).plan?.horizonMin).toBe(60);
  });

  it('too few independent windows at every candidate horizon means unmeasured: the caller keeps its default', () => {
    const cells = [cell('DOGE', 240, 90, { n: 500, windows: LEDGER_MIN_WINDOWS - 1 })];
    expect(assetHoldPlan(cells, 'DOGE')).toEqual({ plan: null, measured: false });
    expect(assetHoldPlan(cells, 'XRP')).toEqual({ plan: null, measured: false });
  });

  it('one measured horizon without an edge outweighs an unmeasured one that looks good', () => {
    const cells = [cell('ETH', 60, 2), cell('ETH', 240, 90, { windows: 5 })];
    expect(assetHoldPlan(cells, 'ETH')).toEqual({ plan: null, measured: true });
  });

  it('only the aggregate signal decides admission; other sources are reachable by findCell', () => {
    const cells = [cell('XRP', 60, 80, { source: 'on_chain:funding' })];
    expect(assetHoldPlan(cells, 'XRP')).toEqual({ plan: null, measured: false });
    expect(findCell(cells, 'on_chain:funding', 'xrp', 60)?.meanBp).toBe(80);
  });
});

describe('assetHoldPlan recency gate', () => {
  const cells = [cell('BTC', 60, 30), cell('BTC', 240, 60)];

  it('a recent cell whose mean has gone to zero or below drops that horizon', () => {
    const recent = [cell('BTC', 240, -5, { windows: LEDGER_RECENT_MIN_WINDOWS })];
    expect(assetHoldPlan(cells, 'BTC', undefined, recent).plan?.horizonMin).toBe(60);
  });

  it('a thin recent cell does not override the window decision', () => {
    const recent = [cell('BTC', 240, -50, { windows: LEDGER_RECENT_MIN_WINDOWS - 1 })];
    expect(assetHoldPlan(cells, 'BTC', undefined, recent).plan?.horizonMin).toBe(240);
  });

  it('every horizon vetoed means measured with no plan', () => {
    const recent = [cell('BTC', 240, -5, { windows: 12 }), cell('BTC', 60, 0, { windows: 30 })];
    expect(assetHoldPlan(cells, 'BTC', undefined, recent)).toEqual({ plan: null, measured: true });
  });

  it('a recent cell still positive keeps the horizon', () => {
    const recent = [cell('BTC', 240, 8, { windows: 12 })];
    expect(assetHoldPlan(cells, 'BTC', undefined, recent).plan?.horizonMin).toBe(240);
  });
});
