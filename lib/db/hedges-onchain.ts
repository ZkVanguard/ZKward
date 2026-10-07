/**
 * On-chain hedge DB functions — anything scoped to rows where
 * `hedge_id_onchain` is set. Extracted from lib/db/hedges.ts so the
 * perp-side queries + shared schema aren't crowded by the on-chain
 * surface area.
 *
 * Callers keep importing from '@/lib/db/hedges' (re-exports these).
 * No import-site churn.
 */
import { query } from './postgres';
import { logger } from '@/lib/utils/logger';
import { ensureHedgesTable } from './hedges-schema';
import { HEDGES_REAL_ONLY_SQL } from './hedges-scope';

// ─── Three-Layer Sync Helpers (DB ↔ On-Chain Move ↔ Bluefin Perp) ───────────
// These keep the DB authoritative when the cron settles or closes positions
// across the on-chain Move pool and the Bluefin perp exchange.

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
