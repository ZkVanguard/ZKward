/**
 * Contract tests for the shared close pipeline (audit R3 extraction).
 * Pins the settlement SQL shape so the consuming books cannot silently
 * diverge again.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const queryMock = jest.fn(async () => [] as unknown[]);
jest.mock('@/lib/db/postgres', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import {
  categorizeCloseReason,
  settleHedgeRow,
} from '@/lib/services/paper-trader/close-pipeline';
import type { SimulatedPosition, SimulatedCloseResult } from '@/lib/services/paper-trader/simulated-executor';

const pos = (over: Partial<SimulatedPosition> = {}): SimulatedPosition => ({
  asset: 'BTC',
  side: 'LONG',
  entryPrice: 100,
  size: 10,
  notionalUsd: 1000,
  leverage: 1,
  openedAt: 0,
  openFeeUsd: 0.65,
  slippageOpenUsd: 0.1,
  peakUnrealizedPnl: 12,
  troughUnrealizedPnl: -4,
  sourceSnapshot: [
    { key: 'src-a', direction: 'UP' },
    { key: 'src-b', direction: 'DOWN' },
  ],
  entryConfidence: 72,
  ...over,
});

const result = (over: Partial<SimulatedCloseResult> = {}): SimulatedCloseResult => ({
  asset: 'BTC',
  side: 'LONG',
  entryPrice: 100,
  exitPrice: 105,
  notionalUsd: 1000,
  size: 10,
  holdSeconds: 600,
  grossPnlUsd: 50,
  openFeeUsd: 0.65,
  closeFeeUsd: 0.65,
  slippageUsd: 0.2,
  fundingUsd: -0.01,
  realizedPnlUsd: 48.49,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('categorizeCloseReason', () => {
  it.each([
    ['stop-loss hit at x', 'stop-loss'],
    ['trailing-stop fired', 'trailing-stop'],
    ['underwater-tighten trip', 'underwater-tighten'],
    ['max-hold ceiling', 'max-hold'],
    ['signal flipped to SHORT', 'signal-flip'],
    ['LIQUIDATION price crossed', 'liquidation'],
    ['horizon-expiry', 'horizon-expiry'],
    ['daily halt engaged', 'halt'],
    ['floor-rebalance', 'rebalance'],
    ['manual', 'other'],
  ])('%s → %s', (raw, want) => expect(categorizeCloseReason(raw)).toBe(want));
});

describe('settleHedgeRow', () => {
  it('one atomic UPDATE with analytics meta, funding, categorized reason', async () => {
    await settleHedgeRow({ orderId: 'oid-1', pos: pos(), result: result(), reason: 'stop-loss hit', nav: 100_000 });
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE hedges/);
    expect(sql).toMatch(/status <> 'closed'/);
    expect(sql).toMatch(/funding_paid = \$2/);
    expect(params[0]).toBe(48.49);            // realized
    expect(params[1]).toBe(-0.01);            // funding
    expect(params[3]).toBe('oid-1');
    expect(params[5]).toBe('stop-loss');      // category
    const meta = JSON.parse(params[4] as string);
    expect(meta).toMatchObject({
      mfeUsd: 12,
      maeUsd: -4,
      actualDir: 'UP',
      slippageUsd: 0.2,
      exitReason: 'stop-loss hit',
    });
    expect(meta.mfePctOfNav).toBeCloseTo(12 / 100_000, 10);
    expect(meta.attribution).toEqual([
      { key: 'src-a', dir: 'UP', wasCorrect: true },
      { key: 'src-b', dir: 'DOWN', wasCorrect: false },
    ]);
  });

  it('analytics:false + extraMeta (oracle shape) skips mfe block, keeps slippage', async () => {
    await settleHedgeRow({
      orderId: 'oid-2', pos: pos(), result: result(), reason: 'horizon-expiry',
      analytics: false, extraMeta: { uncertain: true, slug: 'btc-above-80k' },
    });
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    const meta = JSON.parse(params[4] as string);
    expect(meta).toEqual({
      slippageUsd: 0.2, exitReason: 'horizon-expiry', uncertain: true, slug: 'btc-above-80k',
    });
    expect(params[5]).toBe('horizon-expiry');
  });

  it('a database error throws, so the book keeps the position instead of counting an unrecorded close', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      settleHedgeRow({ orderId: 'oid-3', pos: pos(), result: result(), reason: 'x' }),
    ).rejects.toThrow('boom');
  });

  it('reports false when an overlapping tick already closed the row', async () => {
    queryMock.mockResolvedValueOnce([{ updated: 0, present: true }]);
    await expect(
      settleHedgeRow({ orderId: 'oid-4', pos: pos(), result: result(), reason: 'max-hold expired' }),
    ).resolves.toBe(false);
  });

  it('reports true when this call closed the row, or there is no row at all', async () => {
    queryMock.mockResolvedValueOnce([{ updated: 1, present: true }]);
    await expect(
      settleHedgeRow({ orderId: 'oid-5', pos: pos(), result: result(), reason: 'x' }),
    ).resolves.toBe(true);
    queryMock.mockResolvedValueOnce([{ updated: 0, present: false }]);
    await expect(
      settleHedgeRow({ orderId: 'oid-6', pos: pos(), result: result(), reason: 'x' }),
    ).resolves.toBe(true);
  });
});
