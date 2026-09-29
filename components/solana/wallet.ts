/**
 * Browser wallet client for the Solana pool — talks to the injected
 * provider (Phantom / any window.solana-compatible) directly. No adapter
 * framework: connect, sign-message, and a deposit builder are the whole
 * surface this page needs.
 */
'use client';

import {
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export interface InjectedProvider {
  isPhantom?: boolean;
  publicKey: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
  signMessage(msg: Uint8Array, display?: 'utf8'): Promise<{ signature: Uint8Array }>;
}

export function getProvider(): InjectedProvider | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    phantom?: { solana?: InjectedProvider };
    solana?: InjectedProvider;
  };
  return w.phantom?.solana ?? w.solana ?? null;
}

export async function connectWallet(): Promise<string> {
  const p = getProvider();
  if (!p) throw new Error('No Solana wallet found — install Phantom and set it to devnet');
  const { publicKey } = await p.connect();
  return publicKey.toBase58();
}

/**
 * Build + send a JIMP deposit: SPL transfer from the user's token account
 * to the vault ATA. Creates the user's ATA idempotently first (covers
 * fresh faucet wallets), fee paid by the user in devnet SOL.
 */
export async function depositTokens(args: {
  rpcUrl: string;
  wallet: string;
  tokenMint: string;
  vaultAta: string;
  amountUi: number;
}): Promise<string> {
  const p = getProvider();
  if (!p?.publicKey) throw new Error('wallet not connected');
  const owner = new PublicKey(args.wallet);
  const mint = new PublicKey(args.tokenMint);
  const vaultAta = new PublicKey(args.vaultAta);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);
  const amountRaw = BigInt(Math.round(args.amountUi * 1e6));

  const conn = new Connection(args.rpcUrl, 'confirmed');
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner, ownerAta, owner, mint),
    createTransferInstruction(ownerAta, vaultAta, owner, amountRaw),
  );
  tx.feePayer = owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

  const { signature } = await p.signAndSendTransaction(tx);
  await conn.confirmTransaction(signature, 'confirmed').catch(() => undefined);
  return signature;
}

/** Sign the withdraw nonce message; returns hex for the API. */
export async function signWithdrawMessage(nonce: string, sharesUi: number): Promise<string> {
  const p = getProvider();
  if (!p?.publicKey) throw new Error('wallet not connected');
  const msg = new TextEncoder().encode(`zkward-solana-withdraw:${nonce}:${sharesUi}`);
  const { signature } = await p.signMessage(msg, 'utf8');
  return Array.from(signature)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
