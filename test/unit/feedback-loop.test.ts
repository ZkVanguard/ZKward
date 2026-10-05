/**
 * The feedback loop's judgment. Three rules are pinned here, each from a
 * measured failure: coins in the same window are one observation; a verdict
 * must survive a false-discovery check across its group; and it is in force
 * only when it also holds without the last day of data.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async () => null),
  setCronState: jest.fn(async () => undefined),
}));
jest.mock('@/lib/db/signal-outcomes', () => ({
  getLedgerBucketRows: jest.fn(async () => []),
}));

import { getCronState, setCronState } from '@/lib/db/cron-state';
import { getLedgerBucketRows, type LedgerBucketRow } from '@/lib/db/signal-outcomes';
import {
  LOOP_STATE_KEY,
  cellEvidence,
  cellKey,
  evaluateLoop,
  familyEvidence,
  judge,
  resolveVerdict,
  runFeedbackLoopEvaluation,
  sourceFamily,
  survivesFalseDiscovery,
  twoSidedP,
  type Evidence,
  type LoopState,
} from '@/lib/services/market-data/feedback-loop';
import { LEDGER_MIN_WINDOWS } from '@/lib/services/market-data/ledger-cells';

const mockGetState = getCronState as jest.MockedFunction<typeof getCronState>;
const mockSetState = setCronState as jest.MockedFunction<typeof setCronState>;
const mockRows = getLedgerBucketRows as jest.MockedFunction<typeof getLedgerBucketRows>;

const HOUR = 3_600_000;
const row = (source: string, asset: string, bucket: number, timingBp: number, n = 6): LedgerBucketRow => ({ source, asset, horizonMin: 60, bucket, n, timingBp });
/** A deterministic zero-mean wobble, so a series has a spread without a random seed. */
const wobble = (i: number, size: number) => size * (i % 2 === 0 ? 1 : -1) * (1 + (i % 5) / 5);
const series = (source: string, asset: string, windows: number, mean: number, spread: number, from = 0) =>
  Array.from({ length: windows }, (_, i) => row(source, asset, from + i, mean + wobble(i, spread)));

describe('sourceFamily', () => {
  it('pools a source across its coins under one family', () => {
    expect(sourceFamily('short_term:kalshi-eth')).toBe('kalshi');
    expect(sourceFamily('short_term:kalshi-xrp')).toBe('kalshi');
    expect(sourceFamily('short_term:orderbook-btc-depth-imbalance')).toBe('order-book-imbalance');
    expect(sourceFamily('on_chain:bybit-sol-funding')).toBe('funding');
    expect(sourceFamily('polymarket-5min-BTC')).toBe('polymarket-5min');
  });

  it('keeps the 5-minute variants apart: they are different instruments', () => {
    expect(sourceFamily('polymarket-5min-BTC-synth')).toBe('polymarket-5min-synth');
    expect(sourceFamily('polymarket-5min-BTC-ticker')).toBe('polymarket-5min-ticker');
  });

  it('the combined signals and the gates are their own families', () => {
    expect(sourceFamily('aggregate')).toBe('aggregate');
    expect(sourceFamily('aggregate:v2')).toBe('aggregate:v2');
    expect(sourceFamily('gate:low-volatility')).toBe('gate:low-volatility');
  });

  it('single market questions read by the model are one family; an unknown source is its own', () => {
    expect(sourceFamily('short_term:ai-will-bitcoin-dip-to-78-000')).toBe('ai-interpretation');
    expect(sourceFamily('sentiment:something-new')).toBe('sentiment:something-new');
  });
});

