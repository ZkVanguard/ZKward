/**
 * Vault signer — the server's ONLY Solana signing surface.
 *
 * Loaded lazily from SOLANA_POOL_VAULT_SECRET (JSON byte-array, the
 * standard keypair-file format). Server-only: imported exclusively by the
 * withdraw/faucet routes; never logged, never echoed, never NEXT_PUBLIC.
 * Two capabilities, both testnet-scoped by guards at the call sites:
 *   • transferFromVault — withdrawal payouts (creates the recipient ATA
 *     idempotently, vault pays the rent)
 *   • mintTestTokens    — devnet faucet for the mirror JIMP (vault is the
 *     mint authority on the mirror; the REAL mainnet token is renounced,
 *     so this capability physically cannot exist there)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from './spl';
import { solanaRpcUrl } from './rpc';

let cached: Keypair | null = null;

export function vaultKeypair(): Keypair {
  if (cached) return cached;
  const raw = (process.env.SOLANA_POOL_VAULT_SECRET || '').trim();
  if (!raw) throw new Error('SOLANA_POOL_VAULT_SECRET not configured');
  const arr = JSON.parse(raw) as number[];
  cached = Keypair.fromSecretKey(new Uint8Array(arr));
  return cached;
}

export function poolMint(): PublicKey {
  const m = (process.env.SOLANA_POOL_TOKEN_MINT || '').trim();
  if (!m) throw new Error('SOLANA_POOL_TOKEN_MINT not configured');
  return new PublicKey(m);
}

function connection(): Connection {
  return new Connection(solanaRpcUrl(), 'confirmed');
}

/** Vault → wallet payout. Returns the transaction signature. */
export async function transferFromVault(toWallet: string, amountRaw: bigint): Promise<string> {
  const vault = vaultKeypair();
  const mint = poolMint();
  const to = new PublicKey(toWallet);
  const vaultAta = getAssociatedTokenAddressSync(mint, vault.publicKey);
  const toAta = getAssociatedTokenAddressSync(mint, to);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, toAta, to, mint),
    createTransferInstruction(vaultAta, toAta, vault.publicKey, amountRaw),
  );
  tx.feePayer = vault.publicKey;
  return sendAndConfirmTransaction(connection(), tx, [vault]);
}

/** Devnet faucet mint of the MIRROR token. Callers enforce the cluster guard. */
export async function mintTestTokens(toWallet: string, amountRaw: bigint): Promise<string> {
  const vault = vaultKeypair();
  const mint = poolMint();
  const to = new PublicKey(toWallet);
  const toAta = getAssociatedTokenAddressSync(mint, to);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, toAta, to, mint),
    createMintToInstruction(mint, toAta, vault.publicKey, amountRaw),
  );
  tx.feePayer = vault.publicKey;
  return sendAndConfirmTransaction(connection(), tx, [vault]);
}
