/**
 * A deposit is reported only after the pool's cluster confirmed it. The
 * helper used to return the wallet's signature whatever happened next, so a
 * transaction the network never accepted was shown as "Deposit sent".
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Keypair } from '@solana/web3.js';

const conn = {
  getBalance: jest.fn(async () => 5_000_000),
  getLatestBlockhash: jest.fn(async () => ({
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 100,
  })),
  sendRawTransaction: jest.fn(async () => 'sig-ours'),
  confirmTransaction: jest.fn(async (): Promise<{ value: { err: unknown } }> => ({ value: { err: null } })),
};
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js') as Record<string, unknown>;
  return { ...actual, Connection: jest.fn(() => conn) };
});

import { depositTokens } from '@/components/solana/wallet';

const owner = Keypair.generate().publicKey.toBase58();
const args = {
  rpcUrl: 'https://rpc.invalid',
  wallet: owner,
  tokenMint: Keypair.generate().publicKey.toBase58(),
  vaultAta: Keypair.generate().publicKey.toBase58(),
  amountUi: 25,
};

const signTransaction = jest.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) }));
const signAndSendTransaction = jest.fn(async () => ({ signature: 'sig-wallet' }));

function installWallet(withSign: boolean) {
  (globalThis as unknown as { window: unknown }).window = {
    phantom: {
      solana: {
        publicKey: { toBase58: () => owner },
        signAndSendTransaction,
        ...(withSign ? { signTransaction } : {}),
      },
    },
  };
}

describe('depositTokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    conn.getBalance.mockResolvedValue(5_000_000);
    conn.confirmTransaction.mockResolvedValue({ value: { err: null } });
    installWallet(true);
  });

  it('a wallet with no SOL is told so before the wallet is asked to sign', async () => {
    conn.getBalance.mockResolvedValue(0);
    await expect(depositTokens(args)).rejects.toThrow(/no devnet SOL/);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });

  it('the wallet signs, the pool cluster receives it, and it resolves once confirmed', async () => {
    await expect(depositTokens(args)).resolves.toBe('sig-ours');
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(signAndSendTransaction).not.toHaveBeenCalled();
    expect(conn.confirmTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'sig-ours', lastValidBlockHeight: 100 }),
      'confirmed',
    );
  });

  it('a transaction that never confirms is an error, not a success', async () => {
    conn.confirmTransaction.mockRejectedValueOnce(new Error('block height exceeded'));
    await expect(depositTokens(args)).rejects.toThrow(/not confirmed/);
  });

  it('a transaction that failed on chain is an error', async () => {
    conn.confirmTransaction.mockResolvedValueOnce({ value: { err: { InstructionError: [1, 'Custom'] } } });
    await expect(depositTokens(args)).rejects.toThrow(/not confirmed/);
  });

  it('a wallet that cannot sign-only falls back to its own send, still confirmed', async () => {
    installWallet(false);
    await expect(depositTokens(args)).resolves.toBe('sig-wallet');
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
    expect(conn.confirmTransaction).toHaveBeenCalledTimes(1);
  });
});
