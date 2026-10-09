/**
 * Solana pool storage — deposits/withdrawals ledger + NAV history snapshots.
 *
 * Deliberately no state/balance row: the vault's token balance is read live
 * from chain (chain = truth), and total shares derive from SUM(shares_minted).
 * nav_history is display-only (the dashboard chart), never a pricing input.
 * The transaction signature is the primary key, which makes indexing
 * replay-safe by construction (re-processing a signature is a no-op).
 *
 * Every read and write is scoped to the configured cluster. The tables hold
 * devnet rows from the test pool; unscoped sums would make those shares
 * payable in mainnet tokens the day the cluster changes.
 */
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { solanaCluster } from '@/lib/services/solana/cluster';

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
      ALTER TABLE solana_pool_withdrawals ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'paid';
      ALTER TABLE solana_pool_withdrawals ADD COLUMN IF NOT EXISTS last_valid_block_height BIGINT;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_solana_pool_withdrawals_pending
        ON solana_pool_withdrawals(wallet, cluster) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS solana_pool_nav_history (
        id BIGSERIAL PRIMARY KEY,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        share_price DOUBLE PRECISION NOT NULL,
        nav_usd DOUBLE PRECISION,
        accounted_tokens_raw BIGINT NOT NULL,
        total_shares_raw BIGINT NOT NULL,
        cluster VARCHAR(16) NOT NULL DEFAULT 'devnet'
      );
      CREATE INDEX IF NOT EXISTS idx_solana_pool_nav_history_at ON solana_pool_nav_history(recorded_at);
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
      solanaCluster(),
    ],
  );
  return rows.length === 1;
}

/**
 * Shares outstanding. A pending withdrawal counts as burned from the moment
 * it is reserved, so the same shares cannot back a second payout.
 */
export async function getTotalSharesRaw(): Promise<bigint> {
  await ensureSolanaPoolTables();
  const r = await query<{ total: string | null }>(
    `SELECT (COALESCE((SELECT SUM(shares_minted_raw) FROM solana_pool_deposits WHERE cluster = $1), 0)
           - COALESCE((SELECT SUM(shares_burned_raw) FROM solana_pool_withdrawals WHERE cluster = $1), 0))::text AS total`,
    [solanaCluster()],
  );
  return BigInt(r[0]?.total ?? '0');
}

/** Ledger-accounted tokens: credited deposits − withdrawals paid or reserved. The pricing basis. */
export async function getAccountedTokensRaw(): Promise<bigint> {
  await ensureSolanaPoolTables();
  const r = await query<{ total: string | null }>(
    `SELECT (COALESCE((SELECT SUM(amount_raw) FROM solana_pool_deposits WHERE cluster = $1), 0)
           - COALESCE((SELECT SUM(amount_raw) FROM solana_pool_withdrawals WHERE cluster = $1), 0))::text AS total`,
    [solanaCluster()],
  );
  return BigInt(r[0]?.total ?? '0');
}

/** Net shares owned by one wallet: deposits minted − withdrawals burned or reserved. */
export async function getWalletSharesRaw(wallet: string): Promise<bigint> {
  await ensureSolanaPoolTables();
  const r = await query<{ total: string | null }>(
    `SELECT (COALESCE((SELECT SUM(shares_minted_raw) FROM solana_pool_deposits WHERE sender = $1 AND cluster = $2), 0)
           - COALESCE((SELECT SUM(shares_burned_raw) FROM solana_pool_withdrawals WHERE wallet = $1 AND cluster = $2), 0))::text AS total`,
    [wallet, solanaCluster()],
  );
  return BigInt(r[0]?.total ?? '0');
}

/** Wallets currently holding shares (minted − burned > 0), largest first. */
export async function getMembers(): Promise<{ wallet: string; sharesRaw: bigint }[]> {
  await ensureSolanaPoolTables();
  const r = await query<{ wallet: string; shares: string }>(
    `SELECT d.wallet, (d.minted - COALESCE(w.burned, 0))::text AS shares
     FROM (SELECT sender AS wallet, SUM(shares_minted_raw) AS minted FROM solana_pool_deposits WHERE cluster = $1 GROUP BY sender) d
     LEFT JOIN (SELECT wallet, SUM(shares_burned_raw) AS burned FROM solana_pool_withdrawals WHERE cluster = $1 GROUP BY wallet) w
       ON w.wallet = d.wallet
     WHERE d.minted - COALESCE(w.burned, 0) > 0
     ORDER BY d.minted - COALESCE(w.burned, 0) DESC`,
    [solanaCluster()],
  );
  return r.map((m) => ({ wallet: m.wallet, sharesRaw: BigInt(m.shares) }));
}

// ── Withdrawals: reserve, then pay ───────────────────────────────────
//
// A payout is two systems that cannot commit together: the ledger and the
// chain. The order that cannot pay twice is ledger first. The shares are
// burned as a `pending` row before anything is signed; the payout's own
// signature is stored before it is sent; the row becomes `paid` when the
// chain shows the transfer, or is removed when the chain shows it can no
// longer happen. Until one of those is known the shares stay burned.

export interface PendingWithdrawal {
  /** The payout's signature once one is signed; `reservationId` before that. */
  signature: string;
  wallet: string;
  amountRaw: bigint;
  sharesBurnedRaw: bigint;
  lastValidBlockHeight: number | null;
  ageSeconds: number;
}

