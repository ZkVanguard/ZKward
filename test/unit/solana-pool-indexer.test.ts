/**
 * Indexer tick against fake RPC + in-memory DB: credits once, skips failed
 * txs, advances the watermark exactly once per tick, and replays are no-ops.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async (k: string) => state.get(k) ?? null),
  setCronState: jest.fn(async (k: string, v: unknown) => void state.set(k, v)),
}));

const depositRows = new Map<string, { sharesMintedRaw: bigint }>();
jest.mock('@/lib/db/solana-pool', () => ({
  recordDeposit: jest.fn(async (args: { signature: string; sharesMintedRaw: bigint }) => {
    if (depositRows.has(args.signature)) return false;
    depositRows.set(args.signature, { sharesMintedRaw: args.sharesMintedRaw });
    return true;
  }),
  getTotalSharesRaw: jest.fn(async () =>
    [...depositRows.values()].reduce((a, r) => a + r.sharesMintedRaw, 0n),
  ),
}));

const VAULT = 'VauLtAta1111111111111111111111111111111111111';
const mkTx = (dest: string, amount: string, err: unknown = null) => ({
  slot: 42,
  blockTime: 1_700_000_000,
  meta: { err },
  transaction: {
    message: {
      instructions: [
        {
          program: 'spl-token',
          parsed: { type: 'transfer', info: { source: 'S', destination: dest, authority: 'A1', amount } },
        },
      ],
    },
  },
});

const rpcMocks = {
  sigs: [] as Array<{ signature: string; slot: number; err: unknown; blockTime: number }>,
  txs: new Map<string, unknown>(),
};
jest.mock('@/lib/services/solana/rpc', () => {
  const actual = jest.requireActual('@/lib/services/solana/rpc') as object;
  return {
    ...actual,
    getSignaturesForAddress: jest.fn(async () => rpcMocks.sigs),
    getTransaction: jest.fn(async (sig: string) => rpcMocks.txs.get(sig) ?? null),
    getTokenAccountBalance: jest.fn(async () => ({ amount: '3000000', decimals: 6, uiAmount: 3 })),
  };
});

import { runSolanaPoolIndexTick } from '@/lib/services/solana/SolanaPoolService';
import { setCronState } from '@/lib/db/cron-state';

describe('runSolanaPoolIndexTick', () => {
  beforeEach(() => {
    state.clear();
    depositRows.clear();
    rpcMocks.sigs = [];
    rpcMocks.txs.clear();
    process.env.SOLANA_POOL_VAULT_ATA = VAULT;
    jest.clearAllMocks();
  });

  it('credits deposits oldest-first, skips failed sigs, one watermark write', async () => {
    rpcMocks.sigs = [
      { signature: 'sigC_newest', slot: 44, err: null, blockTime: 3 },
      { signature: 'sigB_failed', slot: 43, err: { some: 'err' }, blockTime: 2 },
      { signature: 'sigA_oldest', slot: 42, err: null, blockTime: 1 },
    ];
    rpcMocks.txs.set('sigA_oldest', mkTx(VAULT, '1000000'));
    rpcMocks.txs.set('sigC_newest', mkTx(VAULT, '2000000'));

    const s = await runSolanaPoolIndexTick();
    expect(s.credited).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.totalSharesRaw).toBe('3000000'); // 1:1 on flat pool
    expect(s.vaultTokensRaw).toBe('3000000');
    // watermark = newest signature, written exactly once
    expect(state.get('solana-pool:last-sig')).toBe('sigC_newest');
    expect(jest.mocked(setCronState).mock.calls.filter(([k]) => k === 'solana-pool:last-sig')).toHaveLength(1);
  });

  it('replay of the same signatures credits nothing (PK idempotency)', async () => {
    rpcMocks.sigs = [{ signature: 'sigA', slot: 42, err: null, blockTime: 1 }];
    rpcMocks.txs.set('sigA', mkTx(VAULT, '500000'));
    await runSolanaPoolIndexTick();
    const again = await runSolanaPoolIndexTick();
    expect(again.credited).toBe(0);
    expect(again.totalSharesRaw).toBe('500000');
  });

  it('transfer to a different destination is not a deposit', async () => {
    rpcMocks.sigs = [{ signature: 'sigX', slot: 42, err: null, blockTime: 1 }];
    rpcMocks.txs.set('sigX', mkTx('SomeoneElse', '999999'));
    const s = await runSolanaPoolIndexTick();
    expect(s.credited).toBe(0);
    expect(s.skipped).toBe(1);
  });

  it('throws loudly when the vault ATA is unconfigured', async () => {
    delete process.env.SOLANA_POOL_VAULT_ATA;
    await expect(runSolanaPoolIndexTick()).rejects.toThrow(/SOLANA_POOL_VAULT_ATA/);
  });
});
