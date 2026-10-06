/**
 * The lead book exists to answer one question honestly: does one source's
 * 4-hour call make money after execution costs. These tests hold it to the
 * rules that keep that answer honest: it enters only on a fresh reading, a
 * resting order fills only on a trade-through, the exit is a market order at
 * the reading's horizon, and a close someone else settled counts for nothing.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async (k: string) => (state.has(k) ? state.get(k) : null)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown[]>>();
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, params: unknown[]) => query(sql, params) }));
const createHedge = jest.fn(async (_: Record<string, unknown>) => {});
jest.mock('@/lib/db/hedges', () => ({ createHedge: (a: Record<string, unknown>) => createHedge(a) }));
const settleHedgeRow = jest.fn<(a: Record<string, unknown>) => Promise<boolean>>();
jest.mock('@/lib/services/paper-trader/close-pipeline', () => ({ settleHedgeRow: (a: Record<string, unknown>) => settleHedgeRow(a) }));
const prices: Record<string, number | null> = {};
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getMultiSourceValidatedPrice: async (asset: string) => ({ price: prices[asset] ?? 0 }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { LeadTrader, selectLeadEntries, LEAD_PORTFOLIO_ID, type LeadReading } from '@/lib/services/paper-trader/LeadTrader';
import { restingFilled } from '@/lib/services/paper-trader/simulated-executor';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const MIN = 60_000;
const reading = (over: Partial<LeadReading> = {}): LeadReading => ({
  source: 'short_term:kalshi-btc', asset: 'BTC', direction: 'UP', entry_price: 85_000, reading_at_ms: NOW - 30_000, ...over,
});
/** A mark that has traded through a buy limit by more than the asset's allowance. */
const through = (limit: number, side: 'buy' | 'sell') => (side === 'buy' ? limit * 0.99 : limit * 1.01);
const POSITIONS = 'lead-trader:active-positions';
const RESTING = 'lead-trader:resting-entries';
const STATS = 'lead-trader:stats';

beforeEach(() => {
  jest.clearAllMocks();
  state.clear();
  for (const k of Object.keys(prices)) delete prices[k];
  query.mockResolvedValue([]);
  settleHedgeRow.mockResolvedValue(true);
});

describe('selectLeadEntries', () => {
  it('takes a fresh reading for a traded asset, in its direction', () => {
    expect(selectLeadEntries([reading()], NOW, new Set())).toEqual([{ reading: reading(), side: 'LONG' }]);
    expect(selectLeadEntries([reading({ direction: 'DOWN' })], NOW, new Set())[0].side).toBe('SHORT');
  });

  it('ignores assets the books do not trade, and assets it is already in', () => {
    expect(selectLeadEntries([reading({ asset: 'XRP' }), reading({ asset: 'SOL' })], NOW, new Set())).toEqual([]);
    expect(selectLeadEntries([reading()], NOW, new Set(['BTC']))).toEqual([]);
  });

  it('ignores a stale reading: resting an order at an old price is a different trade', () => {
    expect(selectLeadEntries([reading({ reading_at_ms: NOW - 6 * MIN })], NOW, new Set())).toEqual([]);
    expect(selectLeadEntries([reading({ reading_at_ms: NOW + MIN })], NOW, new Set())).toEqual([]);
  });

  it('ignores a reading with no direction or no price', () => {
    for (const bad of [{ direction: 'NEUTRAL' }, { direction: '' }, { entry_price: 0 }, { entry_price: NaN }]) {
      expect(selectLeadEntries([reading(bad)], NOW, new Set())).toEqual([]);
    }
  });

  it('with several readings for one asset, takes the newest, and one per asset', () => {
    const picked = selectLeadEntries(
      [reading({ reading_at_ms: NOW - 3 * MIN, direction: 'DOWN' }), reading({ reading_at_ms: NOW - MIN }), reading({ asset: 'ETH', source: 'short_term:kalshi-eth', entry_price: 2_700 })],
      NOW,
      new Set(),
    );
    expect(picked.map((p) => `${p.reading.asset}:${p.side}`).sort()).toEqual(['BTC:LONG', 'ETH:LONG']);
  });
});

