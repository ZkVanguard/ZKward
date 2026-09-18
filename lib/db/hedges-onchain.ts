/**
 * On-chain hedge DB functions — anything scoped to rows where
 * `hedge_id_onchain` is set. Extracted from lib/db/hedges.ts so the
 * perp-side queries + shared schema aren't crowded by the on-chain
 * (Sui + Cronos) surface area.
 *
 * Callers keep importing from '@/lib/db/hedges' (re-exports these).
 * No import-site churn.
 */
import { query, queryOne } from './postgres';
import { logger } from '@/lib/utils/logger';
import { ensureHedgesTable, type Hedge } from './hedges-schema';
import { HEDGES_REAL_ONLY_SQL } from './hedges-scope';

export interface OnChainHedgeParams {
  hedgeIdOnchain: string;       // bytes32 from HedgeExecutor
  txHash: string;               // Transaction hash
  trader: string;               // On-chain trader address
  asset: string;
  side: 'LONG' | 'SHORT';
  collateral: number;
  leverage: number;
  entryPrice?: number;
  chain?: string;
  chainId?: number;
  contractAddress?: string;
  commitmentHash?: string;
  nullifier?: string;
  proxyWallet?: string;
  blockNumber?: number;
  explorerLink?: string;
  walletAddress?: string;       // Real owner wallet (for ZK-private hedges)
  portfolioId?: number;         // Portfolio ID (-1 = community pool, 0+ = user portfolios)
  metadata?: Record<string, unknown>;
}

/**
 * Upsert an on-chain hedge into the DB.
 * Called at creation time (from open-onchain-gasless route) so the tx hash
 * is immediately available — no event log scanning needed.
 */
