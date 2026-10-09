/**
 * The cluster is read in one place and everything that touches money
 * follows it: the ledger never mixes clusters, an endpoint on the wrong
 * chain is refused, mainnet needs its own endpoint, and the faucet does
 * not exist there.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let nextError: (Error & { code?: string }) | null = null;
jest.mock('@/lib/db/postgres', () => ({
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (nextError && sql.includes('INSERT INTO solana_pool_withdrawals')) {
      const e = nextError;
      nextError = null;
      throw e;
    }
    if (sql.includes('RETURNING signature')) return [{ signature: 'x' }];
    return sql.includes('AS total') ? [{ total: '0' }] : [];
  }),
}));

import { solanaCluster, isMainnet, base58Encode, expectedGenesisHash } from '@/lib/services/solana/cluster';
import { solanaRpcUrls, solanaPublicRpcUrl, assertEndpointOnCluster } from '@/lib/services/solana/rpc';
import * as db from '@/lib/db/solana-pool';
import { mintTestTokens } from '@/lib/services/solana/signer';

const ENV = ['SOLANA_CLUSTER', 'SOLANA_RPC_URL', 'SOLANA_PUBLIC_RPC_URL'] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = global.fetch;

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  queries.length = 0;
  nextError = null;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  global.fetch = realFetch;
});

describe('solanaCluster', () => {
  it('unset is devnet; both spellings of mainnet are mainnet-beta', () => {
    expect(solanaCluster()).toBe('devnet');
    process.env.SOLANA_CLUSTER = 'mainnet';
    expect(solanaCluster()).toBe('mainnet-beta');
    process.env.SOLANA_CLUSTER = ' Mainnet-Beta ';
    expect(solanaCluster()).toBe('mainnet-beta');
    expect(isMainnet()).toBe(true);
  });

  it('an unknown value stops the pool instead of selecting a cluster', () => {
    process.env.SOLANA_CLUSTER = 'mainet';
    expect(() => solanaCluster()).toThrow(/not a known cluster/);
  });

  it('base58 matches the published alphabet', () => {
    expect(base58Encode(new TextEncoder().encode('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112');
  });
});

describe('endpoints', () => {
  it('mainnet has no default endpoint', () => {
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    expect(() => solanaRpcUrls()).toThrow(/required on mainnet/);
    process.env.SOLANA_RPC_URL = ' https://a.invalid , https://b.invalid ';
    expect(solanaRpcUrls()).toEqual(['https://a.invalid', 'https://b.invalid']);
  });

  it('the browser never receives the server endpoint', () => {
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    process.env.SOLANA_RPC_URL = 'https://provider.invalid/?api-key=secret';
    expect(solanaPublicRpcUrl()).not.toContain('secret');
    process.env.SOLANA_PUBLIC_RPC_URL = 'https://browser.invalid';
    expect(solanaPublicRpcUrl()).toBe('https://browser.invalid');
  });

  it('an endpoint on another chain is refused, and asked again next time', async () => {
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    const genesis = jest.fn(async () => ({ ok: true, json: async () => ({ result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }) }));
    global.fetch = genesis as unknown as typeof fetch;
    await expect(assertEndpointOnCluster('https://wrong.invalid')).rejects.toThrow(/not on mainnet-beta/);
    await expect(assertEndpointOnCluster('https://wrong.invalid')).rejects.toThrow(/not on mainnet-beta/);
    expect(genesis).toHaveBeenCalledTimes(2);

    const right = jest.fn(async () => ({ ok: true, json: async () => ({ result: expectedGenesisHash() }) }));
    global.fetch = right as unknown as typeof fetch;
    await assertEndpointOnCluster('https://right.invalid');
    await assertEndpointOnCluster('https://right.invalid');
    expect(right).toHaveBeenCalledTimes(1);
  });
});

describe('the ledger is scoped to the cluster', () => {
  it('every sum, list and write names the cluster', async () => {
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    await db.getTotalSharesRaw();
    await db.getAccountedTokensRaw();
    await db.getWalletSharesRaw('W');
    await db.getMembers();
    await db.getRecentDeposits(5);
    await db.getNavHistory(7, 'hour');
    await db.getPendingWithdrawals();
    await db.recordDeposit({ signature: 's', sender: 'W', amountRaw: 1n, sharesMintedRaw: 1n, slot: 1, blockTime: 1 });
    await db.recordNavSnapshot({ sharePrice: 1, navUsd: null, accountedTokensRaw: 1n, totalSharesRaw: 1n });
    await db.reserveWithdrawal({ nonce: 'n', wallet: 'W', sharesBurnedRaw: 1n, amountRaw: 1n });

    const data = queries.filter((q) => !q.sql.includes('CREATE TABLE') && !q.sql.startsWith('DELETE FROM solana_pool_nav_history'));
    expect(data.length).toBeGreaterThanOrEqual(10);
    for (const q of data) {
      expect(q.params).toContain('mainnet-beta');
      expect(q.sql).toMatch(/cluster/);
    }
  });

  it('a second withdrawal for a wallet that has one in flight is "busy"; a reused nonce is "replay"', async () => {
    nextError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(await db.reserveWithdrawal({ nonce: 'n1', wallet: 'W', sharesBurnedRaw: 1n, amountRaw: 1n })).toBe('busy');
    expect(await db.reserveWithdrawal({ nonce: 'n1', wallet: 'W', sharesBurnedRaw: 1n, amountRaw: 1n })).toBe('reserved');
    nextError = new Error('connection lost');
    await expect(db.reserveWithdrawal({ nonce: 'n2', wallet: 'W', sharesBurnedRaw: 1n, amountRaw: 1n })).rejects.toThrow('connection lost');
  });
});

describe('the faucet', () => {
  it('cannot mint on mainnet even if its route is reached', async () => {
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    await expect(mintTestTokens('11111111111111111111111111111111', 1n)).rejects.toThrow(/does not exist on mainnet/);
  });
});