describe('evidence', () => {
  it('a cell takes one window per bucket of its coin', () => {
    const e = cellEvidence(series('short_term:kalshi-eth', 'ETH', 20, 4, 10), 60).get(cellKey('short_term:kalshi-eth', 'eth'))!;
    expect(e.windows).toBe(20);
    expect(e.n).toBe(120);
    expect(e.timingBp).toBeCloseTo(4 + Array.from({ length: 20 }, (_, i) => wobble(i, 10)).reduce((s, x) => s + x, 0) / 20, 6);
  });

  it('coins that move together add no windows: five identical coins give the error of one', () => {
    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
    const together = coins.flatMap((c) => series(`short_term:kalshi-${c.toLowerCase()}`, c, 30, 3, 12));
    const pooled = familyEvidence(together, 60).get('kalshi')!;
    const single = cellEvidence(together, 60).get(cellKey('short_term:kalshi-btc', 'BTC'))!;
    expect(pooled.windows).toBe(30);
    expect(pooled.seBp).toBeCloseTo(single.seBp, 6);
    expect(pooled.n).toBe(5 * 30 * 6);
  });

  it('coins that move apart do cut the error', () => {
    // Two coins with opposite wobbles cancel inside each window.
    const a = series('short_term:kalshi-btc', 'BTC', 30, 3, 12);
    const b = series('short_term:kalshi-eth', 'ETH', 30, 3, 12).map((r, i) => ({ ...r, timingBp: 3 - wobble(i, 12) }));
    const pooled = familyEvidence([...a, ...b], 60).get('kalshi')!;
    expect(pooled.timingBp).toBeCloseTo(3, 6);
    expect(pooled.seBp).toBeCloseTo(0, 6);
  });

  it('each coin counts once inside a window, whatever its row count', () => {
    const rows = [row('on_chain:bybit-btc-funding', 'BTC', 1, 10, 60), row('on_chain:binance-eth-funding', 'ETH', 1, -10, 1), row('on_chain:bybit-btc-funding', 'BTC', 2, 0), row('on_chain:binance-eth-funding', 'ETH', 2, 0)];
    expect(familyEvidence(rows, 60).get('funding')!.timingBp).toBeCloseTo(0, 6);
  });

  it('reads only the horizon asked for', () => {
    const rows = [...series('aggregate', 'BTC', 15, 2, 5), { ...row('aggregate', 'BTC', 99, 500), horizonMin: 240 }];
    expect(cellEvidence(rows, 60).get(cellKey('aggregate', 'BTC'))!.windows).toBe(15);
  });
});

