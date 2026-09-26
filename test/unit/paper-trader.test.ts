/**
 * PaperTrader orchestrator — end-to-end tick tests with mocked signals + prices.
 *
 * Locks the state transitions:
 *   • no-position + strong signal → opened (position stored, hedge row written)
 *   • active-position + max-hold expiry → closed (NAV updated, stats bumped)
 *   • active-position + high-conf signal-flip → closed (mirrors #101)
 *   • active-position + low-conf demotion → HELD (mirrors #101 confidence gate)
 */
// Pin PAPER_TRADER_MAX_HOLD_MIN to the historical 20 for tests. The prod
// default was bumped to 45 in the 2026-09-20 stops fix (post-mortem on
// 164 paper trades showed the 20-25m near-timeout bucket lost -$37.6K
// at 16.7% win rate). The tests here assert the state transition at
// expiry — behavior at boundary, not the numeric value.
process.env.PAPER_TRADER_MAX_HOLD_MIN = '20';
// Force single-position (KEY_POSITION) mode for these tests. Prod ran
// KEY_POSITIONS (concurrent 3) since 2026-09-22; the tests here assert
// the legacy single-slot state transitions.
process.env.PAPER_TRADER_MAX_CONCURRENT = '1';
// Regime lookup defaults to CHOP when the aggregator mock isn't wired.
// These tests exercise the entry state-machine, not the regime halt —
// disable so opens aren't shadow-blocked. Regime halt has its own tests.
process.env.PAPER_TRADER_HALT_ENTRIES_IN_CHOP = '0';

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
// Mock volatility-gate so adaptive-stops falls through to its STATIC
// fallback (STOP=0.025, ARM=0.006), AND lowVolatilityRejection returns
// null (fail-open on null vol). Without this, tests picked up live
// BTC vol from the network. Mock a HIGH vol (60%) so the low-vol
// entry gate PASSES rather than fails-open.
jest.mock('@/lib/services/paper-trader/volatility-gate', () => ({
  getRealizedVolPct: jest.fn(async () => 60),
  getBinanceRealizedVolPct: jest.fn(async () => 60),
  lowVolatilityRejection: jest.fn(async () => null),
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

function stubSignal(asset: string, rec: string, conf = 80, cons = 75) {
  // Default confidence bumped 70 → 80 on 2026-09-25 after Fix J raised
  // PAPER_MIN_CONFIDENCE default 62 → 70 and the regime chop-multiplier
  // (1.05×) can push the effective floor above 70. 80 stays clear of
  // any reasonable gate. Individual tests still override this arg.
  // Derive direction from recommendation so signal-quality gate has data
  // it can actually work with (majority + stability filters read
  // prediction.direction + prediction.sources).
  const dir: 'UP' | 'DOWN' | 'NEUTRAL' =
    rec.includes('LONG') ? 'UP' : rec.includes('SHORT') ? 'DOWN' : 'NEUTRAL';
  // Give 5 majority-agreeing sources by default so the quality gate passes
  // for happy-path tests. Tests that want to test the gate itself can
  // override.
  const sources = Array.from({ length: 5 }, () => ({ direction: dir, weight: 0.2 }));
  mockScanAndPickBest.mockResolvedValue({
    best: {
      asset,
      prediction: { recommendation: rec, direction: dir, confidence: conf, consensus: cons, sources },
      score: 80,
    },
    all: {
      [asset]: { recommendation: rec, direction: dir, confidence: conf, consensus: cons, sources },
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
  // 2026-09-25: bumped default sources 2 → 3 + added consensus so flip
  // gates (PAPER_MIN_SOURCES=3, PAPER_MIN_CONSENSUS=60) pass. Tests
  // asserting the gate itself override the shape locally.
  const dir: 'UP' | 'DOWN' | 'NEUTRAL' =
    rec.includes('LONG') ? 'UP' : rec.includes('SHORT') ? 'DOWN' : 'NEUTRAL';
  const sources = [
    { direction: dir, weight: 0.34 },
    { direction: dir, weight: 0.33 },
    { direction: dir, weight: 0.33 },
  ];
  mockScanAndPickBest.mockResolvedValue({
    best: null,
    all: {
      [asset]: { recommendation: rec, direction: dir, confidence: conf, consensus: 75, sources },
    },
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
    stubSignal('BTC', 'HEDGE_LONG', 80);
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
    stubSignal('BTC', 'HEDGE_LONG', 80);
    mockGetMultiSourceValidatedPrice.mockRejectedValue(
      new Error('INSUFFICIENT_SOURCES: Only 1/2 price sources available for BTC'),
    );
    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/price validation failed/);
  });

  it('skips when multi-source returns zero price (defensive check)', async () => {
    primeStore({});
    stubSignal('BTC', 'HEDGE_LONG', 80);
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

    // Post-Fix-M (2026-09-26): flip-age gate raised 3min → 15min. Fire
    // between the flip gate (15) and the pinned MAX_HOLD (20) — 16min
    // hits the flip path cleanly.
    const res = await PaperTrader.runTick(NOW + 16 * 60_000);
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

  it('stops out mid-trade when live mark crosses persisted stopLossPrice', async () => {
    // Price-anchored stop (2026-09-20 fix). Position carries an explicit
    // stopLossPrice set at open; handleActive closes deterministically
    // once mark crosses it — no NAV-pct math, no dependency on tick-to-
    // tick unrealized delta.
    const posWithStop = { ...pos, stopLossPrice: 64_740 }; // 0.4% below entry
    primeStore({
      [KEY_POSITION]: posWithStop,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90);
    mockGetLivePrice.mockResolvedValue(64_700); // below stop → fires

    const res = await PaperTrader.runTick(NOW + 3 * 60_000);
    expect(res.action).toBe('closed');
    expect(res.reason).toMatch(/stop-loss.*crossed/);
    expect(store[KEY_POSITION]).toBeNull();
  });

  it('holds when mark is adverse but has NOT crossed the persisted stopLossPrice', async () => {
    // Regression check: stopLossPrice at 64_740 (0.4% below entry). Mark
    // at 64_800 is adverse but hasn't crossed the line. Must hold.
    const posWithStop = { ...pos, stopLossPrice: 64_740 };
    primeStore({
      [KEY_POSITION]: posWithStop,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90);
    mockGetLivePrice.mockResolvedValue(64_800);

    const res = await PaperTrader.runTick(NOW + 3 * 60_000);
    expect(res.action).toBe('held');
    expect(store[KEY_POSITION]).toBeTruthy();
  });

  it('SHORT stops when mark rises above persisted stopLossPrice', async () => {
    // Direction-symmetric check for the price-anchored stop.
    const shortPos = {
      ...pos,
      side: 'SHORT' as const,
      stopLossPrice: 65_260, // 0.4% above entry
    };
    primeStore({
      [KEY_POSITION]: shortPos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_SHORT', 90);
    mockGetLivePrice.mockResolvedValue(65_400); // above stop → fires

    const res = await PaperTrader.runTick(NOW + 3 * 60_000);
    expect(res.action).toBe('closed');
    expect(res.reason).toMatch(/stop-loss.*crossed/);
    expect(store[KEY_POSITION]).toBeNull();
  });

  it('does NOT hard-cap winners at any TP price (removed 2026-09-20)', async () => {
    // Regression: an earlier draft added a hard take-profit at 2× the
    // stop distance. Backtest on 164 historical trades showed this cost
    // -$18K vs stop-only because it capped fat-tail winners. TP was
    // removed; trailing-stop below handles winner ratcheting.
    // A big winner should NOT close as take-profit.
    const winnerPos = { ...pos, stopLossPrice: 64_740 };
    primeStore({
      [KEY_POSITION]: winnerPos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90);
    mockGetLivePrice.mockResolvedValue(70_000); // +7.7% winner, blows past any 1% TP

    const res = await PaperTrader.runTick(NOW + 3 * 60_000);
    // Winner triggers trailing-stop close (peak has surged), not TP.
    // The specific close path is trailing/hold/max-hold — never
    // "take-profit". Verify the string never appears.
    expect(res.reason ?? '').not.toMatch(/take-profit/);
  });
});

// ── Fix lock-ins (2026-09-18) ────────────────────────────────────────
// These tests exist to prevent regressions on the 6 bug fixes shipped
// in PRs #126-#131. Every fix here previously affected either real
// capital (regret, treasury) or the paper trader's own data integrity
// (concurrent-mode close, dashboard visibility).

describe('signal-flip close — STRONG_ skip symmetry (PR #130)', () => {
  // Bug: entry rejected STRONG_ signals (13% win rate historical) via
  // PAPER_SKIP_STRONG_SIGNALS filter, but signal-flip on the close path
  // accepted them as valid signal-flip triggers. A STRONG_ contrary
  // signal could force a close on a position that we would refuse to
  // open on if the same signal appeared fresh.
  const activeLong = {
    asset: 'BTC',
    side: 'LONG' as const,
    entryPrice: 65_000,
    size: 100_000 / 65_000,
    notionalUsd: 100_000,
    leverage: 1,
    openedAt: NOW,
    openFeeUsd: 65,
  };

  it('HOLDS through a STRONG_ contrary signal (skip-STRONG filter mirrored)', async () => {
    primeStore({
      [KEY_POSITION]: activeLong,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    // STRONG_HEDGE_SHORT is a strong contrary signal. Pre-fix behavior:
    // would close. Post-fix behavior: STRONG_ signals blocked by the
    // skip-STRONG filter on both entry AND close paths.
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_SHORT', 85);
    mockGetLivePrice.mockResolvedValue(64_800);

    const res = await PaperTrader.runTick(NOW + 5 * 60_000);
    expect(res.action).toBe('held');
    expect(store[KEY_POSITION]).toBeTruthy(); // still open
  });

  it('CLOSES on a moderate (non-STRONG) contrary signal — control case', async () => {
    // Sanity: without STRONG_ prefix, the flip closes as normal. Ensures
    // the test above is failing at STRONG_ specifically, not some other
    // path.
    primeStore({
      [KEY_POSITION]: activeLong,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_test',
    });
    stubSameAssetPrediction('BTC', 'HEDGE_SHORT', 70);
    mockGetLivePrice.mockResolvedValue(64_800);

    // Post-Fix-M (2026-09-26): flip-age gate raised 3min → 15min. Fire
    // between the flip gate (15) and the pinned MAX_HOLD (20) — 16min
    // hits the flip path cleanly.
    const res = await PaperTrader.runTick(NOW + 16 * 60_000);
    expect(res.action).toBe('closed');
    expect(res.reason).toMatch(/signal flipped/);
  });
});

describe('closeAtMark orderId passthrough (PR #127)', () => {
  // Bug: closeAtMark was reading orderId from KEY_ORDER_ID (legacy
  // single-position slot). In concurrent mode KEY_ORDER_ID is null
  // (migration cleared it), so the DB UPDATE that closed the row was
  // silently skipped — position closed in memory but hedges row stayed
  // status='active' forever. Fix: closeAtMark now uses the passed-in
  // orderId when provided.

  it('the atomic close UPDATE uses the passed orderId, not KEY_ORDER_ID', async () => {
    // Legacy-mode close path — the passed-in orderId comes from
    // KEY_ORDER_ID here; in concurrent mode it comes from the array
    // entry. Either way, if the UPDATE query params contain the correct
    // orderId, the bug is fixed.
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
    primeStore({
      [KEY_POSITION]: pos,
      [KEY_NAV]: PAPER_STARTING_NAV,
      [KEY_ORDER_ID]: 'paper_BTC_orderIdCheck',
    });
    stubSameAssetPrediction('BTC', 'STRONG_HEDGE_LONG', 90);
    mockGetLivePrice.mockResolvedValue(66_000);

    await PaperTrader.runTick(NOW + 25 * 60_000); // trip max-hold → close

    // Find the DB UPDATE mock call that closed the hedge. It uses SET
    // status = 'closed'; the 4th param ($4 in the SQL) is the orderId.
    const updateCall = (mockQuery.mock.calls as any[]).find(
      (call) => typeof call[0] === 'string' && /SET status = 'closed'/.test(call[0]),
    );
    expect(updateCall).toBeTruthy();
    // orderId is $4 in the SQL — index 3 in the params array. Position
    // shifted after a `category` param was added at the tail (2026-09-20
    // close-reason categorisation); assert by index rather than by
    // "last param" which is now `close_reason`.
    const params = updateCall![1] as any[];
    expect(params[3]).toBe('paper_BTC_orderIdCheck');
  });
});

describe('assetSideRecentPnl paper isolation (PR #131 sibling)', () => {
  // Bug: the LIVE trader's regret query (route.ts:340) was sampling
  // paper trades. This test locks in the paper-side counterpart —
  // assetSideRecentPnl inside PaperTrader.ts filters by
  // order_id LIKE 'paper_%' so the paper trader's regret cooldown
  // reads ONLY its own history, not the live trader's.

  it('the regret query filters by order_id LIKE paper_%', async () => {
    primeStore({});
    stubSignal('BTC', 'HEDGE_LONG', 80);
    // Return one row so the regret query gets exercised.
    mockQuery.mockResolvedValue([{ pnl: 0 }]);

    await PaperTrader.runTick(NOW);

    // Any SELECT touching the hedges table for regret data should
    // include the paper_% filter. Grep every SELECT the tick made.
    const selectCalls = (mockQuery.mock.calls as any[]).filter(
      (call) => typeof call[0] === 'string' && /SELECT/.test(call[0]) && /FROM hedges/.test(call[0]),
    );
    // At least one query hit the hedges table (the regret lookup).
    expect(selectCalls.length).toBeGreaterThan(0);
    // Every hedges SELECT this tick made must isolate paper rows.
    for (const call of selectCalls) {
      expect(call[0]).toMatch(/order_id LIKE 'paper_%'|simulation_mode\s*=\s*true/i);
    }
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
    stubSignal('BTC', 'HEDGE_LONG', 80);
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
    stubSignal('BTC', 'HEDGE_LONG', 80);
    mockGetLivePrice.mockResolvedValue(65_000);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/consecutive losses/);
    expect(mockCreateHedge).not.toHaveBeenCalled();
  });

  it('skips (asset, side) after recent losses cross regret-cooldown threshold', async () => {
    // Multiple queries fire before assetSideRecentPnl (Fix G shortWindow,
    // asset-streak, trend-misalignment); route by SQL text so the seeded
    // regret loss series only lands where assetSideRecentPnl reads it
    // (SELECT COALESCE(current_pnl, realized_pnl, 0) ...).
    mockQuery.mockImplementation(((sql: string) => {
      if (typeof sql === 'string' && /current_pnl.*realized_pnl.*AS pnl/i.test(sql)) {
        return Promise.resolve([
          { pnl: -800 },
          { pnl: -600 },
          { pnl: -500 },
          { pnl: -700 },
          { pnl: -500 },
        ]);
      }
      return Promise.resolve([]);
    }) as any);
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
    stubSignal('BTC', 'HEDGE_LONG', 80);
    stubPrice(65_000);

    const res = await PaperTrader.runTick(NOW);
    expect(res.action).toBe('opened');
    expect(mockCreateHedge).toHaveBeenCalledTimes(1);
    // Stats got re-anchored to today's peak.
    expect(store[KEY_STATS].dailyPeakDateUtc).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(store[KEY_STATS].dailyPeakNavUsd).toBe(94_000);
  });
});
