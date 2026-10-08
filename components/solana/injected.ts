'use client';

/**
 * The injected Solana wallet (Phantom, Solflare, any window.solana provider):
 * find it and connect. Kept free of @solana/web3.js so the wallet hub, which
 * every dashboard view mounts, does not load that library; building and
 * sending transactions lives in ./wallet.
 */
import type { Transaction } from '@solana/web3.js';

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
    solflare?: InjectedProvider & { isSolflare?: boolean };
    solana?: InjectedProvider;
  };
  // Phantom, then Solflare (its in-app browser injects window.solflare), then
  // any other wallet that exposes the standard window.solana provider.
  return w.phantom?.solana ?? (w.solflare?.isSolflare ? w.solflare : null) ?? w.solana ?? null;
}

export async function connectWallet(): Promise<string> {
  const p = getProvider();
  if (!p) throw new Error('No Solana wallet found. Install Phantom or Solflare and set it to devnet.');
  const { publicKey } = await p.connect();
  return publicKey.toBase58();
}
