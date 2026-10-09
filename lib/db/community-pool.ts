/**
 * Community Pool Database Operations
 * Uses Neon PostgreSQL for persistent storage
 * 
 * Security Features:
 * - Parameterized queries (SQL injection protection)
 * - SSL/TLS with certificate verification
 * - Input validation (wallet addresses, amounts)
 * - Numeric bounds checking
 * - Audit logging
 */

import { query, queryOne } from './postgres';
import { logger } from '@/lib/utils/logger';
import crypto from 'crypto';

// ============ Security Validation ============

/**
 * Validate EVM wallet address format
 * Must be 42 characters starting with 0x, containing only hex characters
 */
function isValidWalletAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  // Accept both EVM (40 hex) and SUI (64 hex) addresses
  return /^0x[a-fA-F0-9]{40}$/.test(address) || /^0x[a-fA-F0-9]{64}$/.test(address);
}

/**
 * Validate SUI wallet address format
 * Must be 66 characters starting with 0x, containing only hex characters
 */
function isValidSuiAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  return /^0x[a-fA-F0-9]{64}$/.test(address);
}

/**
 * Validate wallet address for any chain
 */
function isValidChainAddress(address: string, chain: string): boolean {
  if (!address || typeof address !== 'string') return false;
  if (chain === 'sui') return isValidSuiAddress(address);
  return isValidWalletAddress(address);
}

/**
 * Validate positive number within reasonable bounds
 */
function isValidAmount(amount: number, maxValue = 1e10): boolean {
  return typeof amount === 'number' && 
         Number.isFinite(amount) && 
         amount >= 0 && 
         amount <= maxValue;
}

/**
 * Validate percentage (0-100)
 */
function isValidPercentage(value: number): boolean {
  return typeof value === 'number' && 
         Number.isFinite(value) && 
         value >= 0 && 
         value <= 100;
}

/**
 * Validate transaction type
 */
function isValidTransactionType(type: string): type is 'DEPOSIT' | 'WITHDRAWAL' | 'REBALANCE' | 'AI_DECISION' {
  return ['DEPOSIT', 'WITHDRAWAL', 'REBALANCE', 'AI_DECISION'].includes(type);
}

/**
 * Sanitize string input (prevent XSS in stored data)
 */
function _sanitizeString(input: string, maxLength = 1000): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .slice(0, maxLength)
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .trim();
}

/**
 * Generate audit hash for integrity verification
 */
function generateAuditHash(data: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data) + Date.now())
    .digest('hex')
    .slice(0, 16);
}

// ============ Types ============

