/**
 * On-Chain Hedge Ownership Registry
 * 
 * Maps commitmentHash (used as hedgeId in the gasless flow) → user walletAddress.
 * Now backed by Neon PostgreSQL instead of filesystem for serverless compatibility.
 * 
 * Security model:
 *  - On OPEN: walletAddress is recorded against the hedgeId
 *  - On CLOSE: user must present an EIP-712 signature from that same wallet
 *  - The relayer never reveals user wallets on-chain, but the API can verify ownership off-chain
 */

import { query, queryOne } from './db/postgres';
import { logger } from '@/lib/utils/logger';

export interface HedgeOwnershipEntry {
  walletAddress: string;
  pairIndex: number;
  asset: string;
  side: string;
  collateral: number;
  leverage: number;
  openedAt: string;  // ISO timestamp
  txHash: string;
  onChainHedgeId?: string; // bytes32 from HedgeExecutor events, if available
  commitmentHash?: string; // The commitment used for ZK binding
}

/**
 * Register hedge ownership when a gasless hedge is opened.
 * Called by the open-onchain-gasless route after successful tx.
 * 
 * Now stores in Neon DB instead of filesystem.
 */
export async function registerHedgeOwnership(
  commitmentHash: string,
  entry: HedgeOwnershipEntry
): Promise<void> {
  try {
    // Try to update existing hedge first, then insert if not found
    const result = await query<{ id: number }>(
      `UPDATE hedges 
       SET wallet_address = $1, 
           tx_hash = $2,
           hedge_id_onchain = $3,
           updated_at = NOW()
       WHERE commitment_hash = $4
       RETURNING id`,
      [entry.walletAddress, entry.txHash, entry.onChainHedgeId, commitmentHash.toLowerCase()]
    );

    if (result.length === 0) {
      // Insert new ownership record into hedge_ownership table
      await query(
        `INSERT INTO hedge_ownership (commitment_hash, wallet_address, pair_index, asset, side, collateral, leverage, opened_at, tx_hash, on_chain_hedge_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (commitment_hash) DO UPDATE SET
           wallet_address = EXCLUDED.wallet_address,
           tx_hash = EXCLUDED.tx_hash,
           on_chain_hedge_id = EXCLUDED.on_chain_hedge_id,
           updated_at = NOW()`,
        [
          commitmentHash.toLowerCase(),
          entry.walletAddress,
          entry.pairIndex,
          entry.asset,
          entry.side,
          entry.collateral,
          entry.leverage,
          entry.openedAt,
          entry.txHash,
          entry.onChainHedgeId
        ]
      );
    }
    logger.debug(`🔑 Registered hedge ownership: ${commitmentHash.slice(0, 18)}... → ${entry.walletAddress}`);
  } catch (error) {
    logger.error('Failed to register hedge ownership:', error);
    // Don't throw - ownership registration is non-critical
  }
}

/**
 * Look up the wallet that owns a hedge.
 * Accepts either commitmentHash or hedge_id_onchain (both are valid lookup keys).
 * Returns null if the hedge isn't in the registry.
 * 
 * IMPORTANT: Check hedge_ownership table FIRST (has correct owner for gasless hedges),
 * then fall back to hedges table (which may have relayer address for gasless hedges).
 */
export async function getHedgeOwner(hedgeIdOrCommitment: string): Promise<HedgeOwnershipEntry | null> {
  try {
    const lookupValue = hedgeIdOrCommitment.toLowerCase();

    // FIRST check dedicated hedge_ownership table (has correct owner for gasless hedges)
    const ownership = await queryOne<{
      wallet_address: string;
      pair_index: number;
      asset: string;
      side: string;
      collateral: number;
      leverage: number;
      opened_at: string;
      tx_hash: string;
      on_chain_hedge_id: string;
      commitment_hash: string;
    }>(
      `SELECT wallet_address, pair_index, asset, side, collateral, leverage, opened_at, tx_hash, on_chain_hedge_id, commitment_hash
       FROM hedge_ownership 
       WHERE commitment_hash = $1 OR on_chain_hedge_id = $1`,
      [lookupValue]
    );

    if (ownership) {
      return {
        walletAddress: ownership.wallet_address,
        pairIndex: ownership.pair_index,
        asset: ownership.asset,
        side: ownership.side,
        collateral: ownership.collateral,
        leverage: ownership.leverage,
        openedAt: ownership.opened_at,
        txHash: ownership.tx_hash || '',
        onChainHedgeId: ownership.on_chain_hedge_id || undefined,
        commitmentHash: ownership.commitment_hash || undefined
      };
    }

    // Fall back to hedges table (for legacy non-gasless hedges)
    const hedge = await queryOne<{
      wallet_address: string;
      asset: string;
      side: string;
      size: number;
      leverage: number;
      created_at: Date;
      tx_hash: string;
      hedge_id_onchain: string;
      commitment_hash: string;
    }>(
      `SELECT wallet_address, asset, side, size, leverage, created_at, tx_hash, hedge_id_onchain, commitment_hash
       FROM hedges 
       WHERE commitment_hash = $1 OR hedge_id_onchain = $1`,
      [lookupValue]
    );

    if (hedge && hedge.wallet_address) {
      return {
        walletAddress: hedge.wallet_address,
        pairIndex: 0, // Could derive from asset
        asset: hedge.asset,
        side: hedge.side,
        collateral: hedge.size,
        leverage: hedge.leverage,
        openedAt: hedge.created_at.toISOString(),
        txHash: hedge.tx_hash || '',
        onChainHedgeId: hedge.hedge_id_onchain || undefined,
        commitmentHash: hedge.commitment_hash || undefined
      };
    }

    return null;
  } catch (error) {
    logger.error('Failed to get hedge owner:', error);
    return null;
  }
}

