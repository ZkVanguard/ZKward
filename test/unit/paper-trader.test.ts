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
const mockGetMultiSourceValidatedPrice = jest.fn<any>();
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
  closeHedge: (...args: any[]) => mockCloseHedge(...args),
}));
jest.mock('@/lib/db/postgres', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

// Import AFTER mocks are set up
import {
  PaperTrader,
  KEY_POSITION,
  KEY_NAV,
  KEY_STATS,
  KEY_ORDER_ID,
  PAPER_STARTING_NAV,
  computeSignalScalar,
  computeMaxHoldMinutes,
  computeCalibrationBoost,
  PAPER_ASSET_VOL_MULT,
  PAPER_MAX_HOLD_MIN,
} from '@/lib/services/paper-trader/PaperTrader';

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

function stubSignal(asset: string, rec: string, conf = 70, cons = 65) {
  mockScanAndPickBest.mockResolvedValue({
    best: { asset, prediction: { recommendation: rec, confidence: conf, consensus: cons }, score: 80 },
    all: {
      [asset]: { recommendation: rec, confidence: conf, consensus: cons, sources: [{}, {}, {}] },
    },
  } as any);
}

/** Convenience: stub both live + multi-source price to the same value.
 *  Multi-source is used at open, live is used for mark-to-market on active positions. */
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
  // Default: multi-source price validation succeeds. Tests that need
  // failure semantics override with mockRejectedValueOnce.
  mockGetMultiSourceValidatedPrice.mockResolvedValue({
    price: 65_000,
    confidence: 'high',
    sources: [
      { name: 'a', price: 65_000, timestamp: Date.now() },
      { name: 'b', price: 65_000, timestamp: Date.now() },
    ],
    deviation: 0,
  });
});