describe('twoSidedP', () => {
  it('matches the t table', () => {
    expect(twoSidedP(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(twoSidedP(2.086, 20)).toBeCloseTo(0.05, 3);
    expect(twoSidedP(3.169, 10)).toBeCloseTo(0.01, 3);
    expect(twoSidedP(1.96, 100_000)).toBeCloseTo(0.05, 3);
    expect(twoSidedP(0, 30)).toBe(1);
    expect(twoSidedP(-2.228, 10)).toBeCloseTo(0.05, 3);
  });

  it('two standard errors over twelve windows is weaker than it looks', () => {
    expect(twoSidedP(2, LEDGER_MIN_WINDOWS - 1)).toBeGreaterThan(0.065);
  });
});

describe('survivesFalseDiscovery', () => {
  it('keeps the smallest p-values up to the last one under its step', () => {
    // m = 5, q = 0.1: steps 0.02, 0.04, 0.06, 0.08, 0.10.
    expect(survivesFalseDiscovery([0.5, 0.001, 0.03, 0.2, 0.05], 0.1)).toEqual([false, true, true, false, true]);
  });

  it('one test alone only has to clear q', () => {
    expect(survivesFalseDiscovery([0.04], 0.1)).toEqual([true]);
    expect(survivesFalseDiscovery([0.2], 0.1)).toEqual([false]);
  });

  it('a lone small p among many nulls does not stand', () => {
    const many = [0.03, ...Array.from({ length: 39 }, (_, i) => 0.2 + i * 0.02)];
    expect(survivesFalseDiscovery(many, 0.1)[0]).toBe(false);
  });
});

describe('judge', () => {
  const ev = (timingBp: number, seBp: number, windows = 60): Evidence => ({ timingBp, seBp, windows, n: windows * 6 });
  const allSources = () => 'source';

  it('a cell just past two standard errors among many flat ones is not a verdict', () => {
    const cells = new Map<string, Evidence>([['lucky|BTC', ev(9, 4)]]);
    for (let i = 0; i < 40; i++) cells.set(`flat${i}|BTC`, ev(i % 2 ? 1 : -1, 4));
    expect(judge(cells, allSources).get('lucky|BTC')!.verdict).toBe('unproven');
  });

  it('a strong cell stands among the same flat ones, either way', () => {
    const cells = new Map<string, Evidence>([['strong|BTC', ev(20, 4)], ['bad|BTC', ev(-20, 4)]]);
    for (let i = 0; i < 40; i++) cells.set(`flat${i}|BTC`, ev(i % 2 ? 1 : -1, 4));
    const out = judge(cells, allSources);
    expect(out.get('strong|BTC')!.verdict).toBe('proven');
    expect(out.get('bad|BTC')!.verdict).toBe('wrong-way');
  });

  it('alone in its group, two standard errors is the bar', () => {
    expect(judge(new Map([['aggregate', ev(9, 4)]]), allSources).get('aggregate')!.verdict).toBe('proven');
    expect(judge(new Map([['aggregate', ev(7, 4)]]), allSources).get('aggregate')!.verdict).toBe('unproven');
  });

  it('too few windows is not tested, however extreme', () => {
    const j = judge(new Map([['thin|BTC', ev(80, 3, LEDGER_MIN_WINDOWS - 1)]]), allSources).get('thin|BTC')!;
    expect(j).toMatchObject({ verdict: 'unproven', tested: false, p: 1 });
  });

  it('an entry with no group is left unjudged', () => {
    expect(judge(new Map([['gate:x|BTC', ev(-30, 3)]]), () => null).get('gate:x|BTC')!.tested).toBe(false);
  });

  it('groups do not dilute each other', () => {
    const entries = new Map<string, Evidence>([['aggregate', ev(9, 4)]]);
    for (let i = 0; i < 40; i++) entries.set(`flat${i}`, ev(i % 2 ? 1 : -1, 4));
    expect(judge(entries, (k) => (k === 'aggregate' ? 'aggregate' : 'source')).get('aggregate')!.verdict).toBe('proven');
  });
});

describe('evaluateLoop', () => {
  const DAYS = 6;
  const now = DAYS * 24 * HOUR;

  it('holds a verdict that stands with and without the last day', () => {
    const state = evaluateLoop(series('aggregate', 'BTC', DAYS * 24, 12, 10), now, 60);
    expect(state.cells[cellKey('aggregate', 'BTC')]).toMatchObject({ verdict: 'proven', windows: DAYS * 24 });
    expect(state.families.aggregate.verdict).toBe('proven');
    expect(state.pending).toEqual([]);
    expect(state.counts).toMatchObject({ proven: 2, wrongWay: 0, pending: 0 });
    expect(state.day).toBe('1970-01-07');
  });

  it('a verdict that only the last day decides is pending, not in force', () => {
    // Flat for five days, then one strong day.
    const rows = [...series('aggregate', 'BTC', 5 * 24, 0, 10), ...series('aggregate', 'BTC', 24, 40, 10, 5 * 24)];
    const state = evaluateLoop(rows, now, 60);
    expect(state.cells).toEqual({});
    expect(state.pending).toContain(`cell:${cellKey('aggregate', 'BTC')}`);
    expect(state.counts.pending).toBe(state.pending.length);
  });

  it('a gate is judged pooled across coins, never per coin', () => {
    const rows = ['BTC', 'ETH', 'SOL'].flatMap((c) => series('gate:low-volatility', c, DAYS * 24, -15, 10));
    const state = evaluateLoop(rows, now, 60);
    expect(state.families['gate:low-volatility'].verdict).toBe('wrong-way');
    expect(Object.keys(state.cells)).toEqual([]);
  });

  it('nothing decided leaves an empty state', () => {
    const state = evaluateLoop(series('aggregate', 'BTC', DAYS * 24, 0, 10), now, 60);
    expect(state).toMatchObject({ cells: {}, families: {}, pending: [] });
    expect(state.counts.cellsJudged).toBe(1);
  });
});

describe('resolveVerdict', () => {
  const inForce = (verdict: 'proven' | 'wrong-way') => ({ verdict, timingBp: 0, seBp: 1, windows: 50 });

  it('a decided cell speaks for itself', () => {
    const state = { cells: { [cellKey('short_term:kalshi-eth', 'ETH')]: inForce('proven') }, families: {} };
    expect(resolveVerdict(state, 'short_term:kalshi-eth', 'ETH')).toEqual({ verdict: 'proven', level: 'cell' });
    expect(resolveVerdict(state, 'short_term:kalshi-btc', 'BTC')).toEqual({ verdict: 'unproven', level: null });
  });

  it('an undecided cell takes its family, including a source seen for the first time', () => {
    const state = { cells: {}, families: { kalshi: inForce('wrong-way') } };
    expect(resolveVerdict(state, 'short_term:kalshi-doge', 'DOGE')).toEqual({ verdict: 'wrong-way', level: 'family' });
  });

  it('a cell and its family that disagree decide nothing', () => {
    const state = { cells: { [cellKey('short_term:kalshi-eth', 'ETH')]: inForce('wrong-way') }, families: { kalshi: inForce('proven') } };
    expect(resolveVerdict(state, 'short_term:kalshi-eth', 'ETH')).toEqual({ verdict: 'unproven', level: null });
    expect(resolveVerdict(state, 'short_term:kalshi-btc', 'BTC')).toEqual({ verdict: 'proven', level: 'family' });
  });

  it('no state means nothing is proven', () => {
    expect(resolveVerdict(null, 'aggregate', 'BTC')).toEqual({ verdict: 'unproven', level: null });
  });
});

describe('runFeedbackLoopEvaluation', () => {
  const NOW = Date.UTC(2026, 9, 6, 0, 12);
  const stored = (day: string): LoopState => ({ version: 1, day, evaluatedAt: 0, horizonMin: 60, cells: {}, families: {}, pending: [], counts: { cellsJudged: 0, familiesJudged: 0, proven: 0, wrongWay: 0, pending: 0 } });

  beforeEach(() => {
    mockGetState.mockReset();
    mockSetState.mockReset();
    mockRows.mockReset();
  });

  it('judges once per UTC day', async () => {
    mockGetState.mockResolvedValue(stored('2026-10-06'));
    expect(await runFeedbackLoopEvaluation(NOW)).toBeNull();
    expect(mockRows).not.toHaveBeenCalled();
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it('stores a new judgment on a new day, read at the weight horizon', async () => {
    mockGetState.mockResolvedValue(stored('2026-10-05'));
    const bucketNow = Math.floor(NOW / HOUR);
    mockRows.mockResolvedValue(series('aggregate', 'BTC', 5 * 24, 12, 10, bucketNow - 5 * 24));
    const state = await runFeedbackLoopEvaluation(NOW);
    expect(state?.day).toBe('2026-10-06');
    expect(state?.cells[cellKey('aggregate', 'BTC')]?.verdict).toBe('proven');
    expect(mockRows).toHaveBeenCalledWith(expect.objectContaining({ horizonsMin: [60] }));
    expect(mockSetState).toHaveBeenCalledWith(LOOP_STATE_KEY, state);
  });

  it('an empty ledger read is an error and leaves the stored judgment alone', async () => {
    mockGetState.mockResolvedValue(stored('2026-10-05'));
    mockRows.mockResolvedValue([]);
    await expect(runFeedbackLoopEvaluation(NOW)).rejects.toThrow(/no resolved rows/);
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it('a failed ledger read propagates and writes nothing', async () => {
    mockGetState.mockResolvedValue(null);
    mockRows.mockRejectedValue(new Error('connection terminated'));
    await expect(runFeedbackLoopEvaluation(NOW)).rejects.toThrow('connection terminated');
    expect(mockSetState).not.toHaveBeenCalled();
  });
});
