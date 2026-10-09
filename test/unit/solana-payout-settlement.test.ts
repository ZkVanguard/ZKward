/**
 * A reserved payout is decided by what the chain shows, never by what the
 * request saw: paid when the transfer is confirmed, released when it can no
 * longer land, and left alone while it still might. And the indexer reads
 * every new signature, not just the newest page.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async () => null),
  setCronState: jest.fn(async () => undefined),
}));

const settled: string[] = [];
const released: string[] = [];
let pendingRows: Array<{ signature: string; wallet: string; amountRaw: bigint; sharesBurnedRaw: bigint; lastValidBlockHeight: number | null; ageSeconds: number }> = [];
jest.mock('@/lib/db/solana-pool', () => ({
  settleWithdrawal: jest.fn(async (s: string) => void settled.push(s)),
  releaseWithdrawal: jest.fn(async (s: string) => void released.push(s)),
  getPendingWithdrawals: jest.fn(async () => pendingRows),
  isUnsigned: (s: string) => s.startsWith('pending:'),
  recordDeposit: jest.fn(async () => true),
  getTotalSharesRaw: jest.fn(async () => 0n),
  getAccountedTokensRaw: jest.fn(async () => 0n),
}));

type Status = { err: unknown; confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null } | null;
const chain = { status: null as Status, height: 100, statusFails: false };
const pages: Array<Array<{ signature: string; slot: number; err: null; blockTime: number }>> = [];
const sigCalls: Array<{ until?: string; before?: string; limit?: number }> = [];
jest.mock('@/lib/services/solana/rpc', () => ({
  getSignatureStatus: jest.fn(async () => {
    if (chain.statusFails) throw new Error('rpc down');
    return chain.status;
  }),
  getFinalizedBlockHeight: jest.fn(async () => chain.height),
  getSignaturesForAddress: jest.fn(async (_a: string, opts: { until?: string; before?: string; limit?: number }) => {
    sigCalls.push(opts);
    return pages.shift() ?? [];
  }),
  getTransaction: jest.fn(async () => null),
  getTokenAccountBalance: jest.fn(async () => ({ amount: '0', decimals: 6, uiAmount: 0 })),
  extractDepositsToVault: jest.fn(() => []),
}));

import { resolvePayout, reconcilePendingWithdrawals, signaturesSince } from '@/lib/services/solana/SolanaPoolService';

const sent = (over: Partial<{ lastValidBlockHeight: number | null; ageSeconds: number }> = {}) => ({
  signature: 'SigOfThePayout', lastValidBlockHeight: 150, ageSeconds: 5, ...over,
});

beforeEach(() => {
  settled.length = 0;
  released.length = 0;
  pendingRows = [];
  pages.length = 0;
  sigCalls.length = 0;
  Object.assign(chain, { status: null, height: 100, statusFails: false });
});

describe('resolvePayout', () => {
  it('confirmed on chain: the burn stands', async () => {
    chain.status = { err: null, confirmationStatus: 'confirmed' };
    expect(await resolvePayout(sent())).toBe('paid');
    expect(settled).toEqual(['SigOfThePayout']);
    expect(released).toEqual([]);
  });

  it('failed on chain: the shares return', async () => {
    chain.status = { err: { InstructionError: [1, 'Custom'] }, confirmationStatus: 'finalized' };
    expect(await resolvePayout(sent())).toBe('released');
    expect(released).toEqual(['SigOfThePayout']);
  });

  it('seen but not yet confirmed: nothing is decided', async () => {
    chain.status = { err: null, confirmationStatus: 'processed' };
    expect(await resolvePayout(sent())).toBe('pending');
    expect(settled.concat(released)).toEqual([]);
  });

  it('unseen while its blockhash is still valid: the shares stay burned', async () => {
    chain.height = 150; // not yet past the last valid height
    expect(await resolvePayout(sent())).toBe('pending');
    expect(released).toEqual([]);
  });

  it('unseen after the finalized chain passed its last valid height: released', async () => {
    chain.height = 151;
    expect(await resolvePayout(sent())).toBe('released');
    expect(released).toEqual(['SigOfThePayout']);
  });

  it('a reservation that was never signed is released only once it is old', async () => {
    expect(await resolvePayout({ signature: 'pending:abc', lastValidBlockHeight: null, ageSeconds: 30 })).toBe('pending');
    expect(released).toEqual([]);
    expect(await resolvePayout({ signature: 'pending:abc', lastValidBlockHeight: null, ageSeconds: 121 })).toBe('released');
    expect(released).toEqual(['pending:abc']);
  });

  it('a failed chain read decides nothing', async () => {
    chain.statusFails = true;
    await expect(resolvePayout(sent())).rejects.toThrow('rpc down');
    expect(settled.concat(released)).toEqual([]);
  });
});

describe('reconcilePendingWithdrawals', () => {
  it('counts each outcome and survives a row it cannot read', async () => {
    pendingRows = [{ signature: 'SigA', wallet: 'W1', amountRaw: 1n, sharesBurnedRaw: 1n, lastValidBlockHeight: 150, ageSeconds: 300 }];
    chain.statusFails = true;
    expect(await reconcilePendingWithdrawals()).toEqual({ paid: 0, released: 0, pending: 1 });
    chain.statusFails = false;
    chain.status = { err: null, confirmationStatus: 'finalized' };
    expect(await reconcilePendingWithdrawals()).toEqual({ paid: 1, released: 0, pending: 0 });
  });
});

describe('signaturesSince', () => {
  const page = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ signature: `${tag}${i}`, slot: 1, err: null, blockTime: 1 }));

  it('pages back from the last signature of a full page until a short one', async () => {
    pages.push(page(1000, 'a'), page(3, 'b'));
    const all = await signaturesSince('Vault', 'mark');
    expect(all).toHaveLength(1003);
    expect(sigCalls[0]).toMatchObject({ until: 'mark', before: undefined, limit: 1000 });
    expect(sigCalls[1]).toMatchObject({ until: 'mark', before: 'a999' });
  });

  it('a backlog too large to read throws instead of skipping what it could not reach', async () => {
    for (let i = 0; i < 20; i++) pages.push(page(1000, `p${i}_`));
    await expect(signaturesSince('Vault', 'mark')).rejects.toThrow(/mark not moved/);
  });
});