describe('entry', () => {
  it('a fresh reading places a resting order at the reading’s price and opens nothing yet', async () => {
    query.mockResolvedValue([reading()]);
    const s = await LeadTrader.runTick(NOW);
    expect(s).toMatchObject({ placed: 1, filled: 0, active: 0, resting: 1 });
    expect(createHedge).not.toHaveBeenCalled();
    const [entry] = state.get(RESTING) as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({ asset: 'BTC', side: 'LONG', limitPrice: 85_000, readingAtMs: NOW - 30_000 });
  });

  it('reads only the configured source and horizon, newer than the watermark', async () => {
    state.set('lead-trader:reading-watermark', NOW - 90_000);
    await LeadTrader.runTick(NOW);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('window_end_time - horizon_min * 60000');
    expect(sql).not.toContain('observed_at');
    expect(params).toEqual(['%kalshi%', 240, NOW - 90_000]);
  });

  it('a touch is not a fill: the order keeps resting until the mark trades through it', async () => {
    query.mockResolvedValueOnce([reading()]);
    await LeadTrader.runTick(NOW);
    prices.BTC = 85_000; // at the limit, not through it
    expect(restingFilled('buy', 85_000, 85_000, 'BTC')).toBe(false);
    const s = await LeadTrader.runTick(NOW + MIN);
    expect(s).toMatchObject({ filled: 0, resting: 1, active: 0 });
    expect(createHedge).not.toHaveBeenCalled();
  });

  it('a trade-through fills at the order’s own price, at the maker fee, with no slippage', async () => {
    query.mockResolvedValueOnce([reading()]);
    await LeadTrader.runTick(NOW);
    prices.BTC = through(85_000, 'buy');
    const s = await LeadTrader.runTick(NOW + 2 * MIN);
    expect(s).toMatchObject({ filled: 1, resting: 0, active: 1 });
    expect(createHedge).toHaveBeenCalledTimes(1);
    expect(createHedge.mock.calls[0][0]).toMatchObject({
      portfolioId: LEAD_PORTFOLIO_ID, asset: 'BTC', side: 'LONG', entryPrice: 85_000, notionalValue: 1000, leverage: 1, simulationMode: true, chain: 'hedera-testnet',
    });
    const [pos] = state.get(POSITIONS) as Array<{ position: { entryPrice: number; openFeeUsd: number; slippageOpenUsd: number }; closeAtMs: number }>;
    expect(pos.position.entryPrice).toBe(85_000); // never a better price than the order's
    expect(pos.position.slippageOpenUsd).toBe(0);
    expect(pos.position.openFeeUsd).toBeLessThan(0.3); // maker: about a tenth of the taker fee on $1,000
    // the hold runs from the reading, as the ledger measures it, not from the fill
    expect(pos.closeAtMs).toBe(NOW - 30_000 + 240 * MIN);
  });

  it('a short fills only when the mark trades up through its price', async () => {
    query.mockResolvedValueOnce([reading({ direction: 'DOWN' })]);
    await LeadTrader.runTick(NOW);
    prices.BTC = 84_000;
    expect((await LeadTrader.runTick(NOW + MIN)).filled).toBe(0);
    prices.BTC = through(85_000, 'sell');
    expect((await LeadTrader.runTick(NOW + 2 * MIN)).filled).toBe(1);
  });

  it('an order not filled within the wait is cancelled', async () => {
    query.mockResolvedValueOnce([reading()]);
    await LeadTrader.runTick(NOW);
    prices.BTC = 85_500;
    const s = await LeadTrader.runTick(NOW + 16 * MIN);
    expect(s).toMatchObject({ cancelled: 1, resting: 0, active: 0 });
    expect(createHedge).not.toHaveBeenCalled();
  });

  it('with no trustworthy price the order neither fills nor opens', async () => {
    query.mockResolvedValueOnce([reading()]);
    await LeadTrader.runTick(NOW);
    prices.BTC = null;
    expect(await LeadTrader.runTick(NOW + MIN)).toMatchObject({ filled: 0, resting: 1 });
  });

  it('while in an asset, a new reading for it places nothing', async () => {
    query.mockResolvedValueOnce([reading()]);
    await LeadTrader.runTick(NOW);
    query.mockResolvedValueOnce([reading({ reading_at_ms: NOW + 30_000, direction: 'DOWN' })]);
    const s = await LeadTrader.runTick(NOW + MIN);
    expect(s.placed).toBe(0);
    expect((state.get(RESTING) as unknown[]).length).toBe(1);
  });

  it('if the row cannot be written, no untracked position is kept', async () => {
    query.mockResolvedValueOnce([reading()]);
    await LeadTrader.runTick(NOW);
    createHedge.mockRejectedValueOnce(new Error('db down'));
    prices.BTC = through(85_000, 'buy');
    const s = await LeadTrader.runTick(NOW + MIN);
    expect(s).toMatchObject({ filled: 0, active: 0, resting: 0 });
  });
});

