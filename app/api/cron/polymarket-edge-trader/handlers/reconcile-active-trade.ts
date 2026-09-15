/**
 * Active-trade reconciliation phase for the polymarket-edge-trader.
 *
 * Extracted from route.ts on 2026-08-10. Called when the trader has an
 * ActiveTrade in cron_state — decides whether to close, defer, or hold,
 * and returns a `NextResponse` on any exit. Returns `null` when the trade
 * is still in flight and should keep running (no exit taken this tick).
 *
 * Exit branches, in order:
 *   1. Position vanished on venue (manual close / liquidation) → book worst-case stake loss
 *   2. Trailing-stop / stop-loss trigger (before max-hold expiry)
 *   3. Signal-flip / score-collapse (before max-hold expiry)
 *   4. Fee-bleed defer (in-flight trade with mid-range move, extend hold)
 *   4.5 Signal-aligned defer at max-hold (still STRONG_ + same side → extend hold)
 *   5. Max-hold expired → close and book realized PnL
 *   6. In flight, no exit condition → return 'idle'
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { setCronState } from '@/lib/db/cron-state';
import { BluefinService, type BluefinPosition } from '@/lib/services/sui/BluefinService';
import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';
import { computeEffectiveStopBps, shouldDeferMaxHold } from '@/lib/services/trading/trailing-stop';
import type { ActiveTrade } from '@/lib/services/trading/active-trade';
import { SUPPORTED_ASSETS } from '@/lib/config/trader-assets';
import type { EdgeStats, DailyStats, EdgeResult } from './types';
import { findActivePosition, recommendationToSide, isActionable } from './trader-utils';
import { applyOutcome, applyDaily, maybeHalt, finalizeClosingExit } from './state-transitions';
import { recordOutcome as recordCalibrationOutcome } from '@/lib/services/ai/probability-calibrator';
import {
  KEY_ACTIVE,
  HALT_DURATION_MS,
  STOP_LOSS_BPS,
  FEE_BREAKEVEN_BPS,
  DEFER_EXTEND_MS,
  SIGNAL_FLIP_SCORE_COLLAPSE,
  MAX_ALIGNED_DEFER_COUNT,
  MIN_CONFIDENCE,
} from './config';
import { evaluateSignalFlip } from './signal-flip';

export interface ReconcileArgs {
  bf: BluefinService;
  active: ActiveTrade;
  safeStats: EdgeStats;
  daily: DailyStats;
  haltedUntil: number;
  now: number;
  ranAt: string;
}

/**
 * Returns a NextResponse if the tick exits here (any of the 6 branches).
 * Returns null if the trade is still in flight AND the caller should
 * continue to risk gates + open path. (In-flight cases handle their own
 * 'idle' response inline via NextResponse.)
 */
