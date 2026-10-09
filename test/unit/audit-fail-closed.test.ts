/**
 * Three reads that used to answer "nothing there" when the truth was "could
 * not tell" or "already done": a halt read on a failed store, a venue order
 * that exists but did not fill, and a hedge row that is already closed.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const query = jest.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>();
const queryOne = jest.fn<(sql: string, params?: unknown[]) => Promise<unknown>>();
jest.mock('@/lib/db/postgres', () => ({ query, queryOne }));
jest.mock('@/lib/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const recordPnlCredit = jest.fn(async () => undefined);
jest.mock('@/lib/db/treasury', () => ({ recordPnlCredit }));

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  recordPnlCredit.mockClear();
});

describe('getCronHalt', () => {
  it('returns a short halt when the store cannot be read', async () => {
    query.mockResolvedValue([]);
    queryOne.mockRejectedValue(new Error('connection refused'));
    const { getCronHalt } = await import('@/lib/db/cron-state');
    const now = 1_000_000;
    const halt = await getCronHalt('sui-community-pool', now);
    expect(halt).toEqual({ untilMs: now + 60_000, reason: 'db-read-failed' });
  });

  it('returns no halt when the key is not set', async () => {
    query.mockResolvedValue([]);
    queryOne.mockResolvedValue(null);
    const { getCronHalt } = await import('@/lib/db/cron-state');
    expect(await getCronHalt('sui-community-pool', 1_000_000)).toBeNull();
  });
});

describe('closeHedge', () => {
  it('credits nothing when the row was already closed', async () => {
    query.mockResolvedValue([]);
    const { closeHedge } = await import('@/lib/db/hedges');
    await closeHedge('order-1', 12.5);
    expect(String(query.mock.calls[0][0])).toContain("status NOT IN ('closed', 'liquidated')");
    expect(recordPnlCredit).not.toHaveBeenCalled();
  });

  it('credits once when it settles the row', async () => {
    query.mockResolvedValue([{ id: 7 }]);
    const { closeHedge } = await import('@/lib/db/hedges');
    await closeHedge('order-2', 12.5);
    expect(recordPnlCredit).toHaveBeenCalledTimes(1);
  });
});

describe('performOpenHedge idempotency match', () => {
  const ctx = (match: Record<string, unknown>) => ({
    walletAddress: '0xabc',
    network: 'mainnet',
    apiRequest: jest.fn(async (method: string, path: string) => {
      if (path.includes('/account')) return { canTrade: true };
      if (method === 'GET' && path.includes('/trade/orders')) return [match];
      throw new Error(`unexpected venue call: ${method} ${path}`);
    }),
  });
  const params = { symbol: 'BTC-PERP', side: 'LONG' as const, size: 0.01, leverage: 2, clientOrderId: 'polyedge_BTC_1' };

  it('is not a fill when the venue reports none, and is not resubmitted', async () => {
    const { performOpenHedge } = await import('@/lib/services/sui/bluefin/open-hedge-impl');
    const c = ctx({ clientOrderId: 'polyedge_BTC_1', orderHash: '0xhash', status: 'CANCELLED' });
    const result = await performOpenHedge(c as never, params);
    expect(result.success).toBe(false);
    expect(c.apiRequest.mock.calls.some(([m]) => m === 'POST')).toBe(false);
  });

  it('reports the venue fill, never the requested size', async () => {
    const { performOpenHedge } = await import('@/lib/services/sui/bluefin/open-hedge-impl');
    const c = ctx({ clientOrderId: 'polyedge_BTC_1', orderHash: '0xhash', status: 'FILLED', filledQty: '0.004', avgFillPrice: '60000' });
    const result = await performOpenHedge(c as never, params);
    expect(result.success).toBe(true);
    expect(result.filledSize).toBe(0.004);
  });
});
