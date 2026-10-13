/**
 * Stateful helpers — every function here mutates cron_state and/or fires
 * Discord alerts. Extracted from route.ts on 2026-08-10.
 */
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { setCronState } from '@/lib/db/cron-state';
import { BluefinService } from '@/lib/services/sui/BluefinService';
import { evaluateKillSwitch } from '@/lib/services/trading/kill-switches';
import { recordOutcome as recordCalibrationOutcome } from '@/lib/services/ai/probability-calibrator';
import type { ActiveTrade } from '@/lib/services/trading/active-trade';
import type { SupportedAsset } from '@/lib/config/trader-assets';
import { utcDayKey } from './trader-utils';
import type { EdgeStats, DailyStats } from './types';
import {
  KEY_STATS,
  KEY_DAILY,
  KEY_HALTED_UNTIL,
  KEY_ACTIVE,
  MAX_CONSECUTIVE_LOSSES,
  MAX_DRAWDOWN_PCT,
  DAILY_LOSS_CAP_USD,
  CUMULATIVE_LOSS_CAP_USD,
  BASE_STAKE_USD,
  HALT_DURATION_MS,
} from './config';

/** The venue did not confirm a close: nothing was booked and the trade is still on record. */
export class CloseNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseNotConfirmedError';
  }
}

export async function closeWithRetry(bf: BluefinService, symbol: string, openCostUsd?: number) {
  const attempt = () =>
    bf.closeHedge({ symbol, openCostUsd }).catch((e) => ({
      success: false,
      executionPrice: 0,
      fees: 0,
      error: errMsg(e),
    }));
  const first = await attempt();
  if (first && (first as { success?: boolean }).success) return first;
  // Brief backoff then retry once.
  await new Promise((r) => setTimeout(r, 1500));
  return attempt();
}

/**
 * What an open cost: the venue account's change across it when that was read
 * (a cost is a negative change), otherwise the fee the venue reported.
 */
export function openCostUsd(open: { settledUsd?: number; fees?: number }): number {
  const settled = open.settledUsd;
  if (typeof settled === 'number' && Number.isFinite(settled)) return Math.max(0, -settled);
  return Math.max(0, Number(open.fees) || 0);
}

export function pickExitPrice(close: unknown, markPriceRaw: unknown, fallback: number): number {
  const exec = Number((close as { executionPrice?: number })?.executionPrice);
  if (Number.isFinite(exec) && exec > 0) return exec;
  const mark = Number(markPriceRaw);
  if (Number.isFinite(mark) && mark > 0) return mark;
  return fallback;
}

export async function applyOutcome(
  prev: EdgeStats,
  realizedUsd: number,
  asset: SupportedAsset,
): Promise<EdgeStats> {
  const perAsset = { ...(prev.perAsset || {}) };
  const cur = perAsset[asset] || { trades: 0, wins: 0, pnlUsd: 0 };
  perAsset[asset] = {
    trades: cur.trades + 1,
    wins: cur.wins + (realizedUsd > 0 ? 1 : 0),
    pnlUsd: cur.pnlUsd + realizedUsd,
  };

  const newTotal = prev.totalPnlUsd + realizedUsd;
  const next: EdgeStats = {
    trades: prev.trades + 1,
    wins: prev.wins + (realizedUsd > 0 ? 1 : 0),
    losses: prev.losses + (realizedUsd <= 0 ? 1 : 0),
    totalPnlUsd: newTotal,
    peakPnlUsd: Math.max(prev.peakPnlUsd, newTotal),
    consecutiveLosses: realizedUsd > 0 ? 0 : prev.consecutiveLosses + 1,
    lastUpdatedMs: Date.now(),
    ...(prev.haltAnchorPnlUsd !== undefined ? { haltAnchorPnlUsd: prev.haltAnchorPnlUsd } : {}),
    perAsset,
  };
  await setCronState(KEY_STATS, next);
  return next;
}

export async function applyDaily(prev: DailyStats, realizedUsd: number): Promise<DailyStats> {
  const today = utcDayKey(Date.now());
  const base: DailyStats = prev.utcDayKey === today
    ? prev
    : { utcDayKey: today, pnlUsd: 0, trades: 0 };
  const next: DailyStats = {
    utcDayKey: base.utcDayKey,
    pnlUsd: base.pnlUsd + realizedUsd,
    trades: base.trades + 1,
  };
  await setCronState(KEY_DAILY, next);
  return next;
}

/**
 * Closing-exit helper. Consolidates the ~15-line pattern shared by all
 * closing exit branches (trailing-stop, signal-flip, max-hold, slippage
 * emergency close). NOT used by the "position vanished" branch because
 * that path books a stake-cap loss without a real BluFin close.
 *
 * Side effects (in order):
 *   1. bf.closeHedge (via closeWithRetry)
 *   2. applyOutcome (writes KEY_STATS)
 *   3. applyDaily   (writes KEY_DAILY)
 *   4. maybeHalt    (may write KEY_HALTED_UNTIL)
 *   5. setCronState(KEY_ACTIVE, null) — always LAST so a retry after
 *      partial failure still sees the active trade and re-attempts.
 */
