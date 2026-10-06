/**
 * "The venue could not be read" and "the venue has no positions" are
 * different facts. Code that acts on positions must be given the first as an
 * error. These tests cover the close path, where an unreadable venue used to
 * be reported as a completed close, and pin the acting call sites to the
 * strict read.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('@/lib/utils/discord-notify', () => ({ notifyDiscord: jest.fn(async () => {}) }));
const closePerpHedgeBySymbolSide = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/db/hedges', () => ({ closePerpHedgeBySymbolSide: (...a: unknown[]) => closePerpHedgeBySymbolSide(...a) }));
jest.mock('@/lib/services/market-data/RealMarketDataService', () => ({
  getMarketDataService: () => ({ getTokenPrice: async () => ({ price: 1.2 }) }),
}));
jest.mock('@/lib/services/sui/BluefinService', () => ({
  BLUEFIN_PAIRS: { 'SUI-PERP': { stepSize: 1, minQuantity: 1 } },
  BLUEFIN_NETWORKS: { mainnet: { idsId: 'ids' }, testnet: { idsId: 'ids' } },
}));

import { performCloseHedge, type CloseHedgeContext } from '@/lib/services/sui/bluefin/close-hedge-impl';

const POSITION = { symbol: 'SUI-PERP', side: 'LONG' as const, size: 10, leverage: 3, entryPrice: 1, markPrice: 1.2, liquidationPrice: 0, unrealizedPnl: 2, margin: 4, marginRatio: 0.05 };

function makeCtx(reads: Array<'fail' | 'open' | 'gone'>): { ctx: CloseHedgeContext; orders: unknown[]; readCount: () => number } {
  const orders: unknown[] = [];
  let i = 0;
  const ctx: CloseHedgeContext = {
    walletAddress: '0xabc',
    network: 'mainnet',
    apiRequest: (async (_m: string, _p: string, body: unknown) => {
      orders.push(body);
      // accepted, but the response carries no fill and no realized P&L: only the position delta can confirm it
      return { orderHash: '0xhash' };
    }) as CloseHedgeContext['apiRequest'],
    getPositions: async () => {
      const r = reads[Math.min(i, reads.length - 1)];
      i++;
      if (r === 'fail') throw new Error('venue unreachable');
      return r === 'open' ? [POSITION] : [];
    },
    getMarketData: async () => ({ price: 1.2, fundingRate: 0 }),
    signOrder: async () => 'sig',
  };
  return { ctx, orders, readCount: () => i };
}

beforeEach(() => jest.clearAllMocks());

describe('closing a venue position', () => {
  it('an unreadable venue before the order: nothing is sent and the close is not reported done', async () => {
    const { ctx, orders } = makeCtx(['fail']);
    const r = await performCloseHedge(ctx, { symbol: 'SUI-PERP' });
    expect(r.success).toBe(false);
    expect(orders.length).toBe(0);
    expect(closePerpHedgeBySymbolSide).not.toHaveBeenCalled();
  });

  it('an unreadable venue AFTER the order is not "the position is gone": the close is not reported done', async () => {
    // read 1 finds the position; every verification read fails
    const { ctx, orders, readCount } = makeCtx(['open', 'fail']);
    const r = await performCloseHedge(ctx, { symbol: 'SUI-PERP' });
    expect(orders.length).toBe(1);
    expect(readCount()).toBeGreaterThan(5); // it kept polling
    expect(r.success).toBe(false);
    // "we could not look" is not a venue rejection: no code, so nothing suppresses retries or raises an alert
    expect((r as { code?: string }).code).toBeUndefined();
    expect(r.error).toMatch(/could not be read to verify/);
    expect(closePerpHedgeBySymbolSide).not.toHaveBeenCalled();
  }, 15_000);

  it('a position that is still open after the order is a rejected close', async () => {
    const { ctx } = makeCtx(['open']);
    const r = await performCloseHedge(ctx, { symbol: 'SUI-PERP' });
    expect(r.success).toBe(false);
    expect((r as { code?: string }).code).toBe('SILENT_REJECT');
  }, 15_000);

  it('reads that fail and then show the position gone confirm the close', async () => {
    const { ctx } = makeCtx(['open', 'fail', 'fail', 'gone']);
    const r = await performCloseHedge(ctx, { symbol: 'SUI-PERP' });
    expect(r.success).toBe(true);
    expect(closePerpHedgeBySymbolSide).toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe('callers that act on positions use the strict read', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  it('the auto-hedge step trusts the fill the open path verified, with no second lenient read', () => {
    const src = read('lib/services/sui/cron/step-8-auto-hedge.ts');
    expect(src).toContain('const filled = result.success && !!result.orderId;');
    expect(src).not.toContain('await bluefin.getPositions()');
  });

  it('the health probe and the NAV snapshot see a failed read as a failure', () => {
    expect(read('app/api/cron/bluefin-health/route.ts')).toContain('bf.getPositionsStrict()');
    expect(read('lib/services/sui/bluefin-read-safe.ts')).toContain('bf.getPositionsStrict(),');
  });

  it('dollar P&L is notional x move, not multiplied by leverage', () => {
    expect(read('lib/services/hedging/HedgePnLTracker.ts')).toContain('const unrealizedPnL = notionalValue * pnlMultiplier;');
    expect(read('lib/services/hedging/CentralizedHedgeManager.ts')).not.toContain('rawNotionalValue * pnlMultiplier * leverage');
  });

  it('the service keeps a lenient read for display and a strict one that throws', () => {
    const src = read('lib/services/sui/BluefinService.ts');
    expect(src).toContain('async getPositionsStrict(): Promise<BluefinPosition[]>');
    expect(src).toContain("throw new Error('venue account response has no positions list');");
    // the order paths verify fills by the position delta
    expect(src.split('getPositions: this.getPositionsStrict.bind(this),').length - 1).toBe(2);
    expect(src).not.toContain('getPositions: this.getPositions.bind(this),');
  });

  it.each([
    ['lib/services/sui/cron/step-8-auto-hedge.ts', 'const existing = await bluefin.getPositionsStrict();'],
    ['app/api/cron/sui-hedge-reconcile/route.ts', 'livePositions = await bf.getPositionsStrict();'],
    ['app/api/cron/bluefin-db-reconcile/route.ts', 'bf.getPositionsStrict(),'],
    ['app/api/cron/polymarket-edge-trader/handlers/reconcile-active-trade.ts', 'positions = await bf.getPositionsStrict();'],
  ])('%s', (file, call) => {
    const src = read(file);
    expect(src).toContain(call);
    expect(src).not.toMatch(/getPositions\(\)\.catch\(\(\) => \[\]/);
  });

  it('the live trader leaves its trade alone when the venue is unreadable instead of booking a loss', () => {
    const src = read('app/api/cron/polymarket-edge-trader/handlers/reconcile-active-trade.ts');
    const strict = src.indexOf('positions = await bf.getPositionsStrict();');
    const vanished = src.indexOf('Active trade has no live position');
    const bail = src.indexOf("action: 'idle'", strict);
    expect(bail).toBeGreaterThan(strict);
    expect(bail).toBeLessThan(vanished);
  });
});

describe('a held asset that cannot be priced', () => {
  const src = readFileSync(join(process.cwd(), 'lib/services/sui/SuiUsdcPoolService.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('marks the NAV basis as incomplete, so that tick is not attested on chain', () => {
    expect(src.split('adminHoldingsPriced = false;').length - 1).toBe(2); // SUI above the gas reserve, and every other asset
    // a few leftover base units must not stop the attestation when one price read fails
    expect(src).toContain('} else if (amount >= UNPRICED_DUST_UNITS) {');
    expect(src).toContain('const UNPRICED_DUST_UNITS = 1e-6;');
    expect(src).toContain('adminRead: usedAdminBalances && adminHoldingsPriced,');
    const step4 = readFileSync(join(process.cwd(), 'lib/services/sui/cron/step-4-nav-defense.ts'), 'utf8');
    expect(step4).toContain('!basis.adminRead');
  });
});