describe('PaperTrader.runTick — entry path', () => {
  it('opens a position when no active position + strong signal + valid price', async () => {
    primeStore({});
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 72);
    stubPrice(65_000);

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

  it('skips when multi-source price validation fails (stale/insufficient sources)', async () => {
    primeStore({});
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 70);
    mockGetMultiSourceValidatedPrice.mockRejectedValue(
      new Error('INSUFFICIENT_SOURCES: Only 1/2 price sources available for BTC'),
    );
    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/price validation failed/);
  });

  it('skips when multi-source returns zero price (defensive check)', async () => {
    primeStore({});
    stubSignal('BTC', 'STRONG_HEDGE_LONG', 70);
    mockGetMultiSourceValidatedPrice.mockResolvedValue({
      price: 0,
      confidence: 'low',
      sources: [],
      deviation: 0,
    });
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
    // Position stayed active — no close happened.
    expect(store[KEY_POSITION]).toBeTruthy();
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
    // Position stayed active — no close happened.
    expect(store[KEY_POSITION]).toBeTruthy();
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
    // Position was cleared — that's the behavioral signal of a close.
    // Direct SQL is atomic now (was closeHedge() + separate UPDATE).
    expect(store[KEY_POSITION]).toBeNull();
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

  it('trailing-stop closes when winner gives back more than half of peak', async () => {
    // Position: LONG BTC @ 65k, notional $100k, peak unrealized already +$1500 from a prior tick.
    // Current mark 65_400 (+0.6%) → unrealized +$600 (before fees). Well below peak/2 = $750.
    const trailingPos = {
      ...pos,
      peakUnrealizedPnl: 1500,
    };
    primeStore({
      [KEY_POSITION]: trailingPos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90); // signal still aligned
    mockGetLivePrice.mockResolvedValue(65_400);

    const res = await PaperTrader.runTick(NOW + 5 * 60_000);
    expect(res.action).toBe('closed');
    expect(res.reason).toMatch(/trailing-stop/);
    // Position was cleared — that's the behavioral signal of a close.
    // Direct SQL is atomic now (was closeHedge() + separate UPDATE).
    expect(store[KEY_POSITION]).toBeNull();
  });

  it('trailing-stop DOES NOT arm before peak reaches PAPER_TRAILING_STOP_ARM_PCT of NAV', async () => {
    // Position with peak +$500 (0.5% of $100k) — below the 1% arm threshold.
    const smallPeak = { ...pos, peakUnrealizedPnl: 500 };
    primeStore({
      [KEY_POSITION]: smallPeak,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90);
    // Current mark barely positive so unrealized is small but positive, well
    // within max-hold. Should HOLD, not trigger a giveback close.
    mockGetLivePrice.mockResolvedValue(65_050);

    const res = await PaperTrader.runTick(NOW + 3 * 60_000);
    expect(res.action).toBe('held');
    // Position stayed active — no close happened.
    expect(store[KEY_POSITION]).toBeTruthy();
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
    // Position was cleared — that's the behavioral signal of a close.
    // Direct SQL is atomic now (was closeHedge() + separate UPDATE).
    expect(store[KEY_POSITION]).toBeNull();
  });
});

describe('computeSignalScalar — confidence weighting', () => {
  it('returns 0.4 baseline at the minimum gate (55 conf, 50 cons)', () => {
    expect(computeSignalScalar(55, 50)).toBeCloseTo(0.4, 2);
  });

  it('scales up to ~1.2+ for strong signals (80 conf, 75 cons)', () => {
    const s = computeSignalScalar(80, 75);
    expect(s).toBeGreaterThan(1.0);
    expect(s).toBeLessThan(1.4);
  });

  it('caps near 2.0 for exceptional signals (95 conf, 95 cons)', () => {
    const s = computeSignalScalar(95, 95);
    expect(s).toBeGreaterThan(1.7);
    expect(s).toBeLessThanOrEqual(2.0);
  });

  it('never returns below 0.4 even for sub-gate inputs (defense-in-depth)', () => {
    expect(computeSignalScalar(30, 20)).toBe(0.4);
  });
});

describe('computeCalibrationBoost — source-calibrator wiring', () => {
  // No calibrator mock; the real getCalibratedMultiplier will bail on the
  // cron_state read (mocked to return null → NEUTRAL 1.0 default), so
  // these tests validate the boundary + defensive branches.
  it('returns 1.0 when sources array is empty', async () => {
    const result = await computeCalibrationBoost([]);
    expect(result).toBe(1.0);
  });

  it('returns 1.0 when total weight is 0 (defensive)', async () => {
    const result = await computeCalibrationBoost([
      { name: 'x', weight: 0 },
      { name: 'y', weight: 0 },
    ]);
    expect(result).toBe(1.0);
  });

  it('produces a result in [0.5, 1.5] for real inputs', async () => {
    const result = await computeCalibrationBoost([
      { name: 'src1', weight: 1 },
      { name: 'src2', weight: 1 },
    ]);
    expect(result).toBeGreaterThanOrEqual(0.5);
    expect(result).toBeLessThanOrEqual(1.5);
  });
});

describe('computeMaxHoldMinutes — dynamic max-hold', () => {
  it('returns base max-hold at the minimum signal scalar (0.4)', () => {
    expect(computeMaxHoldMinutes(0.4)).toBeCloseTo(PAPER_MAX_HOLD_MIN, 1);
  });

  it('adds ~half the extra at mid-strength (scalar 1.2)', () => {
    // At scalar=1.2, bonusRatio = (1.2-0.4)/1.6 = 0.5 → +45 min → 65 min total
    expect(computeMaxHoldMinutes(1.2)).toBeCloseTo(PAPER_MAX_HOLD_MIN + 45, 0);
  });

  it('caps at base + full extra at scalar 2.0', () => {
    // Bonus ratio = 1.0 → +90 min → 110 min total
    expect(computeMaxHoldMinutes(2.0)).toBeCloseTo(PAPER_MAX_HOLD_MIN + 90, 0);
  });

  it('clamps for out-of-range input', () => {
    expect(computeMaxHoldMinutes(0.1)).toBe(PAPER_MAX_HOLD_MIN); // below 0.4 floor
    expect(computeMaxHoldMinutes(5.0)).toBeCloseTo(PAPER_MAX_HOLD_MIN + 90, 0); // above 2.0 cap
  });
});

describe('PAPER_ASSET_VOL_MULT — vol parity', () => {
  it('assigns higher multipliers to less volatile assets', () => {
    expect(PAPER_ASSET_VOL_MULT.BTC).toBe(1.0);
    expect(PAPER_ASSET_VOL_MULT.SOL).toBeLessThan(PAPER_ASSET_VOL_MULT.BTC);
    expect(PAPER_ASSET_VOL_MULT.DOGE).toBeLessThan(PAPER_ASSET_VOL_MULT.ETH);
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

  it('skips (asset, side) after recent losses cross regret-cooldown threshold', async () => {
    // Seed 5 recent losing paper hedges on ETH SHORT summing to -$3000, > 2% of $100k NAV.
    mockQuery.mockResolvedValueOnce([
      { pnl: -800 },
      { pnl: -600 },
      { pnl: -500 },
      { pnl: -700 },
      { pnl: -500 },
    ] as any);
    primeStore({});
    stubSignal('ETH', 'HEDGE_SHORT', 80, 75);
    mockGetLivePrice.mockResolvedValue(2500);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/regret-cooldown/);
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
    stubPrice(65_000);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('opened');
    expect(mockCreateHedge).toHaveBeenCalledTimes(1);
    // Stats got re-anchored to today's peak.
    expect(store[KEY_STATS].dailyPeakDateUtc).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(store[KEY_STATS].dailyPeakNavUsd).toBe(94_000);
  });
});