export async function finalizeClosingExit(args: {
  bf: BluefinService;
  active: ActiveTrade;
  refPrice: number;
  safeStats: EdgeStats;
  daily: DailyStats;
  haltedUntil: number;
}): Promise<{
  exitPrice: number;
  fees: number;
  realized: number;
  newStats: EdgeStats;
  newDaily: DailyStats;
  halted: boolean;
}> {
  const openCost = Math.max(0, args.active.openCostUsd ?? 0);
  const close = await closeWithRetry(args.bf, args.active.symbol, openCost);
  // A close the venue did not confirm changes nothing here. Booking it and
  // clearing the trade left a 5x position on the venue from 2026-10-07 that
  // the trader believed was closed. The trade stays on record and the next
  // run tries again; if the position is in fact gone, that run sees it.
  if (!(close as { success?: boolean } | null)?.success) {
    const why = String((close as { error?: string } | null)?.error || 'no confirmation from the venue').slice(0, 200);
    await notifyDiscord(
      `Close of ${args.active.symbol} ${args.active.side} was not confirmed by the venue (${why}). Nothing was booked; the trade stays open on record and is retried next run.`,
      'ERROR',
      { chain: 'sui', asset: args.active.asset, side: args.active.side, size: args.active.size },
    ).catch(() => {});
    throw new CloseNotConfirmedError(`close of ${args.active.symbol} not confirmed: ${why}`);
  }
  const exitPrice = pickExitPrice(close, args.refPrice, args.active.entryPrice);
  const fees = Number((close as { fees?: number }).fees) || 0;
  const dir = args.active.side === 'LONG' ? 1 : -1;
  // The venue account's own change is the result when it could be read: the
  // same figure the row and the ledger get. The price difference is only an
  // estimate (it has no exit slippage and often no fee in it).
  const settled = (close as { settledUsd?: number }).settledUsd;
  const realized = (typeof settled === 'number' && Number.isFinite(settled)
    ? settled
    : (exitPrice - args.active.entryPrice) * args.active.size * dir - fees) - openCost;
  const newStats = await applyOutcome(args.safeStats, realized, args.active.asset);
  const newDaily = await applyDaily(args.daily, realized);
  const halted = await maybeHalt(newStats, newDaily, args.haltedUntil);
  // Feed the (asset, side, conf-bucket, outcome) tuple to the
  // probability calibrator. Next time this bucket has a signal, the EV
  // gate will see the empirically-shrunken probability instead of the
  // raw (often mis-calibrated) confidence. Non-critical — swallows on
  // error, never blocks the close finalisation.
  await recordCalibrationOutcome({
    asset: args.active.asset,
    side: args.active.side,
    openConfidencePct: args.active.confidence,
    realizedPnl: realized,
  });
  await setCronState(KEY_ACTIVE, null);
  return { exitPrice, fees, realized, newStats, newDaily, halted };
}

export async function maybeHalt(
  stats: EdgeStats,
  daily: DailyStats,
  currentHaltUntil: number,
): Promise<boolean> {
  const decision = evaluateKillSwitch(stats, daily, currentHaltUntil, {
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
    maxDrawdownPct: MAX_DRAWDOWN_PCT,
    dailyLossCapUsd: DAILY_LOSS_CAP_USD,
    baseStakeUsd: BASE_STAKE_USD,
    cumulativeLossCapUsd: CUMULATIVE_LOSS_CAP_USD,
    haltDurationMs: HALT_DURATION_MS,
  });
  if (decision.trip && decision.untilMs) {
    await setCronState(KEY_HALTED_UNTIL, decision.untilMs);
    if (decision.newAnchorPnlUsd !== undefined) {
      await setCronState(KEY_STATS, { ...stats, haltAnchorPnlUsd: decision.newAnchorPnlUsd });
    }
    logger.warn('[PolymarketEdge] KILL SWITCH TRIPPED — halting 24h', {
      reason: decision.detail,
      consecutiveLosses: stats.consecutiveLosses,
      drawdown: decision.drawdownPct,
      totalPnlUsd: stats.totalPnlUsd,
      dailyPnlUsd: daily.pnlUsd,
    });
    await notifyDiscord(`KILL SWITCH TRIPPED — halting 24h (${decision.detail})`, 'KILL', {
      totalPnlUsd: stats.totalPnlUsd,
      peakPnlUsd: stats.peakPnlUsd,
      dailyPnlUsd: daily.pnlUsd,
      consecutiveLosses: stats.consecutiveLosses,
    });
  }
  return decision.halted;
}