export async function upsertOnChainHedge(params: OnChainHedgeParams): Promise<Hedge | null> {
  try {
    const orderId = params.hedgeIdOnchain;
    const chainId = params.chainId || parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || '338', 10);
    const explorerBase = chainId === 25 ? 'https://explorer.cronos.org' : 'https://explorer.cronos.org/testnet';
    const explorerLink = params.explorerLink || `${explorerBase}/tx/${params.txHash}`;

    const sql = `
      INSERT INTO hedges (
        order_id, portfolio_id, wallet_address, asset, market, side,
        size, notional_value, leverage, entry_price,
        simulation_mode, tx_hash, on_chain, chain, chain_id,
        contract_address, hedge_id_onchain, commitment_hash,
        nullifier, proxy_wallet, block_number, explorer_link,
        metadata, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        false, $11, true, $12, $13,
        $14, $15, $16,
        $17, $18, $19, $20,
        $21, 'active'
      )
      ON CONFLICT (order_id) DO UPDATE SET
        portfolio_id = COALESCE(EXCLUDED.portfolio_id, hedges.portfolio_id),
        asset = CASE WHEN EXCLUDED.asset IS NOT NULL AND EXCLUDED.asset != '' THEN EXCLUDED.asset ELSE hedges.asset END,
        market = CASE WHEN EXCLUDED.market IS NOT NULL AND EXCLUDED.market != '' THEN EXCLUDED.market ELSE hedges.market END,
        side = EXCLUDED.side,
        size = CASE WHEN EXCLUDED.size > 0 THEN EXCLUDED.size ELSE hedges.size END,
        notional_value = CASE WHEN EXCLUDED.notional_value > 0 THEN EXCLUDED.notional_value ELSE hedges.notional_value END,
        leverage = CASE WHEN EXCLUDED.leverage > 0 THEN EXCLUDED.leverage ELSE hedges.leverage END,
        entry_price = COALESCE(EXCLUDED.entry_price, hedges.entry_price),
        tx_hash = COALESCE(EXCLUDED.tx_hash, hedges.tx_hash),
        block_number = COALESCE(EXCLUDED.block_number, hedges.block_number),
        explorer_link = COALESCE(EXCLUDED.explorer_link, hedges.explorer_link),
        commitment_hash = COALESCE(EXCLUDED.commitment_hash, hedges.commitment_hash),
        nullifier = COALESCE(EXCLUDED.nullifier, hedges.nullifier),
        proxy_wallet = COALESCE(EXCLUDED.proxy_wallet, hedges.proxy_wallet),
        on_chain = true,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;

    return await queryOne<Hedge>(sql, [
      orderId,
      params.portfolioId ?? null,
      params.walletAddress || params.trader,
      params.asset,
      `${params.asset}/USD`,
      params.side,
      params.collateral,
      params.collateral * params.leverage,
      params.leverage,
      params.entryPrice || null,
      params.txHash,
      params.chain || 'cronos-testnet',
      params.chainId || 338,
      params.contractAddress || process.env.NEXT_PUBLIC_HEDGE_EXECUTOR_ADDRESS || '',
      params.hedgeIdOnchain,
      params.commitmentHash || null,
      params.nullifier || null,
      params.proxyWallet || null,
      params.blockNumber || null,
      explorerLink,
      JSON.stringify(params.metadata || {}),
    ]);
  } catch (error) {
    logger.warn('upsertOnChainHedge failed (migration may not be run yet):', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Resync a hedge's key fields from actual on-chain data.
 * Fixes stale DB entries that were stored with incorrect values.
 * Only updates fields that have valid new values (never overwrites with 0/null).
 */
export async function resyncOnChainHedge(hedgeIdOnchain: string, data: {
  asset: string;
  side: 'LONG' | 'SHORT';
  collateral: number;
  leverage: number;
  entryPrice: number;
  status?: string;
  commitmentHash?: string;
  nullifier?: string;
}): Promise<void> {
  try {
    const notional = data.collateral * data.leverage;
    const sql = `
      UPDATE hedges SET
        asset = COALESCE(NULLIF($1, ''), asset),
        side = COALESCE(NULLIF($2, ''), side),
        size = CASE WHEN $3 > 0 THEN $3 ELSE size END,
        notional_value = CASE WHEN $4 > 0 THEN $4 ELSE notional_value END,
        leverage = CASE WHEN $5 > 0 THEN $5 ELSE leverage END,
        entry_price = CASE WHEN $6 > 0 THEN $6 ELSE entry_price END,
        status = COALESCE(NULLIF($7, ''), status),
        commitment_hash = COALESCE($8, commitment_hash),
        nullifier = COALESCE($9, nullifier),
        updated_at = NOW()
      WHERE hedge_id_onchain = $10 OR order_id = $10
    `;
    await query(sql, [
      data.asset,
      data.side,
      data.collateral,
      notional,
      data.leverage,
      data.entryPrice,
      data.status || null,
      data.commitmentHash || null,
      data.nullifier || null,
      hedgeIdOnchain,
    ]);
  } catch (err) {
    logger.warn('resyncOnChainHedge failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Get an on-chain hedge by its bytes32 hedgeId.
 * Returns instantly from DB instead of scanning event logs.
 */
export async function getOnChainHedgeByHedgeId(hedgeIdOnchain: string): Promise<Hedge | null> {
  try {
    const sql = 'SELECT * FROM hedges WHERE hedge_id_onchain = $1 OR order_id = $1';
    return await queryOne<Hedge>(sql, [hedgeIdOnchain]);
  } catch {
    return null;
  }
}

/**
 * Batch-fetch tx hashes for multiple on-chain hedgeIds from DB.
 * Returns a map of hedgeId → txHash. Much faster than event log scanning.
 */
export async function getTxHashesFromDb(hedgeIds: string[]): Promise<Record<string, string>> {
  if (hedgeIds.length === 0) return {};

  try {
    const sql = `
      SELECT hedge_id_onchain, tx_hash
      FROM hedges
      WHERE hedge_id_onchain = ANY($1)
        AND tx_hash IS NOT NULL
    `;
    const rows = await query<{ hedge_id_onchain: string; tx_hash: string }>(sql, [hedgeIds]);

    const map: Record<string, string> = {};
    for (const row of rows) {
      if (row.hedge_id_onchain && row.tx_hash) {
        map[row.hedge_id_onchain] = row.tx_hash;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Bulk-save tx hashes discovered from event log scanning.
 * Called as a background cache-fill for hedges not yet in DB.
 */
export async function cacheTxHashes(entries: Array<{ hedgeId: string; txHash: string; blockNumber?: number }>): Promise<void> {
  if (entries.length === 0) return;

  try {
    const chainId = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || '338', 10);
    const explorerBase = chainId === 25 ? 'https://explorer.cronos.org' : 'https://explorer.cronos.org/testnet';

    for (const { hedgeId, txHash, blockNumber } of entries) {
      const explorerLink = `${explorerBase}/tx/${txHash}`;
      await query(`
        INSERT INTO hedges (order_id, hedge_id_onchain, tx_hash, block_number, explorer_link, on_chain, simulation_mode, asset, market, side, size, notional_value, leverage, status)
        VALUES ($1, $2, $3, $4, $5, true, false, 'UNKNOWN', 'UNKNOWN', 'LONG', 0, 0, 1, 'active')
        ON CONFLICT (order_id) DO UPDATE SET
          tx_hash = COALESCE(EXCLUDED.tx_hash, hedges.tx_hash),
          block_number = COALESCE(EXCLUDED.block_number, hedges.block_number),
          explorer_link = COALESCE(EXCLUDED.explorer_link, hedges.explorer_link),
          hedge_id_onchain = COALESCE(EXCLUDED.hedge_id_onchain, hedges.hedge_id_onchain),
          on_chain = true,
          updated_at = CURRENT_TIMESTAMP
      `, [hedgeId, hedgeId, txHash, blockNumber || null, explorerLink]);
    }
  } catch (error) {
    logger.warn('cacheTxHashes failed:', error instanceof Error ? error.message : error);
  }
}

// ─── Three-Layer Sync Helpers (DB ↔ On-Chain Move ↔ Bluefin Perp) ───────────
// These keep the DB authoritative when the cron settles or closes positions
// across the on-chain Move pool and the Bluefin perp exchange.

/**
 * Look up a hedge by its on-chain Sui hedge_id (hex without 0x prefix).
 * Returns null if no DB row exists for that on-chain id.
 */
export async function getHedgeByOnchainId(hedgeIdOnchain: string): Promise<Hedge | null> {
  await ensureHedgesTable();
  // Accept with-or-without 0x prefix; column stores either form
  const candidates = hedgeIdOnchain.startsWith('0x')
    ? [hedgeIdOnchain, hedgeIdOnchain.slice(2)]
    : [hedgeIdOnchain, '0x' + hedgeIdOnchain];
  const sql = `SELECT * FROM hedges WHERE hedge_id_onchain = ANY($1::varchar[]) LIMIT 1`;
  return queryOne<Hedge>(sql, [candidates]);
}

/**
 * Atomically mark a hedge closed by its on-chain Sui hedge_id.
 * Only transitions rows where status='active' to prevent races with the
 * stale-perp closer or the hedge-monitor cron.
 *
 * Returns the number of rows updated (0 if none matched, 1 on success).
 */
export async function closeHedgeByOnchainId(args: {
  hedgeIdOnchain: string;
  realizedPnl: number;
  status?: 'closed' | 'liquidated';
  closeTxDigest?: string;
}): Promise<{ updated: number }> {
  await ensureHedgesTable();
  const candidates = args.hedgeIdOnchain.startsWith('0x')
    ? [args.hedgeIdOnchain, args.hedgeIdOnchain.slice(2)]
    : [args.hedgeIdOnchain, '0x' + args.hedgeIdOnchain];
  const sql = `
    UPDATE hedges SET
      status = $1,
      realized_pnl = COALESCE(realized_pnl, 0) + $2,
      current_pnl  = COALESCE(realized_pnl, 0) + $2,
      closed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP,
      tx_hash = COALESCE($3, tx_hash)
    WHERE hedge_id_onchain = ANY($4::varchar[])
      AND status = 'active'
    RETURNING id
  `;
  try {
    const rows = await query<{ id: number }>(sql, [
      args.status ?? 'closed',
      args.realizedPnl,
      args.closeTxDigest ?? null,
      candidates,
    ]);
    return { updated: rows.length };
  } catch (err) {
    logger.warn('[DB] closeHedgeByOnchainId failed', { error: err instanceof Error ? err.message : err });
    return { updated: 0 };
  }
}

/**
 * Insert a synthetic DB row for a Sui-pool on-chain hedge that the cron
 * opened (via Move open_hedge) without a corresponding Bluefin perp.
 *
 * order_id format: SUI_ONCHAIN_<hexHedgeId> — uniquely identifies the row
 * and avoids colliding with Bluefin order hashes.
 *
 * Idempotent: ON CONFLICT keeps the existing row (does not overwrite PnL,
 * status, etc).
 */
export async function recordSuiOnchainHedge(params: {
  hedgeIdOnchain: string;
  collateralUsdc: number;
  pairIndex: number;             // 0=BTC, 1=ETH, 2=SUI etc
  isLong: boolean;
  leverage: number;
  txDigest: string;
  walletAddress?: string;
  reason?: string;
}): Promise<{ inserted: boolean; orderId: string }> {
  await ensureHedgesTable();
  const orderId = `SUI_ONCHAIN_${params.hedgeIdOnchain}`;
  const ASSETS = ['BTC', 'ETH', 'SUI', 'CRO'];
  const asset = ASSETS[params.pairIndex] ?? `PAIR_${params.pairIndex}`;
  try {
    const sql = `
      INSERT INTO hedges (
        order_id, hedge_id_onchain, asset, market, side,
        size, notional_value, leverage, simulation_mode,
        on_chain, chain, status, tx_hash, wallet_address, reason
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, false,
        true, 'sui', 'active', $9, $10, $11
      )
      ON CONFLICT (order_id) DO NOTHING
      RETURNING id
    `;
    const rows = await query<{ id: number }>(sql, [
      orderId,
      params.hedgeIdOnchain,
      asset,
      `${asset}-PERP`,
      params.isLong ? 'LONG' : 'SHORT',
      params.collateralUsdc,
      params.collateralUsdc * Math.max(1, params.leverage),
      Math.max(1, params.leverage),
      params.txDigest,
      params.walletAddress ?? null,
      params.reason ?? 'Sui pool on-chain hedge',
    ]);
    return { inserted: rows.length > 0, orderId };
  } catch (err) {
    logger.warn('[DB] recordSuiOnchainHedge failed', { error: err instanceof Error ? err.message : err });
    return { inserted: false, orderId };
  }
}

/**
 * Best-effort row count of DB-active Sui on-chain hedges. Used by the
 * reconciliation step to detect drift vs the Move contract's
 * active_hedges vector.
 */
export async function listActiveSuiOnchainHedges(): Promise<Array<{
  orderId: string;
  hedgeIdOnchain: string | null;
  notionalValue: number;
  createdAt: Date;
}>> {
  await ensureHedgesTable();
  try {
    const rows = await query<{
      order_id: string;
      hedge_id_onchain: string | null;
      notional_value: string;
      created_at: Date;
    }>(
      `SELECT order_id, hedge_id_onchain, notional_value, created_at
       FROM hedges
       WHERE chain = 'sui' AND on_chain = true AND status = 'active' AND ${HEDGES_REAL_ONLY_SQL}`,
    );
    return rows.map(r => ({
      orderId: r.order_id,
      hedgeIdOnchain: r.hedge_id_onchain,
      notionalValue: Number(r.notional_value || 0),
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}