describe('exit', () => {
  const open = async () => {
    query.mockResolvedValueOnce([reading()]);
    await LeadTrader.runTick(NOW);
    prices.BTC = through(85_000, 'buy');
    await LeadTrader.runTick(NOW + MIN);
    return (state.get(POSITIONS) as Array<{ orderId: string; closeAtMs: number }>)[0];
  };

  it('holds to the horizon: no target, no stop, whatever the price does', async () => {
    await open();
    for (const p of [95_000, 70_000]) {
      prices.BTC = p;
      expect((await LeadTrader.runTick(NOW + 120 * MIN)).closed).toBe(0);
    }
    expect(settleHedgeRow).not.toHaveBeenCalled();
  });

  it('closes at the horizon as a market order, settle-first, and records the result', async () => {
    const pos = await open();
    prices.BTC = 85_850; // +1%
    const s = await LeadTrader.runTick(pos.closeAtMs + 1);
    expect(s).toMatchObject({ closed: 1, active: 0 });
    const args = settleHedgeRow.mock.calls[0][0] as { orderId: string; reason: string; result: { exitPrice: number; closeFeeUsd: number; slippageUsd: number; realizedPnlUsd: number } };
    expect(args).toMatchObject({ orderId: pos.orderId, reason: 'horizon-expiry' });
    expect(args.result.exitPrice).toBe(85_850);
    expect(args.result.closeFeeUsd).toBeGreaterThan(0.5); // taker fee on $1,000, not the maker fee
    expect(args.result.slippageUsd).toBeGreaterThan(0);
    expect(args.result.realizedPnlUsd).toBeLessThan(10); // +1% of $1,000 less costs
    expect(args.result.realizedPnlUsd).toBeGreaterThan(8);
    expect(state.get(STATS)).toMatchObject({ trades: 1, wins: 1, placed: 1, filled: 1 });
  });

  it('a close another tick already settled drops the position and counts nothing', async () => {
    const pos = await open();
    settleHedgeRow.mockResolvedValueOnce(false);
    prices.BTC = 90_000;
    const s = await LeadTrader.runTick(pos.closeAtMs + 1);
    expect(s).toMatchObject({ closed: 0, active: 0 });
    expect((state.get(STATS) as { trades: number }).trades).toBe(0);
  });

  it('with no trustworthy price at the horizon it keeps the position and tries again', async () => {
    const pos = await open();
    prices.BTC = null;
    expect(await LeadTrader.runTick(pos.closeAtMs + 1)).toMatchObject({ closed: 0, active: 1 });
    prices.BTC = 85_000;
    expect(await LeadTrader.runTick(pos.closeAtMs + MIN)).toMatchObject({ closed: 1, active: 0 });
  });
});

describe('isolation', () => {
  it('uses its own portfolio id and never one a live pool or another book uses', () => {
    expect(LEAD_PORTFOLIO_ID).toBe(-7);
  });

  it('a failed ledger read places nothing and does not disturb open positions', async () => {
    state.set(POSITIONS, [{ orderId: 'lead_BTC_1', position: { asset: 'BTC' }, closeAtMs: NOW + 60 * MIN, source: 's' }]);
    query.mockRejectedValueOnce(new Error('db down'));
    const s = await LeadTrader.runTick(NOW);
    expect(s).toMatchObject({ placed: 0, active: 1 });
  });
});
