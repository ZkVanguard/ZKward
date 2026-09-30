/**
 * Solana pool storage — deposits ledger only.
 *
 * Deliberately no state/balance row: the vault's token balance is read live
 * from chain (chain = truth), and total shares derive from SUM(shares_minted).
 * The transaction signature is the primary key, which makes indexing
 * replay-safe by construction (re-processing a signature is a no-op).
 */
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';

let tableReady = false;

export async function ensureSolanaPoolTables(): Promise<void> {
  if (tableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS solana_pool_deposits (
        signature VARCHAR(96) PRIMARY KEY,
        sender VARCHAR(64) NOT NULL,
        amount_raw BIGINT NOT NULL,
        shares_minted_raw BIGINT NOT NULL,
        slot BIGINT NOT NULL,
        block_time TIMESTAMP,
        cluster VARCHAR(16) NOT NULL DEFAULT 'devnet',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_solana_pool_deposits_sender ON solana_pool_deposits(sender);
      CREATE TABLE IF NOT EXISTS solana_pool_withdrawals (
        signature VARCHAR(96) PRIMARY KEY,
        wallet VARCHAR(64) NOT NULL,
        shares_burned_raw BIGINT NOT NULL,
        amount_raw BIGINT NOT NULL,
        cluster VARCHAR(16) NOT NULL DEFAULT 'devnet',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_solana_pool_withdrawals_wallet ON solana_pool_withdrawals(wallet);
    `);
    tableReady = true;
  } catch (err) {
    logger.warn('[SolanaPool] ensureTables failed', {
      error: err instanceof Error ? err.message : err,
    });
  }
}

export interface SolanaDepositRow {
  signature: string;
  sender: string;
  amount_raw: string;
  shares_minted_raw: string;
  slot: string;
  block_time: string | null;
}

/** Idempotent insert — returns true only when the row is NEW. */
export async function recordDeposit(args: {
  signature: string;
  sender: string;
  amountRaw: bigint;
  sharesMintedRaw: bigint;
  slot: number;
  blockTime: number | null;
  cluster: string;
}): Promise<boolean> {
  await ensureSolanaPoolTables();
  const rows = await query<{ signature: string }>(
    `INSERT INTO solana_pool_deposits
       (signature, sender, amount_raw, shares_minted_raw, slot, block_time, cluster)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6), $7)
     ON CONFLICT (signature) DO NOTHING
     RETURNING signature`,
    [
      args.signature,
      args.sender,
      args.amountRaw.toString(),
      args.sharesMintedRaw.toString(),
      args.slot,
      args.blockTime ?? 0,
      args.cluster,
    ],
  );
  return rows.length === 1;
}

export async function getTotalSharesRaw(): Promise<bigint> {
  await ensureSolanaPoolTables();
  const r = await query<{ total: string | null }>(
    `SELECT (COALESCE((SELECT SUM(shares_minted_raw) FROM solana_pool_deposits), 0)
           - COALESCE((SELECT SUM(shares_burned_raw) FROM solana_pool_withdrawals), 0))::text AS total`,
  );
  return BigInt(r[0]?.total ?? '0');
}

/** Ledger-accounted tokens: credited deposits − paid withdrawals. The pricing basis. */
export async function getAccountedTokensRaw(): Promise<bigint> {
  await ensureSolanaPoolTables();
  const r = await query<{ total: string | null }>(
    `SELECT (COALESCE((SELECT SUM(amount_raw) FROM solana_pool_deposits), 0)
           - COALESCE((SELECT SUM(amount_raw) FROM solana_pool_withdrawals), 0))::text AS total`,
  );
  return BigInt(r[0]?.total ?? '0');
}

/** Net shares owned by one wallet: deposits minted − withdrawals burned. */
export async function getWalletSharesRaw(wallet: string): Promise<bigint> {
  await ensureSolanaPoolTables();
  const r = await query<{ total: string | null }>(
    `SELECT (COALESCE((SELECT SUM(shares_minted_raw) FROM solana_pool_deposits WHERE sender = $1), 0)
           - COALESCE((SELECT SUM(shares_burned_raw) FROM solana_pool_withdrawals WHERE wallet = $1), 0))::text AS total`,
    [wallet],
  );
  return BigInt(r[0]?.total ?? '0');
}

/** Idempotent by on-chain signature — replays are no-ops, like deposits. */
export async function recordWithdrawal(args: {
  signature: string;
  wallet: string;
  sharesBurnedRaw: bigint;
  amountRaw: bigint;
  cluster: string;
}): Promise<boolean> {
  await ensureSolanaPoolTables();
  const rows = await query<{ signature: string }>(
    `INSERT INTO solana_pool_withdrawals (signature, wallet, shares_burned_raw, amount_raw, cluster)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (signature) DO NOTHING
     RETURNING signature`,
    [args.signature, args.wallet, args.sharesBurnedRaw.toString(), args.amountRaw.toString(), args.cluster],
  );
  return rows.length === 1;
}

export async function getRecentDeposits(limit = 20): Promise<SolanaDepositRow[]> {
  await ensureSolanaPoolTables();
  return query<SolanaDepositRow>(
    `SELECT signature, sender, amount_raw::text, shares_minted_raw::text, slot::text, block_time
     FROM solana_pool_deposits ORDER BY slot DESC, created_at DESC LIMIT $1`,
    [limit],
  );
}
