/**
 * Fix K (2026-09-26) — calibrated-probability ranking + fee-adjusted gate.
 *
 * Behavior locked:
 *   1. When two candidates have similar raw scores but different calibrated
 *      win rates, the higher-calibrated one is picked.
 *   2. Fee-adjusted gate (default 53%) rejects sub-breakeven candidates
 *      even if raw confidence is high.
 *   3. Cold buckets (n < min-N) fall back to raw score ranking.
 */
process.env.PAPER_TRADER_MAX_CONCURRENT = '2'; // concurrency path exercises ranking
process.env.PAPER_TRADER_CALIBRATED_MIN_WIN_RATE = '0.53';
process.env.PAPER_TRADER_CALIBRATED_RANK_MIN_N = '5';
process.env.PAPER_TRADER_MIN_CONFIDENCE = '55'; // low so we don't gate on raw conf here

const cronStateStore = new Map<string, unknown>();
const mockGetCronStateOr = jest.fn(async <T,>(k: string, def: T): Promise<T> => (cronStateStore.get(k) as T | undefined) ?? def);
const mockGetCronState = jest.fn(async <T,>(k: string): Promise<T | null> => (cronStateStore.get(k) as T | null) ?? null);
const mockSetCronState = jest.fn(async () => undefined);

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: (...args: unknown[]) => (mockGetCronState as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  getCronStateOr: (...args: unknown[]) => (mockGetCronStateOr as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  setCronState: (...args: unknown[]) => (mockSetCronState as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));

const mockScanAndPickBest = jest.fn();
jest.mock('@/lib/services/market-data/PredictionAggregatorService', () => ({
  PredictionAggregatorService: {
    scanAndPickBest: (...args: unknown[]) => (mockScanAndPickBest as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
    scoreOpportunity: (pred: { confidence: number }) => pred.confidence,
  },
}));

// Regime + signal-quality + bandit stubs — non-blocking pass-throughs.
jest.mock('../../lib/services/paper-trader/regime', () => ({
  getCurrentRegime: async () => ({ regime: 'trending' }),
  getRegimeMultipliers: () => ({ minConfidenceMult: 1.0 }),
}));
jest.mock('../../lib/services/paper-trader/bandit', () => ({
  getArmMultiplier: async () => 1,
}));
jest.mock('../../lib/services/paper-trader/signal-quality', () => ({
  signalQualityRejection: async () => null,
  appendSignalHistory: async () => undefined,
}));

import { selectCandidate } from '../../lib/services/paper-trader/entry-helpers';

// Helper: seed the calibrator bucket for (asset, side, conf-decile).
function seedCalibrator(asset: string, side: 'LONG' | 'SHORT', confDecile: number, n: number, wins: number) {
  cronStateStore.set(`trader:calibration:${asset}:${side}:${confDecile}`, { n, wins, updatedAt: 0 });
}

function stubSignal(rec: { asset: string; recommendation: string; confidence: number; consensus?: number; sourcesCount?: number }[]) {
  const all: Record<string, unknown> = {};
  for (const r of rec) {
    const dir = r.recommendation.includes('LONG') ? 'UP' : r.recommendation.includes('SHORT') ? 'DOWN' : 'NEUTRAL';
    all[r.asset] = {
      asset: r.asset,
      recommendation: r.recommendation,
      direction: dir,
      confidence: r.confidence,
      consensus: r.consensus ?? 75,
      sources: Array.from({ length: r.sourcesCount ?? 4 }, () => ({ direction: dir, weight: 0.25 })),
    };
  }
  mockScanAndPickBest.mockResolvedValue({ best: all[rec[0].asset], all });
}

describe('Fix K — calibrated-probability ranking + fee-adjusted gate', () => {
  beforeEach(() => {
    cronStateStore.clear();
    mockGetCronState.mockClear();
    mockSetCronState.mockClear();
  });

  it('picks the higher-calibrated candidate when raw scores are close', async () => {
    // BTC raw conf 70 (bucket 7), 70 wins / 100 → calibrated 70.2%
    // ETH raw conf 72 (bucket 7), 55 wins / 100 → calibrated 56.6%
    // Both above 53% gate; both would trade under old code, but ranking
    // by calibrated (not raw) picks BTC. Old code preferred ETH (raw 72 > 70).
    seedCalibrator('BTC', 'LONG', 7, 100, 70); // → 70.2%
    seedCalibrator('ETH', 'LONG', 7, 100, 55); // → 56.6%
    stubSignal([
      { asset: 'ETH', recommendation: 'HEDGE_LONG', confidence: 72 },
      { asset: 'BTC', recommendation: 'HEDGE_LONG', confidence: 70 },
    ]);
    const filter = { rejectionReason: () => null };
    const r = await selectCandidate(Date.now(), filter);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.picked.asset).toBe('BTC');
  });

  it('rejects a candidate below the fee-adjusted 53% threshold', async () => {
    // n=100 wins=45 → 45% empirical. Calibrator PRIOR=10 shrinks toward
    // raw 72% but empirical dominates at this n:
    //   (100 * 0.45 + 10 * 0.72) / 110 = 0.474 → below 0.53 → skip.
    seedCalibrator('SOL', 'SHORT', 7, 100, 45);
    stubSignal([{ asset: 'SOL', recommendation: 'HEDGE_SHORT', confidence: 72 }]);
    const filter = { rejectionReason: () => null };
    const r = await selectCandidate(Date.now(), filter);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('calibrator');
  });

  it('accepts a candidate at or above the fee-adjusted threshold', async () => {
    // n=100 wins=60 → calibrated 61.1% > 53% → pass.
    seedCalibrator('XRP', 'LONG', 7, 100, 60);
    stubSignal([{ asset: 'XRP', recommendation: 'HEDGE_LONG', confidence: 72 }]);
    const filter = { rejectionReason: () => null };
    const r = await selectCandidate(Date.now(), filter);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.picked.asset).toBe('XRP');
  });

  it('cold bucket (n < min-N) falls back to raw ranking, no calibrator gate', async () => {
    // Only 3 samples for this bucket → below MIN_N; raw conf dominates.
    seedCalibrator('DOGE', 'LONG', 7, 3, 0); // 0% wr but n too small to trust
    stubSignal([{ asset: 'DOGE', recommendation: 'HEDGE_LONG', confidence: 78 }]);
    const filter = { rejectionReason: () => null };
    const r = await selectCandidate(Date.now(), filter);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.picked.asset).toBe('DOGE');
  });
});
