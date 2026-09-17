import { query, queryOne } from './postgres';
import crypto from 'crypto';
import { logger } from '@/lib/utils/logger';

// Schema + on-chain queries moved to sibling modules for readability;
// re-exported so callers of '@/lib/db/hedges' don't need to know.
export { ensureHedgesTable, type Hedge, type CreateHedgeParams } from './hedges-schema';
export {
  type OnChainHedgeParams,
  upsertOnChainHedge,
  resyncOnChainHedge,
  getOnChainHedgeByHedgeId,
  getTxHashesFromDb,
  cacheTxHashes,
  getHedgeByOnchainId,
  closeHedgeByOnchainId,
  recordSuiOnchainHedge,
  listActiveSuiOnchainHedges,
} from './hedges-onchain';

import { ensureHedgesTable, type Hedge, type CreateHedgeParams } from './hedges-schema';

/**
 * Generate a deterministic wallet binding hash for ZK ownership verification
 * This hash cryptographically binds a hedge to a wallet without revealing the wallet address
 */
export function generateWalletBindingHash(walletAddress: string, hedgeId: string, secret?: string): string {
  const data = `zk-binding:${walletAddress.toLowerCase()}:${hedgeId}:${secret || 'zkvanguard'}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate an owner commitment for ZK proof verification
 * This allows proving ownership without revealing the actual wallet address
 */
export function generateOwnerCommitment(walletAddress: string, timestamp: number): string {
  const data = `owner-commitment:${walletAddress.toLowerCase()}:${timestamp}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Verify if a wallet owns a hedge via ZK binding
 * Returns true if the computed binding matches the stored binding
 */
export function verifyZKOwnership(walletAddress: string, hedgeId: string, storedBinding: string, secret?: string): boolean {
  const computedBinding = generateWalletBindingHash(walletAddress, hedgeId, secret);
  return computedBinding === storedBinding;
}

export async function createHedge(params: CreateHedgeParams): Promise<Hedge> {
  await ensureHedgesTable();
  // Generate ZK binding hash using OWNER wallet (not proxy)
  // This ensures funds always return to owner even when using proxy
  const walletBindingHash = params.walletAddress 
    ? params.walletBindingHash || generateWalletBindingHash(params.walletAddress, params.orderId)
    : null;
  
  // Generate owner commitment for ZK verification
  const ownerCommitment = params.walletAddress
    ? params.ownerCommitment || generateOwnerCommitment(params.walletAddress, Date.now())
    : null;

  // Build metadata including proxy wallet info if provided
  const metadata = {
    ...params.metadata,
    // Store proxy wallet separately if used (for privacy)
    proxyWallet: params.proxyWallet || null,
    ownerWallet: params.walletAddress || null,
    useProxyWallet: !!params.proxyWallet,
    // Withdrawal always goes to owner wallet
    withdrawalDestination: params.walletAddress || null,
  };

  try {
    // Try with ZK columns (if migration has been run)
    const sql = `
      INSERT INTO hedges (
        order_id, portfolio_id, wallet_address, asset, market, side, 
        size, notional_value, leverage, entry_price, liquidation_price,
        stop_loss, take_profit, simulation_mode, reason, prediction_market, tx_hash,
        zk_proof_hash, wallet_binding_hash, owner_commitment, metadata,
        chain, chain_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *
    `;

    const result = await queryOne<Hedge>(sql, [
      params.orderId,
      params.portfolioId ?? null,  // Use ?? to preserve portfolioId=0 (community pool)
      params.walletAddress || null, // Always store OWNER wallet as wallet_address
      params.asset,
      params.market,
      params.side,
      params.size,
      params.notionalValue,
      params.leverage,
      params.entryPrice || null,
      params.liquidationPrice || null,
      params.stopLoss || null,
      params.takeProfit || null,
      params.simulationMode,
      params.reason || null,
      params.predictionMarket || null,
      params.txHash || null,
      params.zkProofHash || null,
      walletBindingHash,
      ownerCommitment,
      JSON.stringify(metadata),
      params.chain || 'cronos-testnet',
      params.chainId ?? null,
    ]);

    if (!result) {
      throw new Error('Failed to create hedge');
    }

    return result;
  } catch (error) {
    // Fallback without ZK columns (migration not yet run)
    logger.warn('ZK columns may not exist, falling back to simple insert:', error);
    const simpleSql = `
      INSERT INTO hedges (
        order_id, portfolio_id, wallet_address, asset, market, side, 
        size, notional_value, leverage, entry_price, liquidation_price,
        stop_loss, take_profit, simulation_mode, reason, prediction_market, tx_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `;

    const result = await queryOne<Hedge>(simpleSql, [
      params.orderId,
      params.portfolioId ?? null,  // Use ?? to preserve portfolioId=0 (community pool)
      params.walletAddress || null,
      params.asset,
      params.market,
      params.side,
      params.size,
      params.notionalValue,
      params.leverage,
      params.entryPrice || null,
      params.liquidationPrice || null,
      params.stopLoss || null,
      params.takeProfit || null,
      params.simulationMode,
      params.reason || null,
      params.predictionMarket || null,
      params.txHash || null,
    ]);

    if (!result) {
      throw new Error('Failed to create hedge');
    }

    return result;
  }
}

export async function getHedgeByOrderId(orderId: string): Promise<Hedge | null> {
  await ensureHedgesTable();
  const sql = 'SELECT * FROM hedges WHERE order_id = $1';
  return queryOne<Hedge>(sql, [orderId]);
}

// Alias for getHedgeByOrderId for consistency
export async function getHedgeById(hedgeId: string): Promise<Hedge | null> {
  return getHedgeByOrderId(hedgeId);
}

// Get hedge by database ID (integer)
export async function getHedgeByNumericId(id: number): Promise<Hedge | null> {
  const sql = 'SELECT * FROM hedges WHERE id = $1';
  return queryOne<Hedge>(sql, [id]);
}

export async function getHedgeByZkProofHash(proofHash: string): Promise<Hedge | null> {
  await ensureHedgesTable();
  // Check both zk_proof_hash and tx_hash (legacy column where proof was stored)
  const sql = 'SELECT * FROM hedges WHERE zk_proof_hash = $1 OR tx_hash = $1';
  return queryOne<Hedge>(sql, [proofHash]);
}

export async function getActiveHedges(portfolioId?: number, chain?: string): Promise<Hedge[]> {
  await ensureHedgesTable();
  if (portfolioId !== undefined && chain) {
    const sql = 'SELECT * FROM hedges WHERE portfolio_id = $1 AND status = $2 AND chain = $3 ORDER BY created_at DESC';
    return query<Hedge>(sql, [portfolioId, 'active', chain]);
  }
  if (portfolioId !== undefined) {
    const sql = 'SELECT * FROM hedges WHERE portfolio_id = $1 AND status = $2 ORDER BY created_at DESC';
    return query<Hedge>(sql, [portfolioId, 'active']);
  }
  
  const sql = 'SELECT * FROM hedges WHERE status = $1 ORDER BY created_at DESC';
  return query<Hedge>(sql, ['active']);
}

export async function getActiveHedgesByWallet(walletAddress: string): Promise<Hedge[]> {
  // Simple wallet address match - case insensitive
  const sql = `
    SELECT * FROM hedges 
    WHERE status = $1 
    AND LOWER(wallet_address) = LOWER($2)
    ORDER BY created_at DESC
  `;
  return query<Hedge>(sql, ['active', walletAddress]);
}

/**
 * Get hedges that the wallet can prove ownership of via ZK binding
 * This supports proxy wallets - the hedge may have a different wallet_address
 * but the owner can prove they control it via ZK proof
 */
export async function getActiveHedgesByZKOwnership(walletAddress: string): Promise<Hedge[]> {
  try {
    // Get all active hedges with wallet bindings
    const sql = `
      SELECT * FROM hedges 
      WHERE status = $1 
      AND wallet_binding_hash IS NOT NULL
      ORDER BY created_at DESC
    `;
    const allHedges = await query<Hedge>(sql, ['active']);
    
    // Filter to hedges this wallet can prove ownership of
    return allHedges.filter(hedge => {
      if (!hedge.wallet_binding_hash) return false;
      // Verify ZK ownership
      return verifyZKOwnership(walletAddress, hedge.order_id, hedge.wallet_binding_hash);
    });
  } catch (error) {
    // ZK columns may not exist yet
    logger.warn('ZK ownership query failed, columns may not exist:', error);
    return [];
  }
}

/**
 * Get hedges owned by wallet - checks both direct ownership AND ZK binding
 * This is the recommended method for fetching a user's hedges as it supports:
 * - Direct wallet address matching
 * - ZK proof-based ownership verification (for proxy wallets)
 */
export async function getOwnedHedges(walletAddress: string, activeOnly = true): Promise<Hedge[]> {
  const statusFilter = activeOnly ? "AND status = 'active'" : '';
  
  try {
    // First try with ZK binding support (if columns exist)
    const sql = `
      SELECT * FROM hedges 
      WHERE (
        LOWER(wallet_address) = LOWER($1)
        OR wallet_binding_hash IS NOT NULL
      )
      ${statusFilter}
      ORDER BY created_at DESC
    `;
    
    const hedges = await query<Hedge>(sql, [walletAddress]);
    
    // Filter: include if wallet matches OR if ZK binding proves ownership
    return hedges.filter(hedge => {
      // Direct wallet match
      if (hedge.wallet_address?.toLowerCase() === walletAddress.toLowerCase()) {
        return true;
      }
      // ZK binding match (for proxy wallets)
      if (hedge.wallet_binding_hash) {
        return verifyZKOwnership(walletAddress, hedge.order_id, hedge.wallet_binding_hash);
      }
      return false;
    });
  } catch (error) {
    // Fallback if ZK columns don't exist yet (migration not run)
    logger.warn('ZK columns may not exist, falling back to simple wallet query:', error);
    const simpleSql = `
      SELECT * FROM hedges 
      WHERE LOWER(wallet_address) = LOWER($1)
      ${statusFilter}
      ORDER BY created_at DESC
    `;
    return query<Hedge>(simpleSql, [walletAddress]);
  }
}

export async function getAllHedgesByWallet(walletAddress: string, limit = 50): Promise<Hedge[]> {
  const sql = 'SELECT * FROM hedges WHERE LOWER(wallet_address) = LOWER($1) ORDER BY created_at DESC LIMIT $2';
  return query<Hedge>(sql, [walletAddress, limit]);
}

export async function getAllHedges(portfolioId?: number, limit = 50): Promise<Hedge[]> {
  if (portfolioId !== undefined) {
    const sql = 'SELECT * FROM hedges WHERE portfolio_id = $1 ORDER BY created_at DESC LIMIT $2';
    return query<Hedge>(sql, [portfolioId, limit]);
  }
  
  const sql = 'SELECT * FROM hedges ORDER BY created_at DESC LIMIT $1';
  return query<Hedge>(sql, [limit]);
}

export async function updateHedgePnL(orderId: string, currentPnl: number): Promise<void> {
  const sql = 'UPDATE hedges SET current_pnl = $1, updated_at = CURRENT_TIMESTAMP WHERE order_id = $2';
  await query(sql, [currentPnl, orderId]);
}

export async function updateHedgeStatus(
  hedgeIdOrOrderId: string,
  status: 'active' | 'closed' | 'liquidated' | 'cancelled'
): Promise<void> {
  // Atomic transition guard: only allow active → terminal. This prevents
  // races between the hedge-monitor and the cron stale-closer from each
  // overwriting the other's terminal status.
  //
  // 2026-07-15 fix: previously this path zeroed current_pnl and left
  // realized_pnl untouched, which meant reconciler-driven closes
  // (majority of closes) always had realized_pnl=0 in the DB. Now
  // derives PnL from entry_price + current_price + funding_paid when
  // going terminal. This unlocks the regret tracker + analytics.
  //
  // Formula:
  //   LONG:  size × (current_price - entry_price) - funding_paid
  //   SHORT: size × (entry_price - current_price) - funding_paid
  // If either price is null, keep realized_pnl as-is (best-effort).
  const sql = `
    UPDATE hedges
    SET status = $1::varchar,
        updated_at = CURRENT_TIMESTAMP,
        closed_at = CASE WHEN $1::varchar IN ('closed', 'liquidated', 'cancelled') THEN CURRENT_TIMESTAMP ELSE closed_at END,
        realized_pnl = CASE
          WHEN $1::varchar IN ('closed', 'liquidated', 'cancelled')
            AND COALESCE(realized_pnl, 0) = 0
            AND entry_price IS NOT NULL
            AND current_price IS NOT NULL
            AND size IS NOT NULL
          THEN (
            CASE WHEN UPPER(side) = 'LONG'
              THEN size * (current_price - entry_price)
              ELSE size * (entry_price - current_price)
            END
          ) - COALESCE(funding_paid, 0)
          ELSE realized_pnl
        END,
        current_pnl = CASE
          WHEN $1::varchar IN ('closed', 'liquidated', 'cancelled')
            AND COALESCE(realized_pnl, 0) = 0
            AND entry_price IS NOT NULL
            AND current_price IS NOT NULL
            AND size IS NOT NULL
          THEN (
            CASE WHEN UPPER(side) = 'LONG'
              THEN size * (current_price - entry_price)
              ELSE size * (entry_price - current_price)
            END
          ) - COALESCE(funding_paid, 0)
          WHEN $1::varchar IN ('closed', 'liquidated', 'cancelled')
          THEN 0
          ELSE current_pnl
        END
    WHERE (order_id = $2 OR hedge_id_onchain = $2)
      AND (
        $1::varchar = 'active'
        OR status = 'active'
      )
    RETURNING order_id, realized_pnl
  `;
  const rows = await query<{ order_id: string; realized_pnl: string | number | null }>(
    sql,
    [status, hedgeIdOrOrderId],
  );
  // Treasury credit — only when transitioning to a terminal status with
  // measurable PnL. Idempotent per order_id; non-fatal.
  if (
    rows.length > 0 &&
    (status === 'closed' || status === 'liquidated')
  ) {
    const pnl = Number(rows[0].realized_pnl ?? 0);
    if (Math.abs(pnl) > 0.01) {
      try {
        const { recordPnlCredit } = await import('@/lib/db/treasury');
        await recordPnlCredit(rows[0].order_id, pnl, `updateHedgeStatus ${status}`);
      } catch (err) {
        logger.warn('[Hedges] treasury credit failed after status transition', {
          orderId: rows[0].order_id,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  }
}

export async function closeHedge(
  orderId: string,
  realizedPnl: number,
  status: 'closed' | 'liquidated' = 'closed'
): Promise<void> {
  // Mirror realized_pnl into current_pnl so closed-hedge analytics that sum
  // current_pnl don't carry over stale price-watch snapshots.
  const sql = `
    UPDATE hedges
    SET status = $1, realized_pnl = $2, current_pnl = $2, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE order_id = $3
  `;
  await query(sql, [status, realizedPnl, orderId]);

  // Treasury credit — idempotent per orderId. Fire-and-forget: a treasury
  // outage never blocks the hedge state transition.
  if (Math.abs(realizedPnl) > 0.01) {
    try {
      const { recordPnlCredit } = await import('@/lib/db/treasury');
      await recordPnlCredit(orderId, realizedPnl, `closeHedge ${status}`);
    } catch (err) {
      logger.warn('[Hedges] treasury credit failed after close', {
        orderId,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}

/**
 * Persist funding paid (or earned, if negative) on an existing hedge.
 * Called when a perp position accrues funding between cron cycles.
 */
export async function updateHedgeFundingPaid(
  orderId: string,
  fundingPaidUsd: number
): Promise<void> {
  const sql = `
    UPDATE hedges
    SET funding_paid = COALESCE(funding_paid, 0) + $1, updated_at = CURRENT_TIMESTAMP
    WHERE order_id = $2 OR hedge_id_onchain = $2
  `;
  await query(sql, [fundingPaidUsd, orderId]);
}

/**
 * Mark a perp position closed using the order ID returned by the close call.
 * Looks up the original hedge by symbol+side and writes realized PnL + fees.
 * This is the canonical path for Bluefin perp closes initiated by the cron.
 */
export async function closePerpHedgeBySymbolSide(args: {
  symbol: string;            // e.g. "BTC-PERP"
  side: 'LONG' | 'SHORT';    // direction of the ORIGINAL position being closed
  realizedPnl: number;       // USD, can be negative
  feesPaid?: number;         // USD
  closeOrderId?: string;     // Bluefin order hash for the close
  closeTxDigest?: string;
}): Promise<{ updated: number }> {
  const sql = `
    UPDATE hedges SET
      status = 'closed',
      realized_pnl = COALESCE(realized_pnl, 0) + $3,
      current_pnl  = COALESCE(realized_pnl, 0) + $3,
      funding_paid = COALESCE(funding_paid, 0) + COALESCE($4, 0),
      closed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP,
      tx_hash = COALESCE($6, tx_hash),
      reason = COALESCE(reason, '') || ' | closed via ' || COALESCE($5, 'cron')
    WHERE id = (
      SELECT id FROM hedges
      WHERE market = $1 AND side = $2 AND status = 'active' AND simulation_mode = false
      ORDER BY created_at DESC
      LIMIT 1
    )
    RETURNING id, order_id
  `;
  try {
    const rows = await query<{ id: number; order_id: string }>(sql, [
      args.symbol,
      args.side,
      args.realizedPnl,
      args.feesPaid ?? null,
      args.closeOrderId ?? null,
      args.closeTxDigest ?? null,
    ]);
    // Treasury credit — idempotent per order_id, non-fatal.
    if (rows.length > 0 && Math.abs(args.realizedPnl) > 0.01) {
      try {
        const { recordPnlCredit } = await import('@/lib/db/treasury');
        await recordPnlCredit(rows[0].order_id, args.realizedPnl, `closePerpHedgeBySymbolSide ${args.symbol}/${args.side}`);
      } catch (err) {
        logger.warn('[Hedges] treasury credit failed after perp close', {
          orderId: rows[0].order_id,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    return { updated: rows.length };
  } catch (err) {
    logger.warn('[DB] closePerpHedgeBySymbolSide failed', { error: err instanceof Error ? err.message : err });
    return { updated: 0 };
  }
}

/**
 * Sum of realized_pnl for hedges closed since a given epoch-ms.
 * Used by the daily-loss circuit breaker.
 *
 * Returns: { realized: number, fundingPaid: number, count: number }
 *   realized:    sum of realized_pnl (can be negative)
 *   fundingPaid: sum of funding_paid (always positive — cost)
 *   netPnl:      realized - fundingPaid
 */
export async function getRealizedPnlSince(sinceMs: number): Promise<{
  realized: number;
  fundingPaid: number;
  netPnl: number;
  count: number;
}> {
  await ensureHedgesTable();
  try {
    const sinceIso = new Date(sinceMs).toISOString();
    const row = await queryOne<{
      realized: string | null;
      funding: string | null;
      cnt: string | null;
    }>(
      `SELECT
         COALESCE(SUM(realized_pnl), 0)::TEXT AS realized,
         COALESCE(SUM(funding_paid), 0)::TEXT AS funding,
         COUNT(*)::TEXT AS cnt
       FROM hedges
       WHERE simulation_mode = false
         AND status = 'closed'
         AND closed_at >= $1`,
      [sinceIso],
    );
    const realized = Number(row?.realized ?? 0);
    const fundingPaid = Number(row?.funding ?? 0);
    return {
      realized,
      fundingPaid,
      netPnl: realized - fundingPaid,
      count: Number(row?.cnt ?? 0),
    };
  } catch (err) {
    logger.warn('[DB] getRealizedPnlSince failed', { error: err instanceof Error ? err.message : err });
    return { realized: 0, fundingPaid: 0, netPnl: 0, count: 0 };
  }
}

/**
 * Active non-simulation hedges older than maxAgeMs.
 * Used by the position-age timeout to force-close stale perps that would otherwise
 * keep paying funding indefinitely.
 */
export async function getStaleActiveHedges(maxAgeMs: number): Promise<Array<{
  orderId: string;
  market: string;
  side: 'LONG' | 'SHORT';
  asset: string;
  ageMs: number;
  createdAt: string;
}>> {
  await ensureHedgesTable();
  try {
    const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = await query<{
      order_id: string;
      market: string;
      side: 'LONG' | 'SHORT';
      asset: string;
      created_at: string;
    }>(
      `SELECT order_id, market, side, asset, created_at
       FROM hedges
       WHERE simulation_mode = false
         AND status = 'active'
         AND created_at < $1
       ORDER BY created_at ASC
       LIMIT 32`,
      [cutoffIso],
    );
    const now = Date.now();
    return rows.map(r => ({
      orderId: r.order_id,
      market: r.market,
      side: r.side,
      asset: r.asset,
      ageMs: now - new Date(r.created_at).getTime(),
      createdAt: r.created_at,
    }));
  } catch (err) {
    logger.warn('[DB] getStaleActiveHedges failed', { error: err instanceof Error ? err.message : err });
    return [];
  }
}

export async function getHedgeStats() {
  const sql = `
    SELECT 
      COUNT(*) as total_hedges,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active_hedges,
      SUM(CASE WHEN status = 'active' THEN notional_value ELSE 0 END) as total_active_notional,
      SUM(current_pnl) as total_current_pnl,
      SUM(realized_pnl) as total_realized_pnl,
      COUNT(CASE WHEN simulation_mode = true THEN 1 END) as simulated_hedges,
      COUNT(CASE WHEN simulation_mode = false THEN 1 END) as real_hedges,
      COUNT(CASE WHEN zk_proof_hash IS NOT NULL AND zk_proof_hash != '' THEN 1 END) as total_with_zk_proof
    FROM hedges
  `;
  
  return queryOne(sql);
}

/**
 * Delete all active simulation hedges
 * Used to clear old test data
 */
export async function clearSimulationHedges(): Promise<number> {
  const sql = `
    DELETE FROM hedges 
    WHERE simulation_mode = true AND status = 'active'
    RETURNING order_id
  `;
  const result = await query(sql);
  return result.length;
}

/**
 * Delete all hedges (use with caution)
 */
export async function clearAllHedges(): Promise<number> {
  const sql = 'DELETE FROM hedges RETURNING order_id';
  const result = await query(sql);
  return result.length;
}

/**
 * Get active on-chain hedge count directly from DB.
 * Eliminates the need to call getUserHedges() + hedges() on-chain just for a count.
 */
export async function getActiveOnChainHedgeCount(): Promise<number> {
  try {
    const sql = "SELECT COUNT(*) as count FROM hedges WHERE on_chain = true AND status = 'active'";
    const row = await queryOne<{ count: string }>(sql);
    return parseInt(row?.count || '0', 10);
  } catch {
    return 0;
  }
}

/**
 * Get ALL on-chain hedges from DB with full details.
 * This replaces the expensive multi-RPC-call flow in the onchain route.
 */
export async function getAllOnChainHedges(activeOnly = false): Promise<Hedge[]> {
  try {
    const statusFilter = activeOnly ? "AND status = 'active'" : '';
    const sql = `SELECT * FROM hedges WHERE on_chain = true ${statusFilter} ORDER BY created_at DESC`;
    return await query<Hedge>(sql);
  } catch {
    return [];
  }
}

/**
 * Update hedge with live price data and computed PnL.
 * Called during background sync to keep DB fresh.
 */
export async function updateHedgePrice(hedgeIdOnchain: string, currentPrice: number, source: string): Promise<void> {
  try {
    await query(`
      UPDATE hedges SET
        current_price = $1,
        price_source = $2,
        price_updated_at = NOW(),
        updated_at = NOW()
      WHERE hedge_id_onchain = $3 OR order_id = $3
    `, [currentPrice, source, hedgeIdOnchain]);
  } catch (err) {
    logger.warn('updateHedgePrice failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Fix missing entry_price for a hedge by setting it to current market price.
 * Used for hedges that were created without proper entry price tracking.
 * Entry price is adjusted slightly (±0.5%) based on side to simulate realistic entry.
 */
export async function fixHedgeEntryPrice(
  hedgeId: number, 
  currentPrice: number, 
  side: 'LONG' | 'SHORT'
): Promise<void> {
  // For LONG: entered slightly higher than current (small loss if closing now)
  // For SHORT: entered slightly lower than current (small loss if closing now)
  const entryOffset = side === 'LONG' ? 1.005 : 0.995;
  const fixedEntryPrice = currentPrice * entryOffset;
  
  try {
    await query(`
      UPDATE hedges SET
        entry_price = $1,
        current_price = $2,
        price_updated_at = NOW(),
        updated_at = NOW()
      WHERE id = $3 AND entry_price IS NULL
    `, [fixedEntryPrice, currentPrice, hedgeId]);
    logger.info(`[DB] Fixed entry_price for hedge ${hedgeId}: $${fixedEntryPrice.toFixed(4)}`);
  } catch (err) {
    logger.warn('fixHedgeEntryPrice failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Batch-update prices for multiple hedges (by asset symbol).
 * More efficient than updating one-by-one.
 */
export async function batchUpdateHedgePrices(priceMap: Record<string, { price: number; source: string }>): Promise<void> {
  try {
    for (const [asset, { price, source }] of Object.entries(priceMap)) {
      await query(`
        UPDATE hedges SET
          current_price = $1,
          price_source = $2,
          price_updated_at = NOW(),
          updated_at = NOW()
        WHERE UPPER(asset) = UPPER($3) AND on_chain = true AND status = 'active'
      `, [price, source, asset]);
    }
  } catch (err) {
    logger.warn('batchUpdateHedgePrices failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Mark a hedge as closed in DB (called after on-chain close).
 */
export async function closeOnChainHedge(hedgeIdOnchain: string, realizedPnl: number, closeTxHash?: string): Promise<void> {
  try {
    const rows = await query<{ order_id: string }>(`
      UPDATE hedges SET
        status = 'closed',
        realized_pnl = $1,
        current_pnl  = $1,
        closed_at = NOW(),
        updated_at = NOW(),
        tx_hash = COALESCE($2, tx_hash)
      WHERE hedge_id_onchain = $3 OR order_id = $3
      RETURNING order_id
    `, [realizedPnl, closeTxHash || null, hedgeIdOnchain]);
    // Treasury credit — idempotent, non-fatal.
    if (rows.length > 0 && Math.abs(realizedPnl) > 0.01) {
      try {
        const { recordPnlCredit } = await import('@/lib/db/treasury');
        await recordPnlCredit(rows[0].order_id, realizedPnl, 'closeOnChainHedge');
      } catch (err) {
        logger.warn('[Hedges] treasury credit failed after on-chain close', {
          orderId: rows[0].order_id,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  } catch (err) {
    logger.warn('closeOnChainHedge failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Get on-chain hedge protocol stats directly from DB.
 * Replaces contract.getProtocolStats() RPC call.
 */
export async function getOnChainProtocolStats() {
  try {
    const sql = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') AS active_count,
        COUNT(*) FILTER (WHERE status IN ('closed', 'liquidated')) AS closed_count,
        COUNT(*) AS total_count,
        COALESCE(SUM(size) FILTER (WHERE status = 'active'), 0) AS collateral_locked,
        COALESCE(SUM(realized_pnl), 0) AS total_pnl,
        0 AS fees_collected
      FROM hedges
      WHERE on_chain = true
    `;
    return await queryOne<{
      active_count: string;
      closed_count: string;
      total_count: string;
      collateral_locked: string;
      total_pnl: string;
      fees_collected: string;
    }>(sql);
  } catch {
    return null;
  }
}

/**
 * Atomically acquire a short-lived decision lock so we never open the same
 * (asset, riskBucket) hedge twice within `ttlSeconds`. Backed by Postgres so
 * Vercel cold starts cannot reset the dedup window.
 *
 * Returns true if the caller acquired the lock, false if already held.
 */
let decisionLocksReady = false;
async function ensureDecisionLockTable(): Promise<void> {
  if (decisionLocksReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS hedge_decision_locks (
        decision_token VARCHAR(128) PRIMARY KEY,
        acquired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_decision_locks_expires ON hedge_decision_locks(expires_at)`);
    decisionLocksReady = true;
  } catch (err) {
    logger.warn('[DB] ensureDecisionLockTable failed', { error: err instanceof Error ? err.message : err });
    decisionLocksReady = true; // do not retry on every call
  }
}

export async function tryAcquireHedgeDecisionLock(
  decisionToken: string,
  ttlSeconds: number,
): Promise<boolean> {
  await ensureDecisionLockTable();
  try {
    // Sweep expired rows so the table never grows unbounded.
    await query(`DELETE FROM hedge_decision_locks WHERE expires_at < CURRENT_TIMESTAMP`);
    const sql = `
      INSERT INTO hedge_decision_locks (decision_token, expires_at)
      VALUES ($1, CURRENT_TIMESTAMP + ($2 || ' seconds')::interval)
      ON CONFLICT (decision_token) DO NOTHING
      RETURNING decision_token
    `;
    const rows = await query<{ decision_token: string }>(sql, [decisionToken, String(ttlSeconds)]);
    return rows.length === 1;
  } catch (err) {
    logger.warn('[DB] tryAcquireHedgeDecisionLock failed', { error: err instanceof Error ? err.message : err });
    // On DB failure, fail-closed (do not open the hedge) so we never duplicate.
    return false;
  }
}

export async function releaseHedgeDecisionLock(decisionToken: string): Promise<void> {
  try {
    await query(`DELETE FROM hedge_decision_locks WHERE decision_token = $1`, [decisionToken]);
  } catch {
    // best-effort; lock will expire on its own
  }
}
