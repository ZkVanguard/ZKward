/**
 * Shared close pipeline for every simulated trading book.
 *
 * Extracted 2026-09-29 (audit R3): PaperTrader (-3), PaperGatedTrader (-4)
 * and OracleTrader (-5) each carried a near-identical copy of "close a
 * position" — learning callbacks, hedges-row settlement, close-reason
 * categorization. Three copies already produced one real bug (gated's
 * NULL close_reason class) and silently diverged on funding_paid (gated
 * never wrote it — unified here: every book settles funding).
 *
 * Callers keep what genuinely differs per book: stats shape, NAV keys,
 * notifications.
 */
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import type { SimulatedPosition, SimulatedCloseResult } from './simulated-executor';

export function categorizeCloseReason(rawReason: string): string {
  const r = rawReason.toLowerCase();
  if (r.includes('stop-loss')) return 'stop-loss';
  if (r.includes('trailing-stop')) return 'trailing-stop';
  if (r.includes('underwater-tighten')) return 'underwater-tighten';
  if (r.includes('max-hold')) return 'max-hold';
  if (r.includes('signal flipped') || r.includes('signal-flip')) return 'signal-flip';
  if (r.includes('liquidation')) return 'liquidation';
  if (r.includes('horizon')) return 'horizon-expiry';
  if (r.includes('halt')) return 'halt';
  return 'other';
}

export interface CloseLearningOpts {
  /** probability-calibrator namespace; omit to skip calibrator write. */
  calibratorNamespace?: string;
  /** record (asset, side) bandit arm reward. Default true when notional > 0. */
  bandit?: boolean;
  /** score sourceSnapshot directions via source-calibrator. Default true. */
  sourceOutcomes?: boolean;
}

/**
 * Learning callbacks shared by the strategy books. Every step is
 * individually non-fatal — learning must never block settlement.
 */
export async function recordCloseLearning(
  pos: SimulatedPosition,
  exitPrice: number,
  realizedPnlUsd: number,
  now: number,
  opts: CloseLearningOpts = {},
): Promise<void> {
  const actualDir: 'UP' | 'DOWN' | 'NEUTRAL' =
    exitPrice > pos.entryPrice ? 'UP' : exitPrice < pos.entryPrice ? 'DOWN' : 'NEUTRAL';

  if (opts.sourceOutcomes !== false && pos.sourceSnapshot && pos.sourceSnapshot.length > 0) {
    try {
      const { recordSourceOutcome } = await import('@/lib/services/ai/source-calibrator');
      await Promise.all(
        pos.sourceSnapshot.map((s) =>
          recordSourceOutcome({
            sourceKey: s.key,
            sourceDirection: s.direction,
            actualDirection: actualDir,
          }).catch(() => undefined),
        ),
      );
    } catch { /* non-fatal */ }
  }

  if (opts.bandit !== false && pos.notionalUsd > 0) {
    try {
      const { recordArmOutcome } = await import('./bandit');
      await recordArmOutcome(pos.asset, pos.side, realizedPnlUsd / pos.notionalUsd, now);
    } catch { /* non-fatal */ }
  }

  if (
    opts.calibratorNamespace &&
    pos.entryConfidence !== undefined &&
    (pos.side === 'LONG' || pos.side === 'SHORT')
  ) {
    try {
      const { recordOutcome } = await import('@/lib/services/ai/probability-calibrator');
      await recordOutcome({
        asset: pos.asset,
        side: pos.side,
        openConfidencePct: pos.entryConfidence,
        realizedPnl: realizedPnlUsd,
        namespace: opts.calibratorNamespace,
      });
    } catch { /* non-fatal */ }
  }
}

export interface SettleHedgeRowArgs {
  orderId: string;
  pos: SimulatedPosition;
  result: SimulatedCloseResult;
  reason: string;
  /** NAV used for mfe/mae pct-of-nav analytics; 0/undefined skips pcts. */
  nav?: number;
  /** Extra metadata merged into the jsonb blob (e.g. oracle's slug/uncertain). */
  extraMeta?: Record<string, unknown>;
  /** Skip the MFE/MAE/attribution analytics block (oracle-style rows). */
  analytics?: boolean;
}

/**
 * Single atomic hedges-row settlement: status + pnl + funding + close-reason
 * + metadata merge. One UPDATE by design — a split write once left rows
 * "closed but reason-less" (2026-09-17).
 */
export async function settleHedgeRow(args: SettleHedgeRowArgs): Promise<void> {
  const { orderId, pos, result, reason } = args;
  try {
    const exitPrice = result.exitPrice;
    const actualDir: 'UP' | 'DOWN' | 'NEUTRAL' =
      exitPrice > pos.entryPrice ? 'UP' : exitPrice < pos.entryPrice ? 'DOWN' : 'NEUTRAL';

    let meta: Record<string, unknown> = {
      slippageUsd: result.slippageUsd,
      exitReason: reason.slice(0, 100),
      ...args.extraMeta,
    };
    if (args.analytics !== false) {
      const nav = args.nav ?? 0;
      const attribution = (pos.sourceSnapshot ?? []).map((s) => ({
        key: s.key,
        dir: s.direction,
        wasCorrect: s.direction !== 'NEUTRAL' && s.direction === actualDir,
      }));
      meta = {
        mfeUsd: pos.peakUnrealizedPnl ?? 0,
        maeUsd: pos.troughUnrealizedPnl ?? 0,
        mfePctOfNav: nav > 0 ? (pos.peakUnrealizedPnl ?? 0) / nav : 0,
        maePctOfNav: nav > 0 ? (pos.troughUnrealizedPnl ?? 0) / nav : 0,
        actualDir,
        attribution,
        ...meta,
      };
    }

    const category = categorizeCloseReason(reason);
    await query(
      `UPDATE hedges
       SET status = 'closed',
           realized_pnl = $1,
           current_pnl = $1,
           funding_paid = $2,
           closed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           reason = COALESCE(reason,'') || ' | close: ' || $3,
           close_reason = $6,
           metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
       WHERE order_id = $4`,
      [
        result.realizedPnlUsd,
        result.fundingUsd,
        reason.slice(0, 100),
        orderId,
        JSON.stringify(meta),
        category,
      ],
    );
  } catch (e) {
    logger.warn('[close-pipeline] hedges settlement failed', {
      error: errMsg(e),
      orderId,
    });
  }
}