/** A reservation's key before its payout is signed. Bound to the nonce, so a replayed request collides. */
export const reservationId = (nonce: string): string => `pending:${nonce}`;
export const isUnsigned = (signature: string): boolean => signature.startsWith('pending:');

/**
 * Burn the shares for a payout that has not been sent yet.
 *   'reserved' — this caller holds the wallet's one pending withdrawal;
 *   'replay'   — this nonce was already used;
 *   'busy'     — the wallet has another withdrawal in flight.
 */
export async function reserveWithdrawal(args: {
  nonce: string;
  wallet: string;
  sharesBurnedRaw: bigint;
  amountRaw: bigint;
}): Promise<'reserved' | 'replay' | 'busy'> {
  await ensureSolanaPoolTables();
  try {
    const rows = await query<{ signature: string }>(
      `INSERT INTO solana_pool_withdrawals (signature, wallet, shares_burned_raw, amount_raw, cluster, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (signature) DO NOTHING
       RETURNING signature`,
      [reservationId(args.nonce), args.wallet, args.sharesBurnedRaw.toString(), args.amountRaw.toString(), solanaCluster()],
    );
    return rows.length === 1 ? 'reserved' : 'replay';
  } catch (e) {
    // The one-pending-per-wallet index. Anything else is a real failure.
    if ((e as { code?: string })?.code === '23505') return 'busy';
    throw e;
  }
}

/** Record the payout's signature and expiry BEFORE it is sent. False when the reservation is gone. */
export async function attachPayoutSignature(nonce: string, signature: string, lastValidBlockHeight: number): Promise<boolean> {
  const rows = await query<{ signature: string }>(
    `UPDATE solana_pool_withdrawals SET signature = $2, last_valid_block_height = $3
     WHERE signature = $1 AND status = 'pending' RETURNING signature`,
    [reservationId(nonce), signature, lastValidBlockHeight],
  );
  return rows.length === 1;
}

/** The chain shows the payout: the burn is final. */
export async function settleWithdrawal(signature: string): Promise<void> {
  await query(`UPDATE solana_pool_withdrawals SET status = 'paid' WHERE signature = $1 AND status = 'pending'`, [signature]);
}

/** The payout can never land: give the shares back. Only ever removes a pending row. */
export async function releaseWithdrawal(signature: string): Promise<void> {
  await query(`DELETE FROM solana_pool_withdrawals WHERE signature = $1 AND status = 'pending'`, [signature]);
}

export async function getPendingWithdrawals(): Promise<PendingWithdrawal[]> {
  await ensureSolanaPoolTables();
  const rows = await query<{
    signature: string; wallet: string; amount_raw: string; shares_burned_raw: string;
    last_valid_block_height: string | null; age: number;
  }>(
    `SELECT signature, wallet, amount_raw::text, shares_burned_raw::text, last_valid_block_height::text,
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at))::float AS age
     FROM solana_pool_withdrawals WHERE status = 'pending' AND cluster = $1 ORDER BY created_at`,
    [solanaCluster()],
  );
  return rows.map((r) => ({
    signature: r.signature,
    wallet: r.wallet,
    amountRaw: BigInt(r.amount_raw),
    sharesBurnedRaw: BigInt(r.shares_burned_raw),
    lastValidBlockHeight: r.last_valid_block_height === null ? null : Number(r.last_valid_block_height),
    ageSeconds: Number(r.age) || 0,
  }));
}

const NAV_HISTORY_RETENTION_DAYS = 180;

/** One NAV snapshot; prunes past the retention window in the same call. */
export async function recordNavSnapshot(args: {
  sharePrice: number;
  navUsd: number | null;
  accountedTokensRaw: bigint;
  totalSharesRaw: bigint;
}): Promise<void> {
  await ensureSolanaPoolTables();
  await query(
    `INSERT INTO solana_pool_nav_history (share_price, nav_usd, accounted_tokens_raw, total_shares_raw, cluster)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.sharePrice, args.navUsd, args.accountedTokensRaw.toString(), args.totalSharesRaw.toString(), solanaCluster()],
  );
  await query(
    `DELETE FROM solana_pool_nav_history WHERE recorded_at < NOW() - make_interval(days => $1)`,
    [NAV_HISTORY_RETENTION_DAYS],
  );
}

/** Bucket-averaged NAV history; `days = null` returns everything kept. */
export async function getNavHistory(
  days: number | null,
  bucket: 'hour' | 'day',
): Promise<Array<{ t: string; share_price: number; nav_usd: number | null }>> {
  await ensureSolanaPoolTables();
  return query(
    `SELECT date_trunc($1, recorded_at) AS t,
            AVG(share_price)::float AS share_price,
            AVG(nav_usd)::float AS nav_usd
     FROM solana_pool_nav_history
     WHERE cluster = $3 AND ($2::int IS NULL OR recorded_at > NOW() - make_interval(days => $2::int))
     GROUP BY 1 ORDER BY 1`,
    [bucket, days, solanaCluster()],
  );
}

export async function getRecentDeposits(limit = 20): Promise<SolanaDepositRow[]> {
  await ensureSolanaPoolTables();
  return query<SolanaDepositRow>(
    `SELECT signature, sender, amount_raw::text, shares_minted_raw::text, slot::text, block_time
     FROM solana_pool_deposits WHERE cluster = $2 ORDER BY slot DESC, created_at DESC LIMIT $1`,
    [limit, solanaCluster()],
  );
}
