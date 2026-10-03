/**
 * Resting-order execution: an order fills only on a trade-through, at its own
 * price, for the maker fee and no slippage. The stop and the time limit stay
 * market orders. The flow test walks one position from a resting entry to a
 * resting take-profit.
 */
process.env.PAPER_TRADER_MAX_CONCURRENT = '1';
process.env.PAPER_TRADER_HALT_ENTRIES_IN_CHOP = '0';
process.env.PAPER_TRADER_CHOP_STAKE_MULT = '1';
process.env.PAPER_TRADER_ASSET_SIDE_BLACKLIST_SEEDS = '';

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetCronState = jest.fn<any>();
const mockSetCronState = jest.fn<any>().mockResolvedValue(undefined);
const mockGetLivePrice = jest.fn<any>();
const mockGetMultiSourceValidatedPrice = jest.fn<any>();
const mockScanAndPickBest = jest.fn<any>();
const mockCreateHedge = jest.fn<any>().mockResolvedValue({});
const mockQuery = jest.fn<any>().mockResolvedValue([]);

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: (...args: any[]) => mockGetCronState(...args),
  setCronState: (...args: any[]) => mockSetCronState(...args),
}));
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getLivePrice: (...args: any[]) => mockGetLivePrice(...args),
  getMultiSourceValidatedPrice: (...args: any[]) => mockGetMultiSourceValidatedPrice(...args),
}));
jest.mock('@/lib/services/market-data/PredictionAggregatorService', () => ({
  PredictionAggregatorService: {
    scanAndPickBest: (...args: any[]) => mockScanAndPickBest(...args),
    scoreOpportunity: () => 50,
  },
}));
jest.mock('@/lib/db/hedges', () => ({
  createHedge: (...args: any[]) => mockCreateHedge(...args),
  closeHedge: jest.fn(async () => undefined),
}));
jest.mock('@/lib/db/postgres', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));
jest.mock('@/lib/services/paper-trader/volatility-gate', () => ({
  getRealizedVolPct: jest.fn(async () => 60),
  getBinanceRealizedVolPct: jest.fn(async () => 60),
  lowVolatilityRejection: jest.fn(async () => null),
}));

import { PaperTrader, KEY_POSITION } from '@/lib/services/paper-trader/PaperTrader';
import { KEY_RESTING_ENTRY, PAPER_EXECUTION, PAPER_RESTING_ENTRY_WAIT_MIN } from '@/lib/services/paper-trader/config';
import {
  FEE_BPS_PER_SIDE,
  MAKER_FEE_BPS_PER_SIDE,
  restingFilled,
  simulateClose,
  simulateOpen,
} from '@/lib/services/paper-trader/simulated-executor';
import { takeProfitFill } from '@/lib/services/paper-trader/target-exit';
import { checkRestingEntry, placeRestingEntry, type EntryPlan } from '@/lib/services/paper-trader/resting-orders';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

let store: Record<string, any> = {};
function primeStore(seed: Record<string, any>) {
  store = { ...seed };
  mockGetCronState.mockImplementation(((k: string) => Promise.resolve(store[k] ?? null)) as any);
  mockSetCronState.mockImplementation(((k: string, v: any) => {
    store[k] = v;
    return Promise.resolve();
  }) as any);
}

function stubSignal(asset: string, rec: string) {
  const dir = rec.includes('LONG') ? 'UP' : 'DOWN';
  const sources = Array.from({ length: 5 }, () => ({ direction: dir, weight: 0.2 }));
  const prediction = { recommendation: rec, direction: dir, confidence: 80, consensus: 75, sources };
  mockScanAndPickBest.mockResolvedValue({ best: { asset, prediction, score: 80 }, all: { [asset]: prediction } } as any);
}

function stubPrice(price: number) {
  mockGetLivePrice.mockResolvedValue(price);
  mockGetMultiSourceValidatedPrice.mockResolvedValue({
    price,
    confidence: 'high',
    sources: [
      { name: 'a', price, timestamp: Date.now() },
      { name: 'b', price, timestamp: Date.now() },
    ],
    deviation: 0,
  });
}

const plan = (over: Partial<EntryPlan> = {}): EntryPlan => ({
  asset: 'BTC', side: 'LONG', rec: 'HEDGE_LONG', notionalUsd: 1000, conf: 80, cons: 75, score: 80,
  signalScalar: 1, sourceSnapshot: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  primeStore({});
  mockCreateHedge.mockResolvedValue({});
  mockQuery.mockResolvedValue([]);
});

describe('restingFilled — a touch is not a fill', () => {
  it('a buy fills only once the mark is below the limit by the asset allowance (BTC 1 bp)', () => {
    expect(restingFilled('buy', 100, 100, 'BTC')).toBe(false);
    expect(restingFilled('buy', 100, 99.995, 'BTC')).toBe(false);
    expect(restingFilled('buy', 100, 99.99, 'BTC')).toBe(true);
    expect(restingFilled('buy', 100, 101, 'BTC')).toBe(false);
  });

  it('a sell fills only once the mark is above the limit by the allowance', () => {
    expect(restingFilled('sell', 100, 100.005, 'BTC')).toBe(false);
    expect(restingFilled('sell', 100, 100.01, 'BTC')).toBe(true);
  });

  it('a wider-spread asset needs a deeper trade-through (DOGE 2.5 bp)', () => {
    expect(restingFilled('buy', 100, 99.98, 'DOGE')).toBe(false);
    expect(restingFilled('buy', 100, 99.975, 'DOGE')).toBe(true);
  });
});

