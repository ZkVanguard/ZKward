/**
 * Ledger cells act on timing measured over independent windows, never on the
 * hit rate: a verdict needs enough windows and a margin of standard errors,
 * an asset is skipped only when its aggregate is measured wrong-way at every
 * hold horizon, and unproven or cold cells block nothing.
 */
import { describe, it, expect } from '@jest/globals';
import {
  assetHoldPlan,
  findCell,
  timingVerdict,
  LEDGER_MIN_N,
  LEDGER_MIN_WINDOWS,
  LEDGER_TIMING_SE,
  type LedgerCell,
} from '@/lib/services/market-data/ledger-cells';
import { computeMaxHoldMinutes } from '@/lib/services/paper-trader/sizing';
import { PAPER_MAX_HOLD_CEILING_MIN } from '@/lib/services/paper-trader/config';

const cell = (
  asset: string,
  horizonMin: number,
  timingBp: number,
  timingSeBp: number,
  over: Partial<LedgerCell> = {},
): LedgerCell => ({ source: 'aggregate', asset, horizonMin, n: 200, hitRate: 0.5, windows: 40, timingBp, timingSeBp, ...over });

describe('timingVerdict', () => {
  it(`acts at ${LEDGER_TIMING_SE} standard errors, not before`, () => {
    expect(timingVerdict(cell('BTC', 60, -9, 4))).toBe('wrong-way');
    expect(timingVerdict(cell('BTC', 60, -7, 4))).toBe('unproven');
    expect(timingVerdict(cell('BTC', 60, 12, 5))).toBe('proven');
    expect(timingVerdict(cell('BTC', 60, 9, 5))).toBe('unproven');
  });

  it('too few independent windows says nothing, however extreme the mean', () => {
    expect(timingVerdict(cell('BTC', 60, -40, 3, { windows: LEDGER_MIN_WINDOWS - 1 }))).toBe('unproven');
    expect(timingVerdict(cell('BTC', 60, 40, 3, { windows: LEDGER_MIN_WINDOWS - 1 }))).toBe('unproven');
  });

  it('a one-window cell (infinite error), a cell without timing and a missing cell are unproven', () => {
    expect(timingVerdict(cell('BTC', 60, -40, Number.POSITIVE_INFINITY))).toBe('unproven');
    expect(timingVerdict({ source: 's', asset: 'BTC', horizonMin: 60, n: 200, hitRate: 0.2 })).toBe('unproven');
    expect(timingVerdict(null)).toBe('unproven');
  });

  it('the hit rate plays no part: 76% "right" on drift is unproven, and can be wrong-way', () => {
    expect(timingVerdict(cell('XRP', 60, 0.2, 4, { hitRate: 0.76 }))).toBe('unproven');
    expect(timingVerdict(cell('XRP', 60, -9, 4, { hitRate: 0.76 }))).toBe('wrong-way');
  });
});

describe('assetHoldPlan', () => {
  const CELLS: LedgerCell[] = [
    cell('BTC', 60, 2, 3, { hitRate: 0.51 }),
    cell('BTC', 240, 6, 9, { hitRate: 0.61 }),
    cell('BTC', 1440, 30, 5),
    cell('ETH', 60, -12, 4),
    cell('ETH', 240, -30, 10),
    cell('SOL', 60, -12, 4),
    cell('SOL', 240, -3, 12, { hitRate: 0.44 }),
    cell('DOGE', 240, 5, 5, { n: LEDGER_MIN_N - 1 }),
    cell('XRP', 60, 20, 4, { source: 'on_chain:bybit-xrp-funding' }),
  ];

  it('picks the candidate horizon with the best timing', () => {
    expect(assetHoldPlan(CELLS, 'BTC')).toEqual({ plan: { horizonMin: 240, hitRate: 0.61, n: 200 }, measured: true });
  });

  it('never picks a horizon outside the candidates', () => {
    expect(assetHoldPlan(CELLS, 'btc', [60])).toEqual({ plan: { horizonMin: 60, hitRate: 0.51, n: 200 }, measured: true });
  });

  it('skips an asset only when the aggregate is wrong-way at every candidate horizon', () => {
    expect(assetHoldPlan(CELLS, 'ETH')).toEqual({ plan: null, measured: true });
  });

  it('a coin-flip or sub-50% hit rate does not block: the unproven horizon is still tradable', () => {
    expect(assetHoldPlan(CELLS, 'SOL')).toEqual({ plan: { horizonMin: 240, hitRate: 0.44, n: 200 }, measured: true });
  });

  it('cold asset (below LEDGER_MIN_N or absent) → unmeasured, the caller keeps its default hold', () => {
    expect(assetHoldPlan(CELLS, 'DOGE')).toEqual({ plan: null, measured: false });
    expect(assetHoldPlan(CELLS, 'SUI')).toEqual({ plan: null, measured: false });
  });

  it('only the aggregate row decides holds, not single sources', () => {
    expect(assetHoldPlan(CELLS, 'XRP')).toEqual({ plan: null, measured: false });
    expect(findCell(CELLS, 'on_chain:bybit-xrp-funding', 'xrp', 60)?.timingBp).toBe(20);
  });

  describe('recency', () => {
    it('a horizon that has turned wrong-way lately is passed over for one that has not', () => {
      const recent = [cell('BTC', 240, -25, 6, { windows: 14 })];
      expect(assetHoldPlan(CELLS, 'BTC', undefined, recent).plan?.horizonMin).toBe(60);
    });

    it('a thin recent cell changes nothing', () => {
      const recent = [cell('BTC', 240, -25, 6, { windows: LEDGER_MIN_WINDOWS - 1 })];
      expect(assetHoldPlan(CELLS, 'BTC', undefined, recent).plan?.horizonMin).toBe(240);
    });

    it('every candidate wrong-way lately → measured, no plan', () => {
      const recent = [cell('BTC', 240, -25, 6, { windows: 14 }), cell('BTC', 60, -20, 5, { windows: 30 })];
      expect(assetHoldPlan(CELLS, 'BTC', undefined, recent)).toEqual({ plan: null, measured: true });
    });
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
