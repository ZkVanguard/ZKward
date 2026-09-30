/**
 * Solana pool core: pure share math, parsed-transaction deposit extraction,
 * and the Jupiter price probe (mocked fetch — no network).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  sharePrice,
  sharesForDeposit,
  payoutForShares,
  toUi,
  fromUi,
} from '@/lib/services/solana/pool-state';
import { extractDepositsToVault, type ParsedTransaction } from '@/lib/services/solana/rpc';

jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getMultiSourceValidatedPrice: jest.fn(async () => ({ price: 200, sources: 3 })),
}));

describe('pool-state share math (raw bigint)', () => {
  it('empty pool bootstraps at share price 1.0 → 1:1 mint', () => {
    expect(sharePrice(0n, 0n)).toEqual({ num: 1n, den: 1n });
    expect(sharesForDeposit(1_000_000n, 0n, 0n)).toBe(1_000_000n);
  });

  it('flat pool (no yield) keeps minting 1:1', () => {
    // 5 tokens in vault, 5 shares out → price 1.0
    expect(sharesForDeposit(2_000_000n, 5_000_000n, 5_000_000n)).toBe(2_000_000n);
  });

  it('appreciated pool mints fewer shares (buyback future-proofing)', () => {
    // vault 12, shares 10 → price 1.2 → 6-token deposit mints 5 shares
    expect(sharesForDeposit(6_000_000n, 12_000_000n, 10_000_000n)).toBe(5_000_000n);
  });

  it('floor rounding never over-mints', () => {
    // price 3/2: deposit 1 raw unit → 0 shares (dust favors holders)
    expect(sharesForDeposit(1n, 3n, 2n)).toBe(0n);
  });

  it('zero/negative deposits mint nothing', () => {
    expect(sharesForDeposit(0n, 10n, 10n)).toBe(0n);
  });

  it('payout is ledger-proportional and floors dust', () => {
    // 1.23M accounted tokens over 1.23M shares → 20k shares pay exactly 20k
    expect(payoutForShares(20_000_000_000n, 1_230_000_000_000n, 1_230_000_000_000n)).toBe(20_000_000_000n);
    // the 2026-09-29 bug: chain held 1.3M (50k uncredited) — ledger pricing ignores it
    expect(payoutForShares(20_000_000_000n, 1_250_000_000_000n, 1_250_000_000_000n)).toBe(20_000_000_000n);
    expect(payoutForShares(1n, 2n, 3n)).toBe(0n); // floor
    expect(payoutForShares(5n, 10n, 0n)).toBe(0n); // empty pool
    expect(payoutForShares(0n, 10n, 10n)).toBe(0n);
  });

  it('ui conversion round-trips at 6 decimals', () => {
    expect(toUi(1_500_000n)).toBe(1.5);
    expect(fromUi(1.5)).toBe(1_500_000n);
  });
});

describe('extractDepositsToVault', () => {
  const VAULT = 'VauLtAtaAddress11111111111111111111111111111';

  const tx = (instructions: unknown[], err: unknown = null): ParsedTransaction =>
    ({
      slot: 1,
      blockTime: 1_700_000_000,
      meta: { err },
      transaction: { message: { instructions } },
    }) as ParsedTransaction;

  it('parses spl-token transfer into the vault', () => {
    const t = tx([
      {
        program: 'spl-token',
        parsed: {
          type: 'transfer',
          info: { source: 'SRC', destination: VAULT, authority: 'AUTH', amount: '2500000' },
        },
      },
    ]);
    expect(extractDepositsToVault(t, VAULT)).toEqual([
      { source: 'SRC', authority: 'AUTH', rawAmount: 2_500_000n },
    ]);
  });

  it('parses transferChecked (tokenAmount.amount)', () => {
    const t = tx([
      {
        program: 'spl-token',
        parsed: {
          type: 'transferChecked',
          info: {
            source: 'SRC',
            destination: VAULT,
            authority: 'AUTH',
            tokenAmount: { amount: '750000', decimals: 6 },
          },
        },
      },
    ]);
    expect(extractDepositsToVault(t, VAULT)[0].rawAmount).toBe(750_000n);
  });

  it('ignores transfers to other destinations, non-token programs, failed txs', () => {
    const other = tx([
      { program: 'spl-token', parsed: { type: 'transfer', info: { destination: 'ELSEWHERE', amount: '1' } } },
      { program: 'system', parsed: { type: 'transfer', info: { destination: VAULT, amount: '1' } } },
    ]);
    expect(extractDepositsToVault(other, VAULT)).toEqual([]);
    const failed = tx(
      [{ program: 'spl-token', parsed: { type: 'transfer', info: { destination: VAULT, amount: '1' } } }],
      { InstructionError: [0, 'Custom'] },
    );
    expect(extractDepositsToVault(failed, VAULT)).toEqual([]);
  });
});

describe('price probe (mocked network)', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('converts Jupiter quote through SOL/USD: 0.1 SOL → 1.26M tokens at SOL=$200 ⇒ ~$0.0000159', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ outAmount: '1262877728531' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { getPoolTokenUsdPrice, __resetPriceCacheForTests } = await import(
      '@/lib/services/solana/price'
    );
    __resetPriceCacheForTests();
    const p = await getPoolTokenUsdPrice();
    expect(p).not.toBeNull();
    expect(p!.tokensPerSol).toBeCloseTo(12_628_777.28531, 3);
    expect(p!.usd).toBeCloseTo(200 / 12_628_777.28531, 12);
  });

  it('returns null (not a throw, not a fake number) when the quote fails cold', async () => {
    global.fetch = jest.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const { getPoolTokenUsdPrice, __resetPriceCacheForTests } = await import(
      '@/lib/services/solana/price'
    );
    __resetPriceCacheForTests();
    expect(await getPoolTokenUsdPrice()).toBeNull();
  });
});
