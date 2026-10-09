/**
 * The sleeve with live execution switched on: the venue's fill and the
 * venue's result replace the simulated ones, and nothing is recorded that
 * the venue did not confirm.
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
jest.mock('@/lib/services/market-data/PredictionAggregatorService', () => ({
  PredictionAggregatorService: {
    getPerAssetPredictions: jest.fn(async () => ({ BTC: { direction: 'UP', confidence: 80, sources: [] } })),
  },
}));
jest.mock('@/lib/services/ai/source-calibrator', () => ({
  normalizeSourceKey: (n: string) => n,
  recordSourceOutcome: jest.fn(async () => undefined),
}));
const createHedge = jest.fn(async (_row: Record<string, unknown>) => ({}));
jest.mock('@/lib/db/hedges', () => ({ createHedge: (row: Record<string, unknown>) => createHedge(row) }));
const settle = jest.fn(async (_a: { result: { realizedPnlUsd: number; exitPrice: number } }): Promise<boolean | undefined> => undefined);
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({
  settleHedgeRow: (a: { result: { realizedPnlUsd: number; exitPrice: number } }) => settle(a),
  recordCloseLearning: jest.fn(async () => undefined),
}));
const notify = jest.fn(async (_m: string, _l: string, _c?: Record<string, unknown>) => undefined);
jest.mock('@/lib/utils/discord-notify', () => ({ notifyDiscord: (m: string, l: string, c?: Record<string, unknown>) => notify(m, l, c) }));

const live = {
  open: { ok: true, size: 0.5, entryPrice: 101, equityBeforeUsd: 400 } as Record<string, unknown>,
  close: { ok: true, realizedUsd: -1.25, exitPrice: 98 } as Record<string, unknown>,
  onVenue: true,
  untracked: [] as string[],
  block: null as string | null,
};
const openLive = jest.fn(async () => live.open);
const closeLive = jest.fn(async () => live.close);
const recordLiveOutcome = jest.fn(async () => ({ halted: false }));
jest.mock('@/lib/services/solana/sleeve-live', () => ({
  sleeveLiveEnabled: () => true,
  liveStatus: () => ({ enabled: true, network: 'testnet' }),
  liveEntryBlock: jest.fn(async () => live.block),
  liveHasPosition: jest.fn(async () => live.onVenue),
  flattenUntracked: jest.fn(async () => live.untracked),
  settledResult: jest.fn(async () => ({ realizedUsd: -7, exitPrice: 95 })),
  openLive: () => openLive(),
  closeLive: () => closeLive(),
  recordLiveOutcome: (r: number, n: number) => (recordLiveOutcome as unknown as (r: number, n: number) => Promise<{ halted: boolean }>)(r, n),
}));

import { runSolanaSleeveTick } from '@/lib/services/solana/SolanaSleeveTrader';

const POSITION = 'solana-pool:sleeve-position';
const T0 = 1_000_000;

beforeEach(() => {
  state.clear();
  jest.clearAllMocks();
  mockMark = 100;
  Object.assign(live, {
    open: { ok: true, size: 0.5, entryPrice: 101, equityBeforeUsd: 400 },
    close: { ok: true, realizedUsd: -1.25, exitPrice: 98 },
    onVenue: true,
    untracked: [],
    block: null,
  });
  state.set('feedback-loop:verdicts', { version: 1, cells: { 'aggregate|BTC': { verdict: 'proven' } }, families: {} });
});

describe('live entry', () => {
  it('the position is the venue fill: its price, its size, a real row', async () => {
    const s = await runSolanaSleeveTick(10_000, T0);
    expect(s.action).toBe('opened');
    expect(s.detail).toContain('LIVE');
    const stored = state.get(POSITION) as { position: { entryPrice: number; notionalUsd: number }; live: { equityBeforeUsd: number }; stopLossPrice: number };
    expect(stored.position.entryPrice).toBe(101);
    expect(stored.position.notionalUsd).toBeCloseTo(50.5, 6);
    expect(stored.live).toEqual({ equityBeforeUsd: 400 });
    expect(stored.stopLossPrice).toBeCloseTo(101 * 0.975, 6);
    expect(createHedge.mock.calls[0][0]).toMatchObject({ simulationMode: false, chain: 'solana-perps-testnet', entryPrice: 101 });
    expect(notify.mock.calls[0][2]).toMatchObject({ chain: 'solana' });
  });

  it('no fill, no position; an order left out is alerted', async () => {
    live.open = { ok: false, sent: true, reason: 'BTC order was accepted but no position appeared' };
    const s = await runSolanaSleeveTick(10_000, T0);
    expect(s.action).toBe('idle');
    expect(state.get(POSITION)).toBeUndefined();
    expect(createHedge).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('no position appeared'), 'ERROR', expect.anything());
  });

  it('a guard block or an untracked venue position opens nothing', async () => {
    live.block = 'live daily loss cap reached ($-25.00)';
    expect((await runSolanaSleeveTick(10_000, T0)).detail).toContain('daily loss cap');
    live.block = null;
    live.untracked = ['SOL LONG 0.9'];
    expect((await runSolanaSleeveTick(10_000, T0)).detail).toContain('untracked');
    expect(openLive).not.toHaveBeenCalled();
  });
});

describe('live close', () => {
  const openPosition = async () => {
    await runSolanaSleeveTick(10_000, T0);
    jest.clearAllMocks();
  };

  it('the result recorded is the venue result, not the simulated one', async () => {
    await openPosition();
    mockMark = 90; // through the 2.5% stop
    const s = await runSolanaSleeveTick(10_000, T0 + 60_000);
    expect(s.action).toBe('closed');
    expect(settle.mock.calls[0][0].result).toMatchObject({ realizedPnlUsd: -1.25, exitPrice: 98 });
    expect(recordLiveOutcome).toHaveBeenCalledWith(-1.25, T0 + 60_000);
    expect(state.get(POSITION)).toBeNull();
  });

  it('a close the venue did not confirm keeps the position and alerts', async () => {
    await openPosition();
    mockMark = 90;
    live.close = { ok: false, reason: 'BTC close was accepted but the position is still on the venue' };
    const s = await runSolanaSleeveTick(10_000, T0 + 60_000);
    expect(s.action).toBe('held');
    expect(state.get(POSITION)).toBeTruthy();
    expect(settle).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('did not complete'), 'ERROR', expect.anything());
  });

  it('a position that left the venue is settled from equity without sending an order', async () => {
    await openPosition();
    live.onVenue = false;
    const s = await runSolanaSleeveTick(10_000, T0 + 60_000);
    expect(s.action).toBe('closed');
    expect(s.detail).toContain('closed on the venue');
    expect(closeLive).not.toHaveBeenCalled();
    expect(settle.mock.calls[0][0].result).toMatchObject({ realizedPnlUsd: -7, exitPrice: 95 });
  });
});
