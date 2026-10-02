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
} from '@/lib/services/solana/spl';

export interface InjectedProvider {
  isPhantom?: boolean;
  publicKey: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
  signTransaction?(tx: Transaction): Promise<Transaction>;
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

/** Below this the wallet cannot pay a transaction fee (5,000 lamports). */
const MIN_FEE_LAMPORTS = 10_000;

/**
 * Build + send a JIMP deposit: SPL transfer from the user's token account
 * to the vault ATA. Creates the user's ATA idempotently first (covers
 * fresh faucet wallets), fee paid by the user in devnet SOL.
 *
 * Resolves only once the pool's cluster confirmed the transfer. It used to
 * return the wallet's signature whatever happened next, so a transaction
 * the network never accepted (no SOL for the fee, wallet on another
 * network) was shown as "Deposit sent" with a link to nothing.
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

  if ((await conn.getBalance(owner)) < MIN_FEE_LAMPORTS) {
    throw new Error('Your wallet has no devnet SOL to pay the network fee. Press "Get test JIMP" to receive some, then deposit again.');
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  // The wallet only signs; we submit to the pool's cluster ourselves. A
  // wallet set to another network would otherwise send it there, where it
  // can never land.
  let signature: string;
  if (p.signTransaction) {
    const signed = await p.signTransaction(tx);
    signature = await conn.sendRawTransaction(signed.serialize()).catch((e: unknown) => {
      const why = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 140);
      throw new Error(`Solana devnet rejected the deposit, so nothing was moved (${why}).`);
    });
  } else {
    ({ signature } = await p.signAndSendTransaction(tx));
  }

  const notConfirmed = 'The deposit was not confirmed on Solana devnet, so nothing was moved. Check that your wallet is set to devnet and try again.';
  const res = await conn
    .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    .catch(() => {
      throw new Error(notConfirmed);
    });
  if (res.value.err) throw new Error(notConfirmed);
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
