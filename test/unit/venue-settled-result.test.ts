/**
 * A fill's result is what the venue account gained or lost across it. The
 * mark-to-market estimate recorded before 2026-10 left out fees and the exit
 * fill, and the live trader's rows showed a sixth of its real loss.
 */
import { describe, it, expect } from '@jest/globals';
import { accountSnapshot, plausibleSettled, settledDeltaUsd, type SettledReader } from '@/lib/services/sui/bluefin/settled-equity';
import { openCostUsd } from '@/app/api/cron/polymarket-edge-trader/handlers/state-transitions';

const E9 = (n: number) => String(Math.round(n * 1e9));
/** The production account as read on 2026-10-12. */
const account = (cash: number, positions: Array<{ symbol: string; size: number; isolated?: number }>) => ({
  assets: [{ symbol: 'USDC', quantityE9: E9(cash) }],
  positions: positions.map((p) => ({
    symbol: p.symbol, sizeE9: E9(p.size), isIsolated: p.isolated !== undefined,
    isolatedMarginE9: E9(p.isolated ?? 0),
  })),
});
const OCT_12 = account(18.281431345, [
  { symbol: 'SOL-PERP', size: 0.2, isolated: 4.925936909 },
  { symbol: 'SUI-PERP', size: 1 },
  { symbol: 'ETH-PERP', size: 0.01 },
]);
const reader = (responses: unknown[]): SettledReader => {
  let i = 0;
  return {
    walletAddress: '0xabc',
    apiRequest: async <T,>() => {
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
};

describe('settled equity', () => {
  it('is cash plus isolated margin: $23.21 on the account of 2026-10-12', () => {
    const s = accountSnapshot(OCT_12);
    expect(s.settledEquityUsd).toBeCloseTo(23.207368, 5);
    expect(s.sizes).toEqual({ 'SOL-PERP': 0.2, 'SUI-PERP': 1, 'ETH-PERP': 0.01 });
  });

  it('cross-margin positions add nothing: their margin is not set aside', () => {
    expect(accountSnapshot(account(10, [{ symbol: 'ETH-PERP', size: 0.01 }])).settledEquityUsd).toBe(10);
  });

  it('a missing figure is an error, never zero', () => {
    expect(() => accountSnapshot({ positions: [] })).toThrow(/USDC balance/);
    expect(() => accountSnapshot({ assets: [{ symbol: 'USDC', quantityE9: '1' }] })).toThrow(/positions list/);
    expect(() => accountSnapshot({ assets: [{ symbol: 'USDC', quantityE9: '1' }], positions: [{ symbol: 'X', sizeE9: '1', isIsolated: true }] })).toThrow(/margin figure/);
    expect(() => accountSnapshot(null)).toThrow();
  });
});

describe('the settled result of a close', () => {
  const before = accountSnapshot(OCT_12);
  // SOL long closed: margin returns to cash less a $1.86 loss and fees
  const after = account(18.281431345 + 4.925936909 - 1.86, [{ symbol: 'SUI-PERP', size: 1 }, { symbol: 'ETH-PERP', size: 0.01 }]);
  const base = { before, symbol: 'SOL-PERP', reflectsFill: (s: number) => s <= 0.2 - 0.2 * 0.99, estimateUsd: -1.81, notionalUsd: 21.8, waitMs: 1 };

  it('is the account change, fees included, where the estimate had none', async () => {
    expect(await settledDeltaUsd({ ...base, ctx: reader([after]) })).toBeCloseTo(-1.86, 6);
  });

  it('waits until the account shows the position gone', async () => {
    expect(await settledDeltaUsd({ ...base, ctx: reader([OCT_12, OCT_12, after]) })).toBeCloseTo(-1.86, 6);
  });

  it('is unknown, not a guess, when the account never shows the fill', async () => {
    expect(await settledDeltaUsd({ ...base, ctx: reader([OCT_12]) })).toBeNull();
  });

  it('is unknown when the account could not be read before or after', async () => {
    expect(await settledDeltaUsd({ ...base, before: null, ctx: reader([after]) })).toBeNull();
    expect(await settledDeltaUsd({ ...base, ctx: reader([new Error('503')]) })).toBeNull();
  });

  it('is refused when something else moved the account: a $5 deposit is not a $3 profit', async () => {
    const withDeposit = account(18.281431345 + 4.925936909 - 1.86 + 5, [{ symbol: 'SUI-PERP', size: 1 }, { symbol: 'ETH-PERP', size: 0.01 }]);
    expect(await settledDeltaUsd({ ...base, ctx: reader([withDeposit]) })).toBeNull();
  });
});

describe('plausibility', () => {
  it('allows fees and slippage, a few basis points of notional', () => {
    expect(plausibleSettled(-0.31, -0.25, 23.5)).toBe(true);
    expect(plausibleSettled(0.18, 0.25, 23.5)).toBe(true);
  });

  it('scales with the position, with a floor for small ones', () => {
    expect(plausibleSettled(-25, -10, 1000)).toBe(true); // 2% of $1,000 is $20
    expect(plausibleSettled(-35, -10, 1000)).toBe(false);
    expect(plausibleSettled(0.6, 0, 5)).toBe(false);
  });

  it('refuses a figure that is not a number', () => {
    expect(plausibleSettled(NaN, 0, 10)).toBe(false);
  });
});

describe('what an open cost', () => {
  it('is the account change when it was read', () => {
    expect(openCostUsd({ settledUsd: -0.0082, fees: 0 })).toBeCloseTo(0.0082, 6);
  });

  it('falls back to the reported fee', () => {
    expect(openCostUsd({ fees: 0.01 })).toBe(0.01);
    expect(openCostUsd({})).toBe(0);
  });

  it('is never negative: an open does not earn', () => {
    expect(openCostUsd({ settledUsd: 0.02 })).toBe(0);
  });
});
