/**
 * PaperTrader orchestrator — end-to-end tick tests with mocked signals + prices.
 *
 * Locks the state transitions:
 *   • no-position + strong signal → opened (position stored, hedge row written)
 *   • active-position + max-hold expiry → closed (NAV updated, stats bumped)
 *   • active-position + high-conf signal-flip → closed (mirrors #101)
 *   • active-position + low-conf demotion → HELD (mirrors #101 confidence gate)
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock DB + services BEFORE importing PaperTrader.
const mockGetCronState = jest.fn<any>();
const mockSetCronState = jest.fn<any>().mockResolvedValue(undefined);
const mockGetLivePrice = jest.fn<any>();
const mockScanAndPickBest = jest.fn<any>();
const mockCreateHedge = jest.fn<any>().mockResolvedValue({});
const mockCloseHedge = jest.fn<any>().mockResolvedValue(undefined);
const mockQuery = jest.fn<any>().mockResolvedValue([]);

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: (...args: any[]) => mockGetCronState(...args),
  setCronState: (...args: any[]) => mockSetCronState(...args),
}));
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getLivePrice: (...args: any[]) => mockGetLivePrice(...args),
}));
jest.mock('@/lib/services/market-data/PredictionAggregatorService', () => ({
  PredictionAggregatorService: {
    scanAndPickBest: (...args: any[]) => mockScanAndPickBest(...args),
    scoreOpportunity: () => 50,
  },
}));
jest.mock('@/lib/db/hedges', () => ({
  createHedge: (...args: any[]) => mockCreateHedge(...args),
  closeHedge: (...args: any[]) => mockCloseHedge(...args),
}));
jest.mock('@/lib/db/postgres', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

// Import AFTER mocks are set up
import { PaperTrader, KEY_POSITION, KEY_NAV, KEY_STATS, KEY_ORDER_ID, PAPER_STARTING_NAV } from '@/lib/services/paper-trader/PaperTrader';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

// Fake per-key state store shared across the mock.
let store: Record<string, any> = {};
function primeStore(seed: Record<string, any>) {
  store = { ...seed };
  mockGetCronState.mockImplementation(((k: string) => Promise.resolve(store[k] ?? null)) as any);
  mockSetCronState.mockImplementation(((k: string, v: any) => {
    store[k] = v;
    return Promise.resolve();
  }) as any);
}

function stubSignal(asset: string, rec: string, conf = 70) {
  mockScanAndPickBest.mockResolvedValue({
    best: { asset, prediction: { recommendation: rec, confidence: conf }, score: 80 },
    all: {
      [asset]: { recommendation: rec, confidence: conf, sources: [{}, {}, {}] },
    },
  } as any);
}

function stubSameAssetPrediction(asset: string, rec: string, conf: number) {
  mockScanAndPickBest.mockResolvedValue({
    best: null,
    all: { [asset]: { recommendation: rec, confidence: conf, sources: [{}, {}] } },
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  store = {};
  mockCreateHedge.mockResolvedValue({});
  mockCloseHedge.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue([]);
});

describe('PaperTrader.runTick — entry path', () => {
  it('opens a position when no active position + strong signal + valid price', async () => {
    primeStore({});
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 72);
    mockGetLivePrice.mockResolvedValue(65_000);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('opened');
    expect(store[KEY_POSITION]).toBeTruthy();
    expect(store[KEY_POSITION].side).toBe('LONG');
    expect(store[KEY_POSITION].asset).toBe('BTC');
    expect(store[KEY_ORDER_ID]).toMatch(/^paper_BTC_/);
    expect(mockCreateHedge).toHaveBeenCalledTimes(1);
    const call = (mockCreateHedge.mock.calls[0] as any[])[0];
    expect(call.chain).toBe('hedera-testnet');
    expect(call.portfolioId).toBe(-3);
  });

  it('skips when no signal above gates', async () => {
    primeStore({});
    mockScanAndPickBest.mockResolvedValue({ best: null, all: {} } as any);
    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/no edge/);
    expect(mockCreateHedge).not.toHaveBeenCalled();
  });

  it('skips when best signal is non-directional (WAIT/NEUTRAL)', async () => {
    primeStore({});
    stubSignal('BTC', 'WAIT', 80);
    mockGetLivePrice.mockResolvedValue(65_000);
    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/non-directional/);
  });

  it('skips when live price is zero (oracle failure)', async () => {
    primeStore({});
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 70);
    mockGetLivePrice.mockResolvedValue(0);
    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/no mark price/);
  });
});

describe('PaperTrader.runTick — active-position path', () => {
  const pos = {
    asset: 'BTC',
    side: 'LONG' as const,
    entryPrice: 65_000,
    size: 100_000 / 65_000,
    notionalUsd: 100_000,
    leverage: 1,
    openedAt: NOW,
    openFeeUsd: 65,
  };

  it('holds when signal is unchanged (same side, still confident)', async () => {
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'HEDGE_LONG', 70);
    mockGetLivePrice.mockResolvedValue(65_100);

    const res = await PaperTrader.runTick(NOW + 5 * 60_000);
    expect(res.action).toBe('held');
    expect(mockCloseHedge).not.toHaveBeenCalled();
  });

  it('HOLDS on low-conf demotion (mirrors #101 confidence gate)', async () => {
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    // Demoted signal at 40% conf — below the 55 gate; must NOT close
    stubSameAssetPrediction('BTC', 'LIGHT_HEDGE_LONG', 40);
    mockGetLivePrice.mockResolvedValue(65_000);

    const res = await PaperTrader.runTick(NOW + 5 * 60_000);
    expect(res.action).toBe('held');
    expect(mockCloseHedge).not.toHaveBeenCalled();
  });

  it('CLOSES on high-conf direction flip', async () => {
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'HEDGE_SHORT', 70); // flipped LONG → SHORT
    mockGetLivePrice.mockResolvedValue(65_500);

    const res = await PaperTrader.runTick(NOW + 5 * 60_000);
    expect(res.action).toBe('closed');
    expect(res.reason).toMatch(/signal flipped/);
    expect(mockCloseHedge).toHaveBeenCalledTimes(1);
    expect(store[KEY_POSITION]).toBeNull();
  });

  it('CLOSES on max-hold expiry regardless of signal', async () => {
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90); // signal aligned & strong
    mockGetLivePrice.mockResolvedValue(66_000);

    const res = await PaperTrader.runTick(NOW + 25 * 60_000); // max-hold = 20 min
    expect(res.action).toBe('closed');
    expect(res.reason).toMatch(/max-hold/);
  });

  it('updates NAV and stats after a winning close', async () => {
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90);
    mockGetLivePrice.mockResolvedValue(70_000); // +7.7% winner

    await PaperTrader.runTick(NOW + 25 * 60_000);
    expect(store[KEY_NAV]).toBeGreaterThan(PAPER_STARTING_NAV);
    expect(store[KEY_STATS].trades).toBe(1);
    expect(store[KEY_STATS].wins).toBe(1);
    expect(store[KEY_STATS].losses).toBe(0);
    expect(store[KEY_STATS].cumRealizedUsd).toBeGreaterThan(0);
  });

  it('updates NAV downward + losses count after a losing close', async () => {
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90);
    mockGetLivePrice.mockResolvedValue(60_000); // -7.7% loser

    await PaperTrader.runTick(NOW + 25 * 60_000);
    expect(store[KEY_NAV]).toBeLessThan(PAPER_STARTING_NAV);
    expect(store[KEY_STATS].wins).toBe(0);
    expect(store[KEY_STATS].losses).toBe(1);
    expect(store[KEY_STATS].cumRealizedUsd).toBeLessThan(0);
  });

  it('stops out mid-trade when unrealized PnL exceeds PAPER_STOP_LOSS_PCT of NAV', async () => {
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90); // signal still aligned
    // 5% adverse move on a $100k 1x LONG = -$5000 unrealized.
    // PAPER_STOP_LOSS_PCT default = 2% of $100k NAV = $2000 threshold. Trips.
    mockGetLivePrice.mockResolvedValue(61_750);

    // Tick well within max-hold window so only stop-loss can trip.
    const res = await PaperTrader.runTick(NOW + 3 * 60_000);
    expect(res.action).toBe('closed');
    expect(res.reason).toMatch(/stop-loss/);
    expect(mockCloseHedge).toHaveBeenCalledTimes(1);
  });
});

describe('PaperTrader.runTick — profit-lock + halt gates', () => {
  it('halts new opens when daily drawdown exceeds PAPER_PROFIT_LOCK_DRAWDOWN_PCT', async () => {
    const today = new Date(NOW).toISOString().slice(0, 10);
    primeStore({
      [KEY_NAV]: 94_000, // -6% from daily peak
      [KEY_STATS]: {
        trades: 3,
        wins: 1,
        losses: 2,
        cumRealizedUsd: -6000,
        peakNavUsd: 100_000,
        lastRealizedUsd: -3000,
        dailyPeakNavUsd: 100_000,
        dailyPeakDateUtc: today,
      },
    });
    // If a signal existed it would open — but the gate should skip first.
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 80);
    mockGetLivePrice.mockResolvedValue(65_000);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/profit-lock/);
    expect(mockCreateHedge).not.toHaveBeenCalled();
    expect(store[KEY_STATS].haltedUntilMs).toBeGreaterThan(NOW);
  });

  it('halts new opens when consecutiveLosses reaches PAPER_MAX_CONSECUTIVE_LOSSES', async () => {
    const today = new Date(NOW).toISOString().slice(0, 10);
    primeStore({
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_STATS]: {
        trades: 10,
        wins: 5,
        losses: 5,
        cumRealizedUsd: -500,
        peakNavUsd: PAPER_STARTING_NAV,
        lastRealizedUsd: -100,
        consecutiveLosses: 5,
        dailyPeakNavUsd: PAPER_STARTING_NAV,
        dailyPeakDateUtc: today,
      },
    });
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 80);
    mockGetLivePrice.mockResolvedValue(65_000);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/consecutive losses/);
    expect(mockCreateHedge).not.toHaveBeenCalled();
  });

  it('clears halt on UTC-day rollover and allows a fresh open', async () => {
    const yesterday = new Date(NOW - 24 * HOUR).toISOString().slice(0, 10);
    primeStore({
      [KEY_NAV]: 94_000,
      [KEY_STATS]: {
        trades: 3,
        wins: 1,
        losses: 2,
        cumRealizedUsd: -6000,
        peakNavUsd: 100_000,
        lastRealizedUsd: -3000,
        dailyPeakNavUsd: 100_000,
        dailyPeakDateUtc: yesterday, // stale — should trigger reset
        haltedUntilMs: NOW - HOUR,   // expired anyway
      },
    });
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 80);
    mockGetLivePrice.mockResolvedValue(65_000);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('opened');
    expect(mockCreateHedge).toHaveBeenCalledTimes(1);
    // Stats got re-anchored to today's peak.
    expect(store[KEY_STATS].dailyPeakDateUtc).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(store[KEY_STATS].dailyPeakNavUsd).toBe(94_000);
  });
});
