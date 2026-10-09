/**
 * Vault signer — the server's ONLY Solana signing surface.
 *
 * Loaded lazily from SOLANA_POOL_VAULT_SECRET (JSON byte-array, the
 * standard keypair-file format). Server-only: imported exclusively by the
 * withdraw/faucet routes; never logged, never echoed, never NEXT_PUBLIC.
 * Two capabilities:
 *   • a vault payout — built and signed here, sent by the caller, so the
 *     caller can store the signature before the transfer exists on chain
 *   • mintTestTokens — the faucet for the mirror token, refused on mainnet
 *     here as well as in its route (and impossible there anyway: the real
 *     token's mint authority is renounced)
 * Nothing is signed until the endpoint has shown it is on the configured
 * cluster.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from './spl';
import { assertEndpointOnCluster, solanaRpcUrl } from './rpc';
import { base58Encode, isMainnet } from './cluster';

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

async function connection(): Promise<Connection> {
  const url = solanaRpcUrl();
  await assertEndpointOnCluster(url);
  return new Connection(url, 'confirmed');
}

/**
 * Price per compute unit, in micro-lamports. A payout with no priority fee
 * waits behind everything else when the network is busy. The default costs
 * a fraction of a cent; test clusters need none.
 */
function priorityMicroLamports(): number {
  const v = Number((process.env.SOLANA_PRIORITY_MICROLAMPORTS || '').trim());
  if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  return isMainnet() ? 50_000 : 0;
}

/** Creating the recipient's token account and one transfer use about 30,000 units. */
const PAYOUT_COMPUTE_UNITS = 60_000;

export interface SignedPayout {
  signature: string;
  raw: Buffer;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Build and sign a vault → wallet payout without sending it. The signature
 * is the transaction's identity on chain, so the caller can write it down
 * first and ask the chain about it afterwards, whatever happens in between.
 */
export async function signVaultPayout(toWallet: string, amountRaw: bigint): Promise<SignedPayout> {
  const vault = vaultKeypair();
  const mint = poolMint();
  const to = new PublicKey(toWallet);
  const vaultAta = getAssociatedTokenAddressSync(mint, vault.publicKey);
  const toAta = getAssociatedTokenAddressSync(mint, to);
  const conn = await connection();

  const tx = new Transaction();
  const price = priorityMicroLamports();
  if (price > 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: PAYOUT_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    );
  }
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, toAta, to, mint),
    createTransferInstruction(vaultAta, toAta, vault.publicKey, amountRaw),
  );
  tx.feePayer = vault.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(vault);
  if (!tx.signature) throw new Error('payout was not signed');
  return { signature: base58Encode(tx.signature), raw: tx.serialize(), blockhash, lastValidBlockHeight };
}

/**
 * Send a signed payout and wait for it. Resolves 'confirmed' or 'failed'
 * (the chain rejected it); throws when the outcome is not known, which the
 * caller must treat as "may still land".
 */
export async function sendSignedPayout(p: SignedPayout): Promise<'confirmed' | 'failed'> {
  const conn = await connection();
  await conn.sendRawTransaction(p.raw, { maxRetries: 3 });
  const res = await conn.confirmTransaction(
    { signature: p.signature, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight },
    'confirmed',
  );
  return res.value.err ? 'failed' : 'confirmed';
}

/** A wallet under the floor gets the top-up: enough for ~200 deposits. */
const FEE_FLOOR_LAMPORTS = 1_000_000;
const FEE_TOPUP_LAMPORTS = 2_000_000;

/**
 * Faucet mint of the MIRROR token, test clusters only.
 *
 * Also sends a little test SOL to a wallet that has none: test tokens are
 * useless without it, since the deposit is a transaction the wallet pays for
 * (a faucet-funded wallet with 0 SOL could never deposit).
 */
export async function mintTestTokens(toWallet: string, amountRaw: bigint): Promise<string> {
  if (isMainnet()) throw new Error('the faucet does not exist on mainnet');
  const vault = vaultKeypair();
  const mint = poolMint();
  const to = new PublicKey(toWallet);
  const toAta = getAssociatedTokenAddressSync(mint, to);
  const conn = await connection();

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, toAta, to, mint),
    createMintToInstruction(mint, toAta, vault.publicKey, amountRaw),
  );
  if ((await conn.getBalance(to)) < FEE_FLOOR_LAMPORTS) {
    tx.add(SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: to, lamports: FEE_TOPUP_LAMPORTS }));
  }
  tx.feePayer = vault.publicKey;
  return sendAndConfirmTransaction(conn, tx, [vault]);
}