export interface DbPoolState {
  id: number;
  chain: string;
  total_value_usd: number;
  total_shares: number;
  share_price: number;
  allocations: Record<string, {
    percentage: number;
    valueUSD: number;
    amount: number;
    price: number;
  }>;
  last_rebalance: Date;
  last_ai_decision: {
    timestamp: number;
    reasoning: string;
    allocations: Record<string, number>;
  } | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbUserShares {
  id: number;
  wallet_address: string;
  chain: string;
  shares: number;
  cost_basis_usd: number;
  joined_at: Date;
  last_action_at: Date;
}

export interface DbPoolTransaction {
  id: number;
  transaction_id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'REBALANCE' | 'AI_DECISION';
  wallet_address: string | null;
  amount_usd: number | null;
  shares: number | null;
  share_price: number | null;
  details: Record<string, unknown> | null;
  tx_hash: string | null;
  created_at: Date;
}

// ============ Pool State Operations ============

/**
 * Get current pool state for a specific chain
 * Each chain has its own independent pool state row
 */
export async function getPoolStateFromDb(chain: string): Promise<DbPoolState | null> {
  try {
    const row = await queryOne<DbPoolState>(
      `SELECT * FROM community_pool_state WHERE chain = $1 LIMIT 1`,
      [chain]
    );
    return row;
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to get pool state', { error, chain });
    return null;
  }
}

/**
 * Upsert pool state (insert or update)
 * Security: Validates all numeric inputs before storage
 */
export async function savePoolStateToDb(state: {
  totalValueUSD: number;
  totalShares: number;
  sharePrice: number;
  allocations: Record<string, { percentage: number; valueUSD: number; amount: number; price: number }>;
  lastRebalance: number;
  lastAIDecision: { timestamp: number; reasoning: string; allocations: Record<string, number> } | null;
  chain: string;
}): Promise<void> {
  const chain = state.chain;

  // Security: Validate all numeric inputs
  if (!isValidAmount(state.totalValueUSD)) {
    throw new Error('Invalid totalValueUSD: must be a positive number');
  }
  if (!isValidAmount(state.totalShares)) {
    throw new Error('Invalid totalShares: must be a positive number');
  }
  if (!isValidAmount(state.sharePrice, 1e12)) {
    throw new Error('Invalid sharePrice: must be a positive number');
  }
  
  // Validate allocations
  for (const [asset, alloc] of Object.entries(state.allocations)) {
    if (!isValidPercentage(alloc.percentage)) {
      throw new Error(`Invalid allocation percentage for ${asset}`);
    }
  }

  try {
    // Upsert per chain — each chain has its own independent pool state row
    await query(
      `INSERT INTO community_pool_state (chain, total_value_usd, total_shares, share_price, allocations, last_rebalance, last_ai_decision, updated_at)
       VALUES ($7, $1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, NOW())
       ON CONFLICT (chain) DO UPDATE SET
         total_value_usd = $1,
         total_shares = $2,
         share_price = $3,
         allocations = $4,
         last_rebalance = to_timestamp($5 / 1000.0),
         last_ai_decision = $6,
         updated_at = NOW()`,
      [
        state.totalValueUSD,
        state.totalShares,
        state.sharePrice,
        JSON.stringify(state.allocations),
        state.lastRebalance,
        state.lastAIDecision ? JSON.stringify(state.lastAIDecision) : null,
        chain,
      ]
    );
    logger.info('[CommunityPool DB] Pool state saved', { chain });
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to save pool state', { error, chain });
    throw error;
  }
}

// ============ User Shares Operations ============

/**
 * Get all user shares
 */
export async function getAllUserSharesFromDb(): Promise<DbUserShares[]> {
  try {
    const rows = await query<DbUserShares>(
      `SELECT * FROM community_pool_shares ORDER BY shares DESC`
    );
    // PostgreSQL returns NUMERIC/DECIMAL as strings; parse to numbers
    return rows.map(row => {
      const shares = Number(row.shares);
      const costBasis = Number(row.cost_basis_usd);
      return {
        ...row,
        shares: Number.isFinite(shares) && shares >= 0 ? shares : 0,
        cost_basis_usd: Number.isFinite(costBasis) && costBasis >= 0 ? costBasis : 0,
      };
    });
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to get all user shares', error);
    return [];
  }
}

/**
 * Get user shares by wallet address and chain
 * Security: Validates wallet address format based on chain
 */
export async function getUserSharesFromDb(walletAddress: string, chain: string): Promise<DbUserShares | null> {
  // Security: Validate wallet address format based on chain
  if (!isValidChainAddress(walletAddress, chain)) {
    logger.warn('[CommunityPool DB] Invalid wallet address format', { wallet: walletAddress?.slice(0, 10), chain });
    return null;
  }

  try {
    const row = await queryOne<DbUserShares>(
      `SELECT * FROM community_pool_shares WHERE LOWER(wallet_address) = LOWER($1) AND chain = $2`,
      [walletAddress, chain]
    );
    if (!row) return null;
    // PostgreSQL returns NUMERIC/DECIMAL as strings; parse to numbers
    const shares = Number(row.shares);
    const costBasis = Number(row.cost_basis_usd);
    return {
      ...row,
      shares: Number.isFinite(shares) && shares >= 0 ? shares : 0,
      cost_basis_usd: Number.isFinite(costBasis) && costBasis >= 0 ? costBasis : 0,
    };
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to get user shares', error);
    return null;
  }
}

/**
 * Upsert user shares for a specific chain
 * Security: Validates wallet address and numeric inputs
 */
export async function saveUserSharesToDb(userShares: {
  walletAddress: string;
  shares: number;
  costBasisUSD: number;
  chain: string;
}): Promise<void> {
  const chain = userShares.chain;
  
  // Security: Validate wallet address based on chain
  if (!isValidChainAddress(userShares.walletAddress, chain)) {
    throw new Error(`Invalid wallet address format for ${chain}`);
  }
  // Security: Validate numeric inputs
  if (!isValidAmount(userShares.shares)) {
    throw new Error('Invalid shares amount: must be a positive number');
  }
  if (!isValidAmount(userShares.costBasisUSD)) {
    throw new Error('Invalid cost basis: must be a positive number');
  }

  try {
    // Atomic UPSERT — prevents race condition on concurrent deposits to same wallet
    await query(
      `INSERT INTO community_pool_shares (wallet_address, chain, shares, cost_basis_usd, joined_at, last_action_at)
       VALUES (LOWER($1), $2, $3, $4, NOW(), NOW())
       ON CONFLICT (LOWER(wallet_address), chain) DO UPDATE SET
         shares = $3,
         cost_basis_usd = $4,
         last_action_at = NOW()`,
      [userShares.walletAddress, chain, userShares.shares, userShares.costBasisUSD]
    );
    logger.info('[CommunityPool DB] User shares saved', { wallet: userShares.walletAddress, chain, shares: userShares.shares });
  } catch (error) {
    // Fallback: The ON CONFLICT may fail on some PG versions if unique index is on expression
    // In that case, use the explicit check-then-update pattern
    const pgErr = error as { code?: string };
    if (pgErr.code === '42P10' || pgErr.code === '42712') {
      logger.debug('[CommunityPool DB] Atomic UPSERT not supported on index expression, falling back');
      const existing = await queryOne<{ id: number }>(
        `SELECT id FROM community_pool_shares WHERE LOWER(wallet_address) = LOWER($1) AND chain = $2`,
        [userShares.walletAddress, chain]
      );
      if (existing) {
        await query(
          `UPDATE community_pool_shares SET
             shares = $2,
             cost_basis_usd = $3,
             last_action_at = NOW()
           WHERE LOWER(wallet_address) = LOWER($1) AND chain = $4`,
          [userShares.walletAddress, userShares.shares, userShares.costBasisUSD, chain]
        );
      } else {
        await query(
          `INSERT INTO community_pool_shares (wallet_address, chain, shares, cost_basis_usd, joined_at, last_action_at)
           VALUES (LOWER($1), $2, $3, $4, NOW(), NOW())`,
          [userShares.walletAddress, chain, userShares.shares, userShares.costBasisUSD]
        );
      }
      logger.info('[CommunityPool DB] User shares saved (fallback path)', { wallet: userShares.walletAddress, chain });
    } else {
      logger.error('[CommunityPool DB] Failed to save user shares', error);
      throw error;
    }
  }
}

/**
 * Delete user shares for a specific chain (when fully withdrawn)
 * Security: Validates wallet address format based on chain
 */
export async function deleteUserSharesFromDb(walletAddress: string, chain: string): Promise<void> {
  // Security: Validate wallet address based on chain
  if (!isValidChainAddress(walletAddress, chain)) {
    throw new Error(`Invalid wallet address format for ${chain}`);
  }

  try {
    await query(
      `DELETE FROM community_pool_shares WHERE LOWER(wallet_address) = LOWER($1) AND chain = $2`,
      [walletAddress, chain]
    );
    logger.info('[CommunityPool DB] User shares deleted', { wallet: walletAddress, chain });
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to delete user shares', error);
    throw error;
  }
}

// ============ Transaction History Operations ============

/**
 * Get user transaction counts (deposits and withdrawals)
 * Security: Validates wallet address format
 */
export async function getUserTransactionCounts(walletAddress: string, chain?: string): Promise<{ depositCount: number; withdrawalCount: number }> {
  // Security: Validate wallet address (accept both EVM and SUI)
  if (!isValidWalletAddress(walletAddress)) {
    return { depositCount: 0, withdrawalCount: 0 };
  }

  try {
    const result = chain
      ? await queryOne<{ deposit_count: string; withdrawal_count: string }>(
          `SELECT 
             COUNT(*) FILTER (WHERE type = 'DEPOSIT') as deposit_count,
             COUNT(*) FILTER (WHERE type = 'WITHDRAWAL') as withdrawal_count
           FROM community_pool_transactions 
           WHERE LOWER(wallet_address) = LOWER($1) AND chain = $2`,
          [walletAddress, chain]
        )
      : await queryOne<{ deposit_count: string; withdrawal_count: string }>(
          `SELECT 
             COUNT(*) FILTER (WHERE type = 'DEPOSIT') as deposit_count,
             COUNT(*) FILTER (WHERE type = 'WITHDRAWAL') as withdrawal_count
           FROM community_pool_transactions 
           WHERE LOWER(wallet_address) = LOWER($1)`,
          [walletAddress]
        );
    
    return {
      depositCount: parseInt(result?.deposit_count || '0', 10),
      withdrawalCount: parseInt(result?.withdrawal_count || '0', 10),
    };
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to get user transaction counts', error);
    return { depositCount: 0, withdrawalCount: 0 };
  }
}

/**
 * Get pool transaction history
 * Security: Limits query size to prevent resource exhaustion
 */
export async function getPoolHistoryFromDb(limit = 100, chain?: string): Promise<DbPoolTransaction[]> {
  // Security: Cap limit to prevent resource exhaustion attacks
  const safeLimit = Math.min(Math.max(1, limit), 500);
  
  try {
    if (chain) {
      return await query<DbPoolTransaction>(
        `SELECT * FROM community_pool_transactions WHERE chain = $2 ORDER BY created_at DESC LIMIT $1`,
        [safeLimit, chain]
      );
    }
    return await query<DbPoolTransaction>(
      `SELECT * FROM community_pool_transactions ORDER BY created_at DESC LIMIT $1`,
      [safeLimit]
    );
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to get pool history', error);
    return [];
  }
}

/**
 * Check if a transaction with this txHash already exists (idempotency check)
 * @returns true if txHash already recorded, false otherwise
 */
export async function txHashExists(txHash: string): Promise<boolean> {
  if (!txHash) return false;
  try {
    const result = await queryOne(
      // EVM hashes may be stored in either case; a Sui digest is case-sensitive.
      `SELECT 1 FROM community_pool_transactions WHERE tx_hash = $1 OR tx_hash = $2 LIMIT 1`,
      [txHash, txHash.toLowerCase()]
    );
    return !!result;
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to check txHash', error);
    return false; // Err on the side of allowing (on-chain is authoritative anyway)
  }
}

/**
 * Add transaction to history
 * Security: Validates transaction type, wallet address, and amounts
 */
export async function addPoolTransactionToDb(transaction: {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'REBALANCE' | 'AI_DECISION';
  walletAddress?: string;
  amountUSD?: number;
  shares?: number;
  sharePrice?: number;
  details?: Record<string, unknown>;
  txHash?: string;
  chain: string;
}): Promise<void> {
  // Security: Validate transaction type
  if (!isValidTransactionType(transaction.type)) {
    throw new Error('Invalid transaction type');
  }
  
  // Security: Validate wallet address if provided
  if (transaction.walletAddress && !isValidWalletAddress(transaction.walletAddress)) {
    throw new Error('Invalid wallet address format');
  }
  
  // Security: Validate numeric amounts if provided
  if (transaction.amountUSD !== undefined && !isValidAmount(transaction.amountUSD)) {
    throw new Error('Invalid amount: must be a positive number');
  }
  if (transaction.shares !== undefined && !isValidAmount(transaction.shares)) {
    throw new Error('Invalid shares: must be a positive number');
  }
  if (transaction.sharePrice !== undefined && !isValidAmount(transaction.sharePrice, 1e12)) {
    throw new Error('Invalid share price: must be a positive number');
  }
  
  const chain = transaction.chain;

  // Security: Generate audit hash for integrity
  const auditHash = generateAuditHash({
    id: transaction.id,
    type: transaction.type,
    wallet: transaction.walletAddress,
    amount: transaction.amountUSD,
  });

  try {
    // Idempotency: skip if this txHash already recorded (prevents double-minting on retries)
    if (transaction.txHash) {
      const exists = await txHashExists(transaction.txHash);
      if (exists) {
        logger.info('[CommunityPool DB] Transaction already recorded, skipping (idempotent)', {
          txHash: transaction.txHash,
          type: transaction.type,
        });
        return;
      }
    }

    await query(
      `INSERT INTO community_pool_transactions 
       (transaction_id, type, wallet_address, amount_usd, shares, share_price, details, tx_hash, chain, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        transaction.id,
        transaction.type,
        transaction.walletAddress?.toLowerCase() || null,
        transaction.amountUSD || null,
        transaction.shares || null,
        transaction.sharePrice || null,
        transaction.details ? JSON.stringify({ ...transaction.details, _audit: auditHash }) : JSON.stringify({ _audit: auditHash }),
        transaction.txHash || null,
        chain,
      ]
    );
    logger.info('[CommunityPool DB] Transaction added', { 
      id: transaction.id, 
      type: transaction.type,
      audit: auditHash,
    });
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to add transaction', error);
    throw error;
  }
}

// ============ NAV History Operations ============

export interface DbNavSnapshot {
  id: number;
  timestamp: Date;
  share_price: number;
  total_nav: number;
  total_shares: number;
  member_count: number;
  allocations: Record<string, number> | null;
  source: string;
  created_at: Date;
}

/**
 * Record a NAV snapshot (called periodically by cron job)
 * Security: Validates numeric values
 */
export async function recordNavSnapshot(snapshot: {
  sharePrice: number;
  totalNav: number;
  totalShares: number;
  memberCount: number;
  allocations?: Record<string, number>;
  source?: string;
  timestamp?: Date;
  chain: string;
}): Promise<void> {
  // Validate inputs
  if (!isValidAmount(snapshot.sharePrice, 1e9)) {
    throw new Error('Invalid share price');
  }
  if (!isValidAmount(snapshot.totalNav, 1e18)) {
    throw new Error('Invalid total NAV');
  }

  const chain = snapshot.chain;

  try {
    await query(
      `INSERT INTO community_pool_nav_history 
       (timestamp, share_price, total_nav, total_shares, member_count, allocations, source, chain)
       VALUES ($7, $1, $2, $3, $4, $5, $6, $8)`,
      [
        snapshot.sharePrice,
        snapshot.totalNav,
        snapshot.totalShares,
        snapshot.memberCount,
        snapshot.allocations ? JSON.stringify(snapshot.allocations) : null,
        snapshot.source || 'on-chain',
        snapshot.timestamp || new Date(),
        chain,
      ]
    );
    logger.debug('[CommunityPool DB] NAV snapshot recorded', { 
      sharePrice: snapshot.sharePrice,
      totalNav: snapshot.totalNav,
      chain,
    });
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to record NAV snapshot', error);
    throw error;
  }
}

/**
 * Get NAV history for risk metrics calculation
 * Returns snapshots ordered by timestamp ascending (oldest first)
 */
export async function getNavHistory(daysBack = 365, chain?: string): Promise<DbNavSnapshot[]> {
  const safeDays = Math.min(Math.max(1, daysBack), 730); // Max 2 years

  // A failed read throws: an empty list here was read as "no history", and
  // the NAV monitor then replaced the stored peak with the current NAV.
  if (chain) {
    return query<DbNavSnapshot>(
      `SELECT * FROM community_pool_nav_history
       WHERE timestamp >= NOW() - make_interval(days => $1)
         AND chain = $2
       ORDER BY timestamp ASC`,
      [safeDays, chain]
    );
  }
  return query<DbNavSnapshot>(
    `SELECT * FROM community_pool_nav_history
     WHERE timestamp >= NOW() - make_interval(days => $1)
     ORDER BY timestamp ASC`,
    [safeDays]
  );
}

/**
 * Get latest NAV snapshot
 */
export async function getLatestNavSnapshot(chain?: string): Promise<DbNavSnapshot | null> {
  try {
    if (chain) {
      return await queryOne<DbNavSnapshot>(
        `SELECT * FROM community_pool_nav_history WHERE chain = $1 ORDER BY timestamp DESC LIMIT 1`,
        [chain]
      );
    }
    return await queryOne<DbNavSnapshot>(
      `SELECT * FROM community_pool_nav_history ORDER BY timestamp DESC LIMIT 1`,
      []
    );
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to get latest NAV snapshot', error);
    return null;
  }
}

/**
 * Delete old NAV snapshots (cleanup, keep last N days)
 */
export async function cleanupOldNavSnapshots(keepDays = 365): Promise<number> {
  const safeDays = Math.min(Math.max(1, keepDays), 730);
  try {
    const result = await query(
      `DELETE FROM community_pool_nav_history WHERE timestamp < NOW() - make_interval(days => $1) RETURNING id`,
      [safeDays]
    );
    logger.info('[CommunityPool DB] Cleaned up old NAV snapshots', { deleted: result.length });
    return result.length;
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to cleanup NAV snapshots', error);
    return 0;
  }
}

/**
 * Insert an inception snapshot at a specific timestamp
 * Used to establish true all-time baseline without deleting existing data
 */
export async function insertInceptionSnapshot(
  timestamp: Date,
  sharePrice: number,
  totalNav: number,
  totalShares: number,
  memberCount: number,
  allocations?: Record<string, number>
): Promise<boolean> {
  try {
    // Check if an inception record already exists before this timestamp
    const existing = await queryOne(
      `SELECT id FROM community_pool_nav_history WHERE timestamp <= $1 ORDER BY timestamp ASC LIMIT 1`,
      [timestamp]
    );
    
    if (existing) {
      logger.info('[CommunityPool DB] Inception snapshot already exists, skipping', { timestamp });
      return false;
    }
    
    await query(
      `INSERT INTO community_pool_nav_history 
       (timestamp, share_price, total_nav, total_shares, member_count, allocations, source)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'inception')`,
      [timestamp, sharePrice, totalNav, totalShares, memberCount, JSON.stringify(allocations || {})]
    );
    logger.info('[CommunityPool DB] Inserted inception snapshot', { 
      timestamp, 
      sharePrice, 
      totalNav 
    });
    
    return true;
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to insert inception snapshot', error);
    throw error;
  }
}

/**
 * Reset NAV history completely and insert a fresh starting point
 * Used when bad data has accumulated
 */
export async function resetNavHistory(currentNav: number, sharePrice: number, totalShares: number, memberCount: number, allocations?: Record<string, number>): Promise<{ deleted: number; inserted: boolean }> {
  try {
    // Delete all NAV history
    const deleted = await query(
      `DELETE FROM community_pool_nav_history RETURNING id`,
      []
    );
    logger.info('[CommunityPool DB] Deleted all NAV history', { count: deleted.length });
    
    // Insert fresh starting point
    await query(
      `INSERT INTO community_pool_nav_history 
       (total_nav, share_price, total_shares, member_count, allocations, source)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'manual-reset')`,
      [currentNav, sharePrice, totalShares, memberCount, JSON.stringify(allocations || {})]
    );
    logger.info('[CommunityPool DB] Inserted fresh NAV snapshot', { nav: currentNav, sharePrice, totalShares });
    
    return { deleted: deleted.length, inserted: true };
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to reset NAV history', error);
    throw error;
  }
}

// ============ Table Initialization ============

/**
 * Initialize community pool tables (run once on startup or via migration)
 */
export async function initCommunityPoolTables(): Promise<void> {
  try {
    // Pool state table — one row PER CHAIN (independent pool states)
    await query(`
      CREATE TABLE IF NOT EXISTS community_pool_state (
        id SERIAL PRIMARY KEY,
        chain VARCHAR(50) NOT NULL DEFAULT 'cronos' UNIQUE,
        total_value_usd DECIMAL(20, 2) NOT NULL DEFAULT 0,
        total_shares DECIMAL(20, 8) NOT NULL DEFAULT 0,
        share_price DECIMAL(20, 8) NOT NULL DEFAULT 1.0,
        allocations JSONB NOT NULL DEFAULT '{}',
        last_rebalance TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_ai_decision JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Migration: Add chain column if table already exists without it, drop legacy single_row CHECK
    await query(`ALTER TABLE community_pool_state DROP CONSTRAINT IF EXISTS single_row`).catch(() => {});
    await query(`ALTER TABLE community_pool_state ADD COLUMN IF NOT EXISTS chain VARCHAR(50) NOT NULL DEFAULT 'cronos'`).catch(() => {});
    // Set chain='cronos' for existing rows that have NULL chain (safety)
    await query(`UPDATE community_pool_state SET chain = 'cronos' WHERE chain IS NULL OR chain = ''`).catch(() => {});
    // Add unique constraint on chain (idempotent)
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_state_chain ON community_pool_state(chain)`).catch(() => {});

    // User shares table (with chain support for multi-chain)
    await query(`
      CREATE TABLE IF NOT EXISTS community_pool_shares (
        id SERIAL PRIMARY KEY,
        wallet_address VARCHAR(255) NOT NULL,
        chain VARCHAR(50) NOT NULL DEFAULT 'cronos',
        shares DECIMAL(20, 8) NOT NULL DEFAULT 0,
        cost_basis_usd DECIMAL(20, 2) NOT NULL DEFAULT 0,
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_action_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(wallet_address, chain)
      )
    `);
    
    // Migration: Add chain column if table already exists without it
    await query(`
      ALTER TABLE community_pool_shares 
      ADD COLUMN IF NOT EXISTS chain VARCHAR(50) NOT NULL DEFAULT 'cronos'
    `).catch(() => {}); // Ignore if column exists

    // Transaction history table (with chain for per-chain isolation)
    await query(`
      CREATE TABLE IF NOT EXISTS community_pool_transactions (
        id SERIAL PRIMARY KEY,
        transaction_id VARCHAR(255) NOT NULL UNIQUE,
        type VARCHAR(50) NOT NULL,
        wallet_address VARCHAR(255),
        amount_usd DECIMAL(20, 2),
        shares DECIMAL(20, 8),
        share_price DECIMAL(20, 8),
        details JSONB,
        tx_hash VARCHAR(255),
        chain VARCHAR(50) NOT NULL DEFAULT 'cronos',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Migration: Add chain column to transactions if missing
    await query(`ALTER TABLE community_pool_transactions ADD COLUMN IF NOT EXISTS chain VARCHAR(50) NOT NULL DEFAULT 'cronos'`).catch(() => {});
    // Migrate existing SUI transactions based on details JSON
    await query(`UPDATE community_pool_transactions SET chain = 'sui' WHERE chain = 'cronos' AND details->>'chain' = 'sui'`).catch(() => {});

    // NAV history table for risk metrics (hourly snapshots from on-chain, per chain)
    await query(`
      CREATE TABLE IF NOT EXISTS community_pool_nav_history (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        share_price DECIMAL(20, 8) NOT NULL,
        total_nav DECIMAL(20, 2) NOT NULL,
        total_shares DECIMAL(20, 8) NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0,
        allocations JSONB,
        source VARCHAR(50) DEFAULT 'on-chain',
        chain VARCHAR(50) NOT NULL DEFAULT 'cronos',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Migration: Add chain column to NAV history if missing
    await query(`ALTER TABLE community_pool_nav_history ADD COLUMN IF NOT EXISTS chain VARCHAR(50) NOT NULL DEFAULT 'cronos'`).catch(() => {});
    // Migrate existing SUI NAV snapshots based on source field
    await query(`UPDATE community_pool_nav_history SET chain = 'sui' WHERE chain = 'cronos' AND source LIKE 'sui%'`).catch(() => {});

    // Create indexes (including txHash uniqueness for idempotency and chain filtering)
    // Compound indexes for common multi-user query patterns
    await query(`
      CREATE INDEX IF NOT EXISTS idx_pool_shares_wallet ON community_pool_shares(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_pool_shares_wallet_chain ON community_pool_shares(wallet_address, chain);
      CREATE INDEX IF NOT EXISTS idx_pool_tx_type ON community_pool_transactions(type);
      CREATE INDEX IF NOT EXISTS idx_pool_tx_wallet ON community_pool_transactions(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_pool_tx_wallet_chain ON community_pool_transactions(wallet_address, chain);
      CREATE INDEX IF NOT EXISTS idx_pool_tx_created ON community_pool_transactions(created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_tx_hash ON community_pool_transactions(tx_hash) WHERE tx_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pool_tx_chain ON community_pool_transactions(chain);
      CREATE INDEX IF NOT EXISTS idx_pool_nav_timestamp ON community_pool_nav_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_pool_nav_chain ON community_pool_nav_history(chain);
      CREATE INDEX IF NOT EXISTS idx_pool_nav_chain_timestamp ON community_pool_nav_history(chain, timestamp DESC);
    `);
    
    // Add case-insensitive unique index for wallet addresses (prevents duplicates due to case differences)
    // First, deduplicate any existing entries and normalize to lowercase
    try {
      // Consolidate duplicates: keep the one with highest shares, sum if needed
      await query(`
        WITH duplicates AS (
          SELECT LOWER(wallet_address) as lower_addr, 
                 MAX(shares) as max_shares,
                 MAX(cost_basis_usd) as max_cost_basis,
                 MIN(joined_at) as first_joined,
                 MAX(last_action_at) as last_action
          FROM community_pool_shares 
          GROUP BY LOWER(wallet_address)
          HAVING COUNT(*) > 1
        )
        UPDATE community_pool_shares s
        SET wallet_address = LOWER(wallet_address),
            shares = d.max_shares,
            cost_basis_usd = d.max_cost_basis,
            joined_at = d.first_joined,
            last_action_at = d.last_action
        FROM duplicates d
        WHERE LOWER(s.wallet_address) = d.lower_addr
          AND s.id = (SELECT MIN(id) FROM community_pool_shares WHERE LOWER(wallet_address) = d.lower_addr)
      `);
      
      // Delete the duplicate rows (keep the one we just updated)
      await query(`
        DELETE FROM community_pool_shares a
        USING community_pool_shares b
        WHERE a.id > b.id 
          AND LOWER(a.wallet_address) = LOWER(b.wallet_address)
      `);
      
      // Normalize all remaining addresses to lowercase
      await query(`UPDATE community_pool_shares SET wallet_address = LOWER(wallet_address)`);
      
      // Create case-insensitive unique index (if not exists)
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_shares_wallet_lower 
        ON community_pool_shares(LOWER(wallet_address))
      `);
    } catch (dedupeError) {
      // Log but don't fail - index may already exist
      logger.warn('[CommunityPool DB] Deduplication/index creation note', { error: String(dedupeError) });
    }

    // Seed initial pool state for each active chain (if not exists)
    const activeChains = ['hedera', 'sui'];
    for (const chainKey of activeChains) {
      // Per-chain asset configuration
      const chainAssets = chainKey === 'sui'
        ? ['BTC', 'ETH', 'SUI', 'CRO']
        : ['BTC', 'ETH', 'USDT'];
      const allocs: Record<string, { percentage: number; valueUSD: number; amount: number; price: number }> = {};
      for (const a of chainAssets) {
        allocs[a] = { percentage: 0, valueUSD: 0, amount: 0, price: 0 };
      }
      await query(
        `INSERT INTO community_pool_state (chain, total_value_usd, total_shares, share_price, allocations)
         VALUES ($1, 0, 0, 1.0, $2)
         ON CONFLICT (chain) DO NOTHING`,
        [chainKey, JSON.stringify(allocs)]
      ).catch(() => {}); // Ignore if unique constraint prevents duplicate
    }

    logger.info('[CommunityPool DB] Tables initialized successfully');
  } catch (error) {
    logger.error('[CommunityPool DB] Failed to initialize tables', error);
    throw error;
  }
}
