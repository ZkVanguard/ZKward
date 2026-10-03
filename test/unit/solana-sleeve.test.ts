/**
 * Sleeve trader: portfolio-margin sizing, entry gating, stop close,
 * stats + learning dispatch under the 'solana' namespace.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async (k: string) => state.get(k) ?? null),
  setCronState: jest.fn(async (k: string, v: unknown) => void state.set(k, v)),
}));

let mockMark = 100;
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getMultiSourceValidatedPrice: jest.fn(async () => ({ price: mockMark, sources: 3 })),
}));

let mockPreds: Record<string, unknown> = {};
jest.mock('@/lib/services/market-data/PredictionAggregatorService', () => ({
  PredictionAggregatorService: {
    getPerAssetPredictions: jest.fn(async () => mockPreds),
  },
}));

jest.mock('@/lib/services/ai/source-calibrator', () => ({
  normalizeSourceKey: (n: string) => n,
  recordSourceOutcome: jest.fn(async () => undefined),
}));

const createHedge = jest.fn(async () => ({}));
jest.mock('@/lib/db/hedges', () => ({ createHedge: (...a: unknown[]) => createHedge(...a) }));

const settle = jest.fn(async (): Promise<boolean | undefined> => undefined);
const learn = jest.fn(async () => undefined);
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({
  settleHedgeRow: (...a: unknown[]) => settle(...a),
  recordCloseLearning: (...a: unknown[]) => learn(...a),
}));

import { runSolanaSleeveTick } from '@/lib/services/solana/SolanaSleeveTrader';

const pred = (direction: string, confidence: number) => ({
  direction,
  confidence,
  sources: [{ name: 'src-x', type: 't', direction }],
});

describe('runSolanaSleeveTick', () => {
  beforeEach(() => {
    state.clear();
    mockPreds = {};
    mockMark = 100;
    delete process.env.SOLANA_SLEEVE_DISABLE;
    jest.clearAllMocks();
  });

  it('opens the highest-confidence directional signal, sized by portfolio margin with the $50 floor', async () => {
    mockPreds = { BTC: pred('UP', 72), ETH: pred('DOWN', 80), SOL: pred('NEUTRAL', 95) };
    const s = await runSolanaSleeveTick(11.4, 1_000_000); // NAV $11.40 → 30% = $3.42 → floor $50
    expect(s.action).toBe('opened');
    expect(s.targetNotionalUsd).toBe(50);
    const posState = state.get('solana-pool:sleeve-position') as {
      position: { asset: string; side: string; notionalUsd: number };
      stopLossPrice: number;
    };
    expect(posState.position.asset).toBe('ETH'); // 80 beats 72; NEUTRAL skipped
    expect(posState.position.side).toBe('SHORT');
    expect(posState.stopLossPrice).toBeCloseTo(100 * 1.025, 6); // SHORT stop above entry
    expect(createHedge).toHaveBeenCalledWith(
      expect.objectContaining({ portfolioId: -6, chain: 'solana-devnet', simulationMode: true }),
    );
  });

  it('caps sizing at the max-notional ceiling on a large NAV', async () => {
    mockPreds = { BTC: pred('UP', 75) };
    const s = await runSolanaSleeveTick(100_000, 1);
    expect(s.targetNotionalUsd).toBe(1000);
  });

  it('stays idle below the confidence floor', async () => {
    mockPreds = { BTC: pred('UP', 65), ETH: pred('DOWN', 69) };
    const s = await runSolanaSleeveTick(500, 1);
    expect(s.action).toBe('idle');
    expect(state.get('solana-pool:sleeve-position')).toBeUndefined();
  });

  it('holds an open position and tracks peak, then closes on stop with stats + solana-namespace learning', async () => {
    mockPreds = { BTC: pred('UP', 90) };
    mockMark = 100;
    await runSolanaSleeveTick(1000, 0); // opens BTC LONG @100, stop 97.5

    mockMark = 101; // profitable hold
    const held = await runSolanaSleeveTick(1000, 60_000);
    expect(held.action).toBe('held');

    mockMark = 97.4; // stop breach
    const closed = await runSolanaSleeveTick(1000, 120_000);
    expect(closed.action).toBe('closed');
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('stop-loss') }),
    );
    expect(learn).toHaveBeenCalledWith(
      expect.anything(),
      97.4,
      expect.any(Number),
      120_000,
      expect.objectContaining({ calibratorNamespace: 'solana' }),
    );
    const stats = state.get('solana-pool:sleeve-stats') as { trades: number; wins: number };
    expect(stats.trades).toBe(1);
    expect(stats.wins).toBe(0); // stopped out = loss
    expect(state.get('solana-pool:sleeve-position')).toBeNull();
  });

  it('closes at the max-hold ceiling', async () => {
    mockPreds = { SOL: pred('UP', 88) };
    await runSolanaSleeveTick(1000, 0);
    mockMark = 100.5;
    const closed = await runSolanaSleeveTick(1000, 241 * 60_000);
    expect(closed.action).toBe('closed');
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('max-hold') }),
    );
    const stats = state.get('solana-pool:sleeve-stats') as { trades: number; wins: number };
    expect(stats.wins).toBe(1); // small green close after fees? notional 300 @1x: gross=+1.5, fees 0.39+slip 0.06 → win
  });

  it('a close already settled by an overlapping tick is not counted again', async () => {
    mockPreds = { BTC: pred('UP', 90) };
    await runSolanaSleeveTick(1000, 0);
    mockMark = 97.4; // stop breach
    settle.mockResolvedValueOnce(false);
    const lost = await runSolanaSleeveTick(1000, 120_000);
    expect(lost.action).toBe('idle');
    expect(learn).not.toHaveBeenCalled();
    expect(state.get('solana-pool:sleeve-stats')).toBeUndefined();
    expect(state.get('solana-pool:sleeve-position')).toBeNull();
  });

  it('kill switch: SOLANA_SLEEVE_DISABLE=1 is a no-op', async () => {
    process.env.SOLANA_SLEEVE_DISABLE = '1';
    mockPreds = { BTC: pred('UP', 99) };
    const s = await runSolanaSleeveTick(1000, 1);
    expect(s.action).toBe('disabled');
  });
});