describe('fees: a resting fill pays the maker fee and no slippage', () => {
  it('the maker fee is below the taker fee and above zero', () => {
    expect(MAKER_FEE_BPS_PER_SIDE).toBeGreaterThan(0);
    expect(MAKER_FEE_BPS_PER_SIDE).toBeLessThan(FEE_BPS_PER_SIDE);
  });

  it('resting open and resting close', () => {
    const fill = { asset: 'BTC', side: 'LONG' as const, notionalUsd: 10_000, leverage: 1, entryPrice: 100 };
    const pos = simulateOpen({ ...fill, resting: true }, NOW);
    expect(pos.openFeeUsd).toBeCloseTo(10_000 * MAKER_FEE_BPS_PER_SIDE / 10_000, 8);
    expect(pos.slippageOpenUsd).toBe(0);
    const res = simulateClose(pos, 100.25, NOW, true);
    expect(res.closeFeeUsd).toBeCloseTo(10_000 * MAKER_FEE_BPS_PER_SIDE / 10_000, 8);
    expect(res.slippageUsd).toBe(0);
    expect(res.realizedPnlUsd).toBeCloseTo(25 - 2 * MAKER_FEE_BPS_PER_SIDE, 6);
  });

  it('a market open and a market close keep full taker cost (the stop path)', () => {
    const pos = simulateOpen({ asset: 'BTC', side: 'LONG', notionalUsd: 10_000, leverage: 1, entryPrice: 100 }, NOW);
    expect(pos.openFeeUsd).toBeCloseTo(6.5, 8);
    expect(pos.slippageOpenUsd).toBeCloseTo(1, 8);
    const res = simulateClose(pos, 98, NOW);
    expect(res.closeFeeUsd).toBeCloseTo(6.5, 8);
    expect(res.slippageUsd).toBeCloseTo(2, 8);
    expect(res.realizedPnlUsd).toBeCloseTo(-200 - 13 - 2, 6);
  });
});

describe('takeProfitFill', () => {
  const long = { asset: 'BTC', side: 'LONG' as const, takeProfitPrice: 100.25 };
  const short = { asset: 'BTC', side: 'SHORT' as const, takeProfitPrice: 99.75 };

  it('resting: fills only on a trade-through, at the target price', () => {
    expect(takeProfitFill(long, 100.25, 'resting')).toBeNull();
    expect(takeProfitFill(long, 100.2599, 'resting')).toBeNull();
    expect(takeProfitFill(long, 100.27, 'resting')).toEqual({ price: 100.25, resting: true });
    expect(takeProfitFill(short, 99.75, 'resting')).toBeNull();
    expect(takeProfitFill(short, 99.73, 'resting')).toEqual({ price: 99.75, resting: true });
  });

  it('market: closes at the mark once it reaches the target', () => {
    expect(takeProfitFill(long, 100.24, 'market')).toBeNull();
    expect(takeProfitFill(long, 100.3, 'market')).toEqual({ price: 100.3, resting: false });
    expect(takeProfitFill(short, 99.7, 'market')).toEqual({ price: 99.7, resting: false });
  });

  it('a position without a take-profit never fills', () => {
    expect(takeProfitFill({ asset: 'BTC', side: 'LONG' as const }, 1_000_000, 'resting')).toBeNull();
    expect(takeProfitFill({ asset: 'BTC', side: 'LONG' as const }, 1_000_000, 'market')).toBeNull();
  });
});

describe('checkRestingEntry', () => {
  const KEY = 'book:resting-entry';

  it('nothing resting', async () => {
    expect(await checkRestingEntry(KEY, NOW, async () => 100)).toEqual({ state: 'none' });
  });

  it('waits while the mark has not traded through, and when there is no mark', async () => {
    await placeRestingEntry(KEY, plan(), 100, NOW);
    expect((await checkRestingEntry(KEY, NOW + MIN, async () => 99.999)).state).toBe('waiting');
    expect((await checkRestingEntry(KEY, NOW + MIN, async () => null)).state).toBe('waiting');
    expect(store[KEY]).toBeTruthy();
  });

  it('fills on a trade-through and clears the order so it cannot open twice', async () => {
    await placeRestingEntry(KEY, plan(), 100, NOW);
    const first = await checkRestingEntry(KEY, NOW + MIN, async () => 99.98);
    expect(first.state).toBe('filled');
    expect(first.state === 'filled' && first.entry.limitPrice).toBe(100);
    expect(store[KEY]).toBeNull();
    expect((await checkRestingEntry(KEY, NOW + 2 * MIN, async () => 99.98)).state).toBe('none');
  });

  it('a SHORT entry is a sell: it fills above the limit', async () => {
    await placeRestingEntry(KEY, plan({ side: 'SHORT' }), 100, NOW);
    expect((await checkRestingEntry(KEY, NOW + MIN, async () => 99.9)).state).toBe('waiting');
    expect((await checkRestingEntry(KEY, NOW + MIN, async () => 100.02)).state).toBe('filled');
  });

  it('is cancelled once the wait is over, even if the mark is through by then', async () => {
    await placeRestingEntry(KEY, plan(), 100, NOW);
    const late = NOW + PAPER_RESTING_ENTRY_WAIT_MIN * MIN;
    expect(await checkRestingEntry(KEY, late, async () => 99)).toEqual({ state: 'none' });
    expect(store[KEY]).toBeNull();
  });
});

