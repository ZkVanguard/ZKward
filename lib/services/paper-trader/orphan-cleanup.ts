/**
 * Orphan-row cleanup — closes any lingering status='active' hedges
 * rows for a given (portfolio_id, asset, side) tuple before the trader
 * writes a new active row for the same tuple.
 *
 * Motivating incident 2026-09-23: PaperGatedTrader's cron_state
 * active-position moved from id 711 (BTC LONG opened 05:33) to id 717
 * (BTC LONG opened 09:29) without ever setting 711.status='closed'.
 * The dashboard's active-hedges query then counted both, double-showing
 * a non-existent position. Cause was likely a crash / redeploy between
 * the close-state update and the DB write.
 *
 * Auto-cleanup at open time is safer than periodic reconciliation:
 * we know the row is orphaned because the SAME trader is opening a new
 * position on the SAME (asset, side) — the old one can only be stale.
 */
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';

export async function orphanCloseIfExists(input: {
  portfolioId: number;
  asset: string;
  side: 'LONG' | 'SHORT';
  newOrderId: string;
}): Promise<void> {
  const { portfolioId, asset, side, newOrderId } = input;
  try {
    const rows = await query<{ id: number; order_id: string }>(
      `UPDATE hedges
       SET status = 'closed',
           closed_at = NOW(),
           realized_pnl = COALESCE(realized_pnl, 0),
           current_pnl = COALESCE(current_pnl, 0),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'exitReason', 'orphan-auto-close: superseded by ' || $4::text || ' (same portfolio + asset + side)',
             'orphanAutoClosedAt', extract(epoch from now()) * 1000
           )
       WHERE portfolio_id = $1
         AND asset = $2
         AND side = $3
         AND status = 'active'
         AND order_id LIKE 'paper_%'
         AND order_id != $4
       RETURNING id, order_id`,
      [portfolioId, asset, side, newOrderId],
    );
    if (rows.length > 0) {
      logger.warn('[paper-trader] orphan-auto-close', {
        portfolioId, asset, side,
        closedIds: rows.map((r) => r.id),
        closedOrderIds: rows.map((r) => r.order_id),
        newOrderId,
      });
    }
  } catch (e) {
    logger.warn('[paper-trader] orphan-close failed (non-fatal)', {
      portfolioId, asset, side, error: errMsg(e),
    });
  }
}
