/**
 * Two things that decide what the pool says it is worth and what it may do:
 * the venue's part of NAV, and the switch that keeps capital steps off.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateOr: jest.fn(async (k: string, d: unknown) => (state.has(k) ? state.get(k) : d)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('@/lib/utils/discord-notify', () => ({ notifyDiscord: jest.fn(async () => {}) }));

const getBalance = jest.fn<() => Promise<number>>();
const getPositions = jest.fn<() => Promise<unknown[]>>();
const getAccountValue = jest.fn<() => Promise<number>>();
jest.mock('@/lib/services/sui/BluefinService', () => ({
  BluefinService: { getInstance: () => ({ initialize: jest.fn(async () => {}), getBalance, getPositions, getAccountValue }) },
}));

import { safeBluefinSnapshot, refreshBluefinCache } from '@/lib/services/sui/bluefin-read-safe';
import { isPoolTradingEnabled } from '@/lib/services/sui/pool-trading-pause';

// The venue account on 2026-10-06: two cross-margin positions.
const LIVE = {
  free: 6.767, // marginAvailable = account value − initial margin; already net of the unrealized loss
  positions: [
    { symbol: 'SUI-PERP', side: 'LONG', margin: 0.4, unrealizedPnl: 0.2811 },
    { symbol: 'ETH-PERP', side: 'SHORT', margin: 9.0528, unrealizedPnl: -6.9919 },
  ],
  accountValue: 16.2197,
};

beforeEach(() => {
  jest.clearAllMocks();
  state.clear();
  process.env.SUI_POOL_ADMIN_KEY = '11'.repeat(32);
  getBalance.mockResolvedValue(LIVE.free);
  getPositions.mockResolvedValue(LIVE.positions);
  getAccountValue.mockResolvedValue(LIVE.accountValue);
});

describe('venue component of NAV', () => {
  it('is the venue’s own account value, not free + margin + unrealized P&L', async () => {
    const snap = await safeBluefinSnapshot({ network: 'mainnet', onChainHasExposure: true });
    expect(snap.source).toBe('live');
    expect(snap.totalValue).toBeCloseTo(16.2197, 4);
    // what the old sum produced from the same reads: the loss counted twice
    const oldSum = LIVE.free + 0.4 + 9.0528 + (0.2811 - 6.9919);
    expect(oldSum).toBeCloseTo(9.509, 2);
    expect(snap.totalValue - oldSum).toBeCloseTo(6.71, 1);
  });

  it('caches the venue’s figure', async () => {
    await safeBluefinSnapshot({ network: 'mainnet', onChainHasExposure: true });
    expect((state.get('bluefin:nav-last-good') as { value: number }).value).toBeCloseTo(16.2197, 4);
  });

  it('when the account value cannot be read, the last good total is used instead of a sum of parts', async () => {
    state.set('bluefin:nav-last-good', { value: 16.1, free: 6.7, lockedMargin: 9.45, upnl: -6.7, positions: 2, ts: Date.now() - 60_000 });
    getAccountValue.mockRejectedValue(new Error('venue account value missing'));
    const snap = await safeBluefinSnapshot({ network: 'mainnet', onChainHasExposure: true });
    expect(snap.source).toBe('cache');
    expect(snap.totalValue).toBeCloseTo(16.1, 4);
  });

  it('other crons refreshing the cache without the account value leave the cached total alone', async () => {
    state.set('bluefin:nav-last-good', { value: 16.1, free: 6.7, lockedMargin: 9.45, upnl: -6.7, positions: 2, ts: 1 });
    await refreshBluefinCache({ free: LIVE.free, positions: LIVE.positions as Array<Record<string, unknown>>, source: 'test' });
    expect((state.get('bluefin:nav-last-good') as { value: number }).value).toBe(16.1);
    await refreshBluefinCache({ free: LIVE.free, positions: LIVE.positions as Array<Record<string, unknown>>, accountValue: 16.2197, source: 'test' });
    expect((state.get('bluefin:nav-last-good') as { value: number }).value).toBeCloseTo(16.2197, 4);
  });
});

describe('pool trading pause', () => {
  const saved = process.env.SUI_POOL_TRADING_ENABLED;
  afterEach(() => { if (saved === undefined) delete process.env.SUI_POOL_TRADING_ENABLED; else process.env.SUI_POOL_TRADING_ENABLED = saved; });

  it('trading is off unless the flag is explicitly set', () => {
    delete process.env.SUI_POOL_TRADING_ENABLED;
    expect(isPoolTradingEnabled()).toBe(false);
    for (const off of ['', '0', 'false', 'no', 'off']) {
      process.env.SUI_POOL_TRADING_ENABLED = off;
      expect(isPoolTradingEnabled()).toBe(false);
    }
    process.env.SUI_POOL_TRADING_ENABLED = '1\r\n';
    expect(isPoolTradingEnabled()).toBe(true);
  });

  it('every capital-moving step of the pool cron takes the pause, and step 4 (NAV, attestation) does not', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/cron/sui-community-pool/route.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('const tradingPaused = !isPoolTradingEnabled();');
    expect(src).toContain('const skipCapitalSteps = aboveSafetyCeiling || tradingPaused;');
    for (const step of ['runStep65HedgeSettle', 'runStep66DriftRebalance', 'runStep7Rebalance', 'runStep8AutoHedge']) {
      const at = src.indexOf(`await ${step}({`);
      expect(at).toBeGreaterThan(-1);
      const call = src.slice(at, src.indexOf('});', at));
      expect(call).toContain('aboveSafetyCeiling: skipCapitalSteps');
    }
    expect(src).toContain('if (!tradingPaused) await runStep7_9DriftClose();');
    const step4 = src.slice(src.indexOf('await runStep4NavDefense({'), src.indexOf('const tradingPaused'));
    expect(step4).not.toContain('skipCapitalSteps');
  });

  it('the portfolio driver, which sells spot inside step 4, obeys it too', () => {
    const src = readFileSync(join(process.cwd(), 'lib/services/sui/cron/step-4-nav-defense.ts'), 'utf8');
    expect(src).toContain("envFlagOnByDefault('PORTFOLIO_DRIVER_EXECUTE') && isPoolTradingEnabled()");
  });
});