export async function reconcileActiveTrade(args: ReconcileArgs): Promise<NextResponse<EdgeResult> | null> {
  const { bf, active, safeStats, daily, haltedUntil, now, ranAt } = args;

  const positions = await bf.getPositions().catch(() => [] as BluefinPosition[]);
  const livePos = findActivePosition(positions, active.symbol);

  // ── Branch 1: Position vanished externally ────────────────────────────
  if (!livePos) {
    logger.warn('[PolymarketEdge] Active trade has no live position — clearing state', {
      asset: active.asset,
    });
    await setCronState(KEY_ACTIVE, null);
    const newStats = await applyOutcome(safeStats, -active.stakeUsd, active.asset);
    const newDaily = await applyDaily(daily, -active.stakeUsd);
    const halted = await maybeHalt(newStats, newDaily, haltedUntil);
    // Book vanished-position as loss in the calibrator too — helps the
    // model learn that this (asset, side, conf-bucket) is prone to
    // silent close/rejection.
    await recordCalibrationOutcome({
      asset: active.asset,
      side: active.side,
      openConfidencePct: active.confidence,
      realizedPnl: -active.stakeUsd,
    });
    await notifyDiscord(
      `Position vanished — booked as -$${active.stakeUsd.toFixed(2)} loss`,
      'WARN',
      { asset: active.asset, side: active.side, size: active.size },
    );
    return NextResponse.json({
      success: true,
      ranAt,
      attempted: true,
      action: 'closed',
      closed: {
        symbol: active.symbol,
        asset: active.asset,
        realizedPnlUsd: -active.stakeUsd,
        win: false,
        durationS: Math.round((now - active.openedAt) / 1000),
      },
      stats: newStats,
      daily: newDaily,
      haltedUntil: halted ? haltedUntil + HALT_DURATION_MS : undefined,
    });
  }

  const expired = now >= active.closeBy;

  // ── Branch 2: Trailing-stop / stop-loss (BEFORE max-hold) ─────────────
  // livePos.markPrice reflects current mark on BlueFin. Compute move in bps,
  // ratchet high-water mark, derive effective stop. Exit only if current
  // move retraces past that stop. Winners are allowed to keep running as
  // long as they keep making new highs. dir=+1 for LONG, -1 for SHORT.
  const markPrice = Number(livePos.markPrice) || Number(active.entryPrice);
  const dir = active.side === 'LONG' ? 1 : -1;
  const moveBps = ((markPrice - active.entryPrice) / active.entryPrice) * dir * 10_000;
  const prevHighWater = active.highWaterBps ?? moveBps;
  const highWaterBps = Math.max(prevHighWater, moveBps);
  const effectiveStopBps = computeEffectiveStopBps(highWaterBps);

  if (!expired) {
    let priceExitReason: string | null = null;
    if (moveBps <= effectiveStopBps) {
      const armed = effectiveStopBps > -STOP_LOSS_BPS;
      const label = armed ? 'trailing-stop' : 'stop-loss';
      priceExitReason = `${label}: mark $${markPrice.toFixed(4)} vs entry $${active.entryPrice.toFixed(4)}, move=${moveBps.toFixed(1)}bps, hwm=${highWaterBps.toFixed(1)}bps, stop=${effectiveStopBps.toFixed(1)}bps`;
    }
    if (priceExitReason) {
      logger.warn('[PolymarketEdge] Trailing-stop exit', { reason: priceExitReason, asset: active.asset });
      const { exitPrice, realized, newStats, newDaily, halted } =
        await finalizeClosingExit({
          bf,
          active,
          refPrice: markPrice,
          safeStats,
          daily,
          haltedUntil,
        });
      await notifyDiscord(
        `${effectiveStopBps > -STOP_LOSS_BPS ? 'Trailing-stop' : 'Stop-loss'} exit: ${priceExitReason.split(':').slice(1).join(':').trim()}. Realized $${realized.toFixed(2)}`,
        realized >= 0 ? 'TRADE' : 'WARN',
        { asset: active.asset, side: active.side, exitPrice, entry: active.entryPrice, moveBps: moveBps.toFixed(1), hwm: highWaterBps.toFixed(1), stop: effectiveStopBps.toFixed(1) },
      );
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: realized >= 0 ? 'closed' : 'slippage-exit',
        closed: {
          symbol: active.symbol,
          asset: active.asset,
          realizedPnlUsd: realized,
          win: realized > 0,
          durationS: Math.round((now - active.openedAt) / 1000),
        },
        stats: newStats,
        daily: newDaily,
        haltedUntil: halted ? haltedUntil + HALT_DURATION_MS : undefined,
        reason: priceExitReason,
      });
    }
    // No exit — persist raised high-water so trailing stop keeps ratcheting.
    if (highWaterBps > prevHighWater) {
      await setCronState(KEY_ACTIVE, { ...active, highWaterBps });
    }
  }

  // ── Branch 3: Signal-flip / score-collapse (BEFORE max-hold) ──────────
  if (!expired) {
    let flipReason: string | null = null;
    try {
      const liveScan = await PredictionAggregatorService.scanAndPickBest(
        SUPPORTED_ASSETS,
        { minConfidence: 0, minConsensus: 0, minSources: 1 },
      );
      const livePred = liveScan.all[active.asset];
      if (livePred) {
        const liveScore = PredictionAggregatorService.scoreOpportunity(livePred);
        flipReason = evaluateSignalFlip({
          active,
          livePred,
          liveScore,
          minConfidence: MIN_CONFIDENCE,
          scoreCollapseRatio: SIGNAL_FLIP_SCORE_COLLAPSE,
        });
      }
    } catch (e) {
      logger.debug('[PolymarketEdge] re-scan failed (non-fatal)', { error: errMsg(e) });
    }

    // No flip → return 'idle' (in-flight tick, no action needed)
    if (!flipReason) {
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'idle',
        trade: {
          symbol: active.symbol,
          asset: active.asset,
          side: active.side,
          size: active.size,
          stakeUsd: active.stakeUsd,
          consensus: active.consensus,
          confidence: active.confidence,
          sourceCount: active.sourceCount,
          recommendation: active.recommendation,
        },
        stats: safeStats,
        daily,
        reason: `In flight (${Math.round((active.closeBy - now) / 1000)}s remaining)`,
      });
    }

    logger.warn('[PolymarketEdge] Signal-flip exit', { flipReason, asset: active.asset });
    const { exitPrice, realized, newStats, newDaily, halted } =
      await finalizeClosingExit({
        bf,
        active,
        refPrice: Number(livePos.markPrice) || 0,
        safeStats,
        daily,
        haltedUntil,
      });
    await notifyDiscord(
      `Signal-flip exit: ${flipReason}. Realized $${realized.toFixed(2)}`,
      realized >= 0 ? 'TRADE' : 'WARN',
      { asset: active.asset, side: active.side, exitPrice, entry: active.entryPrice },
    );
    return NextResponse.json({
      success: true,
      ranAt,
      attempted: true,
      action: 'signal-flip-exit',
      closed: {
        symbol: active.symbol,
        asset: active.asset,
        realizedPnlUsd: realized,
        win: realized > 0,
        durationS: Math.round((now - active.openedAt) / 1000),
      },
      stats: newStats,
      daily: newDaily,
      haltedUntil: halted ? haltedUntil + HALT_DURATION_MS : undefined,
      reason: flipReason,
    });
  }

  // ── Branch 4: Fee-bleed defer (Lever D) ───────────────────────────────
  // If in fee-trap zone (moveBps > -STOP_LOSS_BPS already true since
  // trailing didn't fire AND moveBps < FEE_BREAKEVEN_BPS), closing at
  // market realises a net loss even though the trade was directionally
  // correct. Defer by DEFER_EXTEND_MS and let the next tick decide.
  const deferCount = active.deferCount ?? 0;
  if (shouldDeferMaxHold(moveBps, deferCount)) {
    const newCloseBy = active.closeBy + DEFER_EXTEND_MS;
    await setCronState(KEY_ACTIVE, {
      ...active,
      closeBy: newCloseBy,
      highWaterBps,
      deferCount: deferCount + 1,
    });
    logger.info('[PolymarketEdge] Fee-bleed defer', {
      asset: active.asset,
      moveBps: moveBps.toFixed(1),
      deferCount: deferCount + 1,
      newCloseBy: new Date(newCloseBy).toISOString(),
    });
    return NextResponse.json({
      success: true,
      ranAt,
      attempted: true,
      action: 'idle',
      trade: {
        symbol: active.symbol,
        asset: active.asset,
        side: active.side,
        size: active.size,
        stakeUsd: active.stakeUsd,
        consensus: active.consensus,
        confidence: active.confidence,
        sourceCount: active.sourceCount,
        recommendation: active.recommendation,
      },
      stats: safeStats,
      daily,
      reason: `Fee-bleed defer #${deferCount + 1}: move ${moveBps.toFixed(1)}bps < ${FEE_BREAKEVEN_BPS}bps; extended by ${DEFER_EXTEND_MS / 60000}min`,
    });
  }

  // ── Branch 4.5: Signal-aligned defer at max-hold expiry ───────────────
  // If the signal that opened the trade is STILL STRONG_ + same side + score
  // healthy, extending the hold is strictly better than close+reopen: no
  // round-trip fees, no re-open slippage, no lost entry price. Bounded by
  // MAX_ALIGNED_DEFER_COUNT so a stubbornly-strong signal can't force
  // forever-hold. Separate counter from `deferCount` so fee-bleed and
  // aligned-signal budgets don't compete.
  const alignedDeferCount = active.alignedDeferCount ?? 0;
  if (alignedDeferCount < MAX_ALIGNED_DEFER_COUNT) {
    try {
      const liveScan = await PredictionAggregatorService.scanAndPickBest(
        SUPPORTED_ASSETS,
        { minConfidence: 0, minConsensus: 0, minSources: 1 },
      );
      const livePred = liveScan.all[active.asset];
      if (livePred) {
        const liveSide = recommendationToSide(livePred.recommendation);
        const liveScore = PredictionAggregatorService.scoreOpportunity(livePred);
        const stillAligned =
          liveSide === active.side &&
          isActionable(livePred.recommendation) &&
          livePred.recommendation.startsWith('STRONG_') &&
          liveScore >= active.entryScore * SIGNAL_FLIP_SCORE_COLLAPSE;

        if (stillAligned) {
          const newCloseBy = active.closeBy + DEFER_EXTEND_MS;
          await setCronState(KEY_ACTIVE, {
            ...active,
            closeBy: newCloseBy,
            highWaterBps,
            alignedDeferCount: alignedDeferCount + 1,
          });
          logger.info('[PolymarketEdge] Signal-aligned defer', {
            asset: active.asset,
            alignedDeferCount: alignedDeferCount + 1,
            score: liveScore.toFixed(0),
            entryScore: active.entryScore.toFixed(0),
            newCloseBy: new Date(newCloseBy).toISOString(),
          });
          return NextResponse.json({
            success: true,
            ranAt,
            attempted: true,
            action: 'idle',
            trade: {
              symbol: active.symbol,
              asset: active.asset,
              side: active.side,
              size: active.size,
              stakeUsd: active.stakeUsd,
              consensus: active.consensus,
              confidence: active.confidence,
              sourceCount: active.sourceCount,
              recommendation: active.recommendation,
            },
            stats: safeStats,
            daily,
            reason: `Signal-aligned defer #${alignedDeferCount + 1}: ${livePred.recommendation} score ${liveScore.toFixed(0)}; extended by ${DEFER_EXTEND_MS / 60000}min`,
          });
        }
      }
    } catch (e) {
      logger.debug('[PolymarketEdge] aligned-defer rescan failed (non-fatal)', { error: errMsg(e) });
    }
  }

  // ── Branch 5: Max-hold expired → close ────────────────────────────────
  const { exitPrice, fees, realized, newStats, newDaily, halted } =
    await finalizeClosingExit({
      bf,
      active,
      refPrice: Number(livePos.markPrice) || 0,
      safeStats,
      daily,
      haltedUntil,
    });

  const win = realized > 0;
  logger.info('[PolymarketEdge] Closed trade', {
    asset: active.asset,
    side: active.side,
    realizedUsd: realized.toFixed(4),
    win,
    consecutiveLosses: newStats.consecutiveLosses,
  });
  await notifyDiscord(
    `Closed ${active.asset}-PERP ${active.side}: ${win ? 'WIN' : 'LOSS'} $${realized.toFixed(2)}`,
    win ? 'TRADE' : 'WARN',
    {
      entry: active.entryPrice,
      exit: exitPrice,
      fees,
      stake: active.stakeUsd,
      totalPnl: newStats.totalPnlUsd,
    },
  );

  return NextResponse.json({
    success: true,
    ranAt,
    attempted: true,
    action: 'closed',
    closed: {
      symbol: active.symbol,
      asset: active.asset,
      realizedPnlUsd: realized,
      win,
      durationS: Math.round((now - active.openedAt) / 1000),
    },
    stats: newStats,
    daily: newDaily,
    haltedUntil: halted ? haltedUntil + HALT_DURATION_MS : undefined,
  });
}