/**
 * Remove a hedge from the registry (called after successful close).
 * Accepts either commitmentHash or hedge_id_onchain as the lookup key.
 */
export async function removeHedgeOwnership(hedgeIdOrCommitment: string): Promise<void> {
  try {
    const lookupValue = hedgeIdOrCommitment.toLowerCase();
    await query(
      `DELETE FROM hedge_ownership WHERE commitment_hash = $1 OR on_chain_hedge_id = $1`,
      [lookupValue]
    );
  } catch (error) {
    logger.error('Failed to remove hedge ownership:', error);
  }
}

/**
 * Get all hedges owned by a wallet address.
 */
export async function getHedgesByWallet(walletAddress: string): Promise<Record<string, HedgeOwnershipEntry>> {
  const result: Record<string, HedgeOwnershipEntry> = {};
  
  try {
    // Get from hedges table
    const hedges = await query<{
      commitment_hash: string;
      wallet_address: string;
      asset: string;
      side: string;
      size: number;
      leverage: number;
      created_at: Date;
      tx_hash: string;
      hedge_id_onchain: string;
    }>(
      `SELECT commitment_hash, wallet_address, asset, side, size, leverage, created_at, tx_hash, hedge_id_onchain
       FROM hedges 
       WHERE LOWER(wallet_address) = LOWER($1) AND commitment_hash IS NOT NULL`,
      [walletAddress]
    );

    for (const h of hedges) {
      if (h.commitment_hash) {
        result[h.commitment_hash] = {
          walletAddress: h.wallet_address,
          pairIndex: 0,
          asset: h.asset,
          side: h.side,
          collateral: h.size,
          leverage: h.leverage,
          openedAt: h.created_at.toISOString(),
          txHash: h.tx_hash || '',
          onChainHedgeId: h.hedge_id_onchain || undefined
        };
      }
    }

    // Also get from hedge_ownership table
    const ownership = await query<{
      commitment_hash: string;
      wallet_address: string;
      pair_index: number;
      asset: string;
      side: string;
      collateral: number;
      leverage: number;
      opened_at: string;
      tx_hash: string;
      on_chain_hedge_id: string;
    }>(
      `SELECT commitment_hash, wallet_address, pair_index, asset, side, collateral, leverage, opened_at, tx_hash, on_chain_hedge_id
       FROM hedge_ownership 
       WHERE LOWER(wallet_address) = LOWER($1)`,
      [walletAddress]
    );

    for (const o of ownership) {
      if (!result[o.commitment_hash]) {
        result[o.commitment_hash] = {
          walletAddress: o.wallet_address,
          pairIndex: o.pair_index,
          asset: o.asset,
          side: o.side,
          collateral: o.collateral,
          leverage: o.leverage,
          openedAt: o.opened_at,
          txHash: o.tx_hash || '',
          onChainHedgeId: o.on_chain_hedge_id || undefined
        };
      }
    }
  } catch (error) {
    logger.error('Failed to get hedges by wallet:', error);
  }

  return result;
}

/**
 * The EIP-712 domain and types used by both the API and the frontend.
 * Exported so the dashboard can construct the same typed data for signing.
 */
export const CLOSE_HEDGE_DOMAIN = {
  name: 'ZKward',
  version: '1',
  chainId: 338, // Cronos testnet
  verifyingContract: '0x090b6221137690EbB37667E4644287487CE462B9' as `0x${string}`,
};

export const CLOSE_HEDGE_TYPES = {
  CloseHedge: [
    { name: 'hedgeId', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
};