describe('PaperTrader — resting entry to resting take-profit', () => {
  it('runs on resting execution by default', () => {
    expect(PAPER_EXECUTION).toBe('resting');
  });

  it('places, waits, fills at the limit, then takes profit at the target', async () => {
    stubSignal('BTC', 'HEDGE_LONG');
    stubPrice(65_000);

    const placed = await PaperTrader.runTick(NOW);
    expect(placed.action).toBe('held');
    expect(placed.reason).toMatch(/resting LONG entry placed on BTC/);
    expect(store[KEY_RESTING_ENTRY].limitPrice).toBe(65_000);
    expect(store[KEY_POSITION]).toBeFalsy();
    expect(mockCreateHedge).not.toHaveBeenCalled();

    stubPrice(64_998); // 0.3 bp below: a touch, not a trade-through
    const waiting = await PaperTrader.runTick(NOW + MIN);
    expect(waiting.action).toBe('held');
    expect(store[KEY_POSITION]).toBeFalsy();

    stubPrice(64_990);
    const opened = await PaperTrader.runTick(NOW + 2 * MIN);
    expect(opened.action).toBe('opened');
    const pos = store[KEY_POSITION];
    expect(pos.entryPrice).toBe(65_000);
    expect(pos.openFeeUsd).toBeCloseTo(pos.notionalUsd * MAKER_FEE_BPS_PER_SIDE / 10_000, 8);
    expect(pos.slippageOpenUsd).toBe(0);
    expect(pos.takeProfitPrice).toBeCloseTo(65_162.5, 6);
    expect(store[KEY_RESTING_ENTRY]).toBeNull();
    const row = (mockCreateHedge.mock.calls[0] as any[])[0];
    expect(row.entryPrice).toBe(65_000);
    expect(row.metadata.execution).toBe('resting');

    stubPrice(65_163); // at the target, not through it
    expect((await PaperTrader.runTick(NOW + 3 * MIN)).action).toBe('held');

    stubPrice(65_175);
    const closed = await PaperTrader.runTick(NOW + 4 * MIN);
    expect(closed.action).toBe('closed');
    expect(closed.reason).toMatch(/^take-profit/);
    const detail = closed.detail as any;
    expect(detail.exitPrice).toBeCloseTo(65_162.5, 6);
    expect(detail.slippageUsd).toBe(0);
    expect(detail.closeFeeUsd).toBeCloseTo(pos.notionalUsd * MAKER_FEE_BPS_PER_SIDE / 10_000, 8);
    expect(detail.realizedPnlUsd).toBeGreaterThan(pos.notionalUsd * 20 / 10_000);
  });

  it('a stop on a resting-entry position is still a market order at full cost', async () => {
    stubSignal('BTC', 'HEDGE_LONG');
    stubPrice(65_000);
    await PaperTrader.runTick(NOW);
    stubPrice(64_990);
    await PaperTrader.runTick(NOW + MIN);
    const pos = store[KEY_POSITION];

    stubPrice(63_600);
    const closed = await PaperTrader.runTick(NOW + 2 * MIN);
    expect(closed.action).toBe('closed');
    expect(closed.reason).toMatch(/^stop-loss/);
    const detail = closed.detail as any;
    expect(detail.exitPrice).toBe(63_600);
    expect(detail.closeFeeUsd).toBeCloseTo(pos.notionalUsd * FEE_BPS_PER_SIDE / 10_000, 8);
    expect(detail.slippageUsd).toBeGreaterThan(0);
  });

  it('an unfilled entry lapses and the book looks for a new candidate', async () => {
    stubSignal('BTC', 'HEDGE_LONG');
    stubPrice(65_000);
    await PaperTrader.runTick(NOW);
    expect(store[KEY_RESTING_ENTRY]).toBeTruthy();

    stubPrice(65_400); // ran away: never filled
    mockScanAndPickBest.mockResolvedValue({ best: null, all: {} } as any);
    const res = await PaperTrader.runTick(NOW + (PAPER_RESTING_ENTRY_WAIT_MIN + 1) * MIN);
    expect(res.action).toBe('skipped');
    expect(store[KEY_RESTING_ENTRY]).toBeNull();
    expect(store[KEY_POSITION]).toBeFalsy();
    expect(mockCreateHedge).not.toHaveBeenCalled();
  });
});
