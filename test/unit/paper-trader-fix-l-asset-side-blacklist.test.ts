/**
 * Fix L (2026-09-26) — asset-side lifetime win-rate blacklist.
 *
 * Verifies:
 *   1. Pairs below MIN_WR with enough n → blocked
 *   2. Cold pairs (n < MIN_N) → pass through
 *   3. Warm pairs above threshold → pass through
 *   4. Cache TTL respected (only 1 DB call inside window)
 *   5. Fail-open: DB error → returns null (allow)
 */
type QueryFn = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

process.env.PAPER_TRADER_ASSET_SIDE_BLACKLIST_MIN_WR = '0.40';
process.env.PAPER_TRADER_ASSET_SIDE_BLACKLIST_MIN_N = '20';
process.env.PAPER_TRADER_ASSET_SIDE_BLACKLIST_CACHE_TTL_MS = '1800000';

const mockQuery: jest.MockedFunction<QueryFn> = jest.fn();
jest.mock('../../lib/db/postgres', () => ({
  query: (...args: unknown[]) => (mockQuery as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));

import {
  assetSideBlacklistRejection,
  _resetAssetSideBlacklistCache,
} from '../../lib/services/paper-trader/asset-side-blacklist';

// Real-world sample rows from the 2026-09-26 audit
function stubStats() {
  mockQuery.mockResolvedValueOnce([
    { asset: 'BTC', side: 'LONG',  n: '114', wins: '30', pnl: '-24124.52' }, // 26% → blocked
    { asset: 'BTC', side: 'SHORT', n:  '36', wins:  '8', pnl: '-11182.55' }, // 22% → blocked
    { asset: 'ETH', side: 'LONG',  n:  '22', wins:  '9', pnl:  '-1512.06' }, // 41% → pass
    { asset: 'ETH', side: 'SHORT', n:  '70', wins: '23', pnl: '-20026.68' }, // 33% → blocked
    { asset: 'SOL', side: 'LONG',  n:  '32', wins: '11', pnl: '-13529.75' }, // 34% → blocked
    { asset: 'XRP', side: 'LONG',  n:  '33', wins: '15', pnl:    '285.21' }, // 45% → pass
    { asset: 'DOGE',side: 'SHORT', n:  '37', wins: '15', pnl:   '1454.39' }, // 41% → pass
    { asset: 'NEW', side: 'LONG',  n:   '5', wins:  '0', pnl:   '-100.00' }, // n<20 → pass (cold)
  ] as never);
}

describe('Fix L — asset-side lifetime blacklist', () => {
  beforeEach(() => {
    _resetAssetSideBlacklistCache();
    mockQuery.mockReset();
  });

  it('blocks BTC LONG (26% wr / n=114)', async () => {
    stubStats();
    const r = await assetSideBlacklistRejection('BTC', 'LONG');
    expect(r).toContain('BTC LONG');
    expect(r).toContain('26%');
  });

  it('blocks ETH SHORT (33% wr / n=70)', async () => {
    stubStats();
    const r = await assetSideBlacklistRejection('ETH', 'SHORT');
    expect(r).toContain('ETH SHORT');
  });

  it('passes XRP LONG (45% wr → above threshold)', async () => {
    stubStats();
    const r = await assetSideBlacklistRejection('XRP', 'LONG');
    expect(r).toBeNull();
  });

  it('passes DOGE SHORT (41% wr → above threshold)', async () => {
    stubStats();
    const r = await assetSideBlacklistRejection('DOGE', 'SHORT');
    expect(r).toBeNull();
  });

  it('passes cold pair (n < MIN_N) even if wr is 0', async () => {
    stubStats();
    const r = await assetSideBlacklistRejection('NEW', 'LONG');
    expect(r).toBeNull();
  });

  it('passes unknown pair (no data row at all)', async () => {
    stubStats();
    const r = await assetSideBlacklistRejection('UNKNOWN', 'SHORT');
    expect(r).toBeNull();
  });

  it('caches — 2nd call within TTL does not re-query DB', async () => {
    stubStats();
    await assetSideBlacklistRejection('BTC', 'LONG');
    await assetSideBlacklistRejection('ETH', 'SHORT');
    await assetSideBlacklistRejection('XRP', 'LONG');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('fail-open on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB timeout') as never);
    const r = await assetSideBlacklistRejection('BTC', 'LONG');
    expect(r).toBeNull();
  });
});
