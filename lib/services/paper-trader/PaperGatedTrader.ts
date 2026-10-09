/**
 * PaperGatedTrader — same signal + sizing + exit discipline as the raw
 * paper trader, but every candidate must clear the LIVE agent gate
 * (SafeExecutionGuard + HedgingAgent invariants) before opening.
 *
 * Runs as a sibling cron (`paper-gated-trader`) so we can compare
 * paper-raw vs paper-gated PnL side-by-side and isolate the question:
 *
 *   Does the agent gate stack add profit-preserving edge, or does
 *   it silently kill winners along with the losers?
 *
 * Design tenets:
 *   • Own state namespace  (`paper-gated-trader:*` cron_state keys)
 *   • Own DB tag           (portfolio_id = -4 vs raw paper's -3)
 *   • Same signal fusion   (PredictionAggregatorService.scanAndPickBest)
 *   • Same sizing          (sizeCandidate from entry-helpers)
 *   • Same exit discipline (price-anchored stop + trailing + max-hold)
 *   • ADDS agent gate      (runAgentGate from polymarket-edge-trader)
 *   • Skips rolling-drawdown kill + source-decay (raw-paper's job).
 *   • Streak-guard: NOW ENABLED as of 2026-09-23 (scoped to portfolio
 *     -4 so learning stays isolated). Was previously skipped to keep
 *     the A/B clean, but empirical result was $130 of duplicate-setup
 *     losses across the two portfolios in 48h. Both guards run before
 *     the agent-gate; A/B on the agent-gate delta is preserved because
 *     both portfolios now have the same streak-based bail-out.
 *
 * NOT a replacement for PaperTrader — a parallel research surface.
 * Intended lifespan: until the mainnet-readiness gates in
 * docs/PAPER_TO_MAINNET_READINESS.md give us a real answer.
 */
import { getLivePrice, getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';
import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { createHedge, closeHedge } from '@/lib/db/hedges';
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { selectCandidate, priceCandidate, sizeCandidate } from './entry-helpers';
import { simulateOpen, simulateClose, markToMarket, type SimulatedPosition, type Side } from './simulated-executor';
import { majorityAgreementPct } from './signal-quality';
import { targetExitLevels, takeProfitFill } from './target-exit';
import { checkRestingEntry, placeRestingEntry, type EntryPlan } from './resting-orders';
import { notifyPaperOpen, notifyPaperClose } from './notifications';
import { runAgentGate } from '@/app/api/cron/polymarket-edge-trader/handlers/agent-gate';
import {
  PAPER_UNIVERSE,
  PAPER_STARTING_NAV,
  PAPER_LEVERAGE,
  PAPER_MIN_CONFIDENCE,
  PAPER_MIN_CONSENSUS,
  PAPER_MIN_SOURCES,
  PAPER_MAX_HOLD_MIN,
  PAPER_TRAILING_STOP_GIVEBACK_PCT,
  PAPER_MIN_MAJORITY_PCT,
  PAPER_SKIP_STRONG_SIGNALS,
} from './config';

// ── Isolated state ────────────────────────────────────────────────────
const KEY_POSITION      = 'paper-gated-trader:active-position';
const KEY_ORDER_ID      = 'paper-gated-trader:active-order-id';
const KEY_NAV           = 'paper-gated-trader:nav-usd';
const KEY_STATS         = 'paper-gated-trader:stats';
const KEY_LAST_RUN      = 'cron:lastRun:paper-gated-trader';
const KEY_LAST_SKIP     = 'paper-gated-trader:last-skip';
const KEY_RESTING_ENTRY = 'paper-gated-trader:resting-entry';

const PORTFOLIO_ID = -4;
const CHAIN = 'hedera-testnet';
const ORDER_ID_PREFIX = 'paper_gated_';

interface Stats {
  trades: number;
  wins: number;
  losses: number;
  cumRealizedUsd: number;
  peakNavUsd: number;
  lastRealizedUsd: number;
  gateBlocks: number;      // count of candidates rejected by the agent gate
}

export interface TickResult {
  action: 'opened' | 'held' | 'closed' | 'skipped';
  reason?: string;
  nav?: number;
  gateBlocked?: boolean;
}

function recToSide(rec: string): Side | null {
  if (rec.includes('LONG')) return 'LONG';
  if (rec.includes('SHORT')) return 'SHORT';
  return null;
}

async function loadStats(nav: number): Promise<Stats> {
  const s = (await getCronState<Stats>(KEY_STATS)) ?? {
    trades: 0, wins: 0, losses: 0, cumRealizedUsd: 0,
    peakNavUsd: nav, lastRealizedUsd: 0, gateBlocks: 0,
  };
  if (s.peakNavUsd < nav) s.peakNavUsd = nav;
  return s;
}

async function saveSkip(now: number, reason: string, gateBlocked = false) {
  await setCronState(KEY_LAST_SKIP, { at: now, reason, gateBlocked }).catch(() => {});
}

export class PaperGatedTrader {
  /** One tick. Idempotent w.r.t. state. */
  static async runTick(now: number = Date.now()): Promise<TickResult> {
    let result: TickResult = { action: 'skipped', reason: 'unset' };
    try {
      const nav = (await getCronState<number>(KEY_NAV)) ?? PAPER_STARTING_NAV;
      const active = await getCronState<SimulatedPosition>(KEY_POSITION);
      const orderId = await getCronState<string>(KEY_ORDER_ID);

      result = active
        ? await PaperGatedTrader.handleActive(active, nav, now, orderId ?? undefined)
        : await PaperGatedTrader.handleEntry(nav, now);
      return result;
    } catch (e) {
      logger.error('[PaperGatedTrader] runTick failed', { error: errMsg(e) });
      result = { action: 'skipped', reason: `error: ${errMsg(e)}` };
      return result;
    } finally {
      await setCronState(KEY_LAST_RUN, now).catch(() => {});
      if (result.action === 'skipped') {
        await saveSkip(now, result.reason ?? '', !!result.gateBlocked);
      }
    }
  }

  /** Active-position path — price-anchored stop, trailing, max-hold, signal-flip. */
  private static async handleActive(
    pos: SimulatedPosition,
    nav: number,
    now: number,
    orderId?: string,
  ): Promise<TickResult> {
    const markPrice = await getLivePrice(pos.asset);
    if (!markPrice || markPrice <= 0) {
      return { action: 'skipped', reason: 'stale mark price (held)', nav };
    }

    // 1. Price-anchored stop-loss.
    if (pos.stopLossPrice) {
      const hit = pos.side === 'LONG'
        ? markPrice <= pos.stopLossPrice
        : markPrice >= pos.stopLossPrice;
      if (hit) {
        return PaperGatedTrader.closeAtMark(
          pos, markPrice, nav, now,
          `stop-loss: mark $${markPrice.toFixed(4)} crossed $${pos.stopLossPrice.toFixed(4)}`,
          orderId,
        );
      }
    }

    // 1b. Target-exit take-profit: such a position closes here, at the stop
    //     above or at the time limit below, and skips every other exit.
    const onTarget = pos.takeProfitPrice !== undefined;
    const tpFill = takeProfitFill(pos, markPrice);
    if (tpFill) {
      return PaperGatedTrader.closeAtMark(
        pos, tpFill.price, nav, now,
        `take-profit: mark $${markPrice.toFixed(4)} reached $${(pos.takeProfitPrice ?? 0).toFixed(4)}`,
        orderId,
        tpFill.resting,
      );
    }

    // 2. Trailing stop. Fix O (2026-09-27): arm on the position's own
    //    notional, not NAV — the NAV-relative arm never fired once.
    //    Shared threshold math in adaptive-stops.ts.
    const mtm = markToMarket(pos, markPrice, now);
    const priorPeak = pos.peakUnrealizedPnl ?? 0;
    const priorTrough = pos.troughUnrealizedPnl ?? 0;
    const currentPeak = Math.max(priorPeak, mtm.unrealizedPnlUsd);
    const currentTrough = Math.min(priorTrough, mtm.unrealizedPnlUsd);
    const { trailingArmThresholdUsd, underwaterTightenTrip } = await import('./adaptive-stops');
    const trailingArmed = currentPeak >= trailingArmThresholdUsd(pos.notionalUsd);
    if (!onTarget && trailingArmed && mtm.unrealizedPnlUsd < currentPeak * (1 - PAPER_TRAILING_STOP_GIVEBACK_PCT)) {
      return PaperGatedTrader.closeAtMark(
        pos, markPrice, nav, now,
        `trailing-stop: peak +$${currentPeak.toFixed(2)}, gave back to +$${mtm.unrealizedPnlUsd.toFixed(2)}`,
        orderId,
      );
    }
    // Persist BOTH peak (MFE) + trough (MAE) so the metadata blob at
    // close carries real values. MAE was always 0 for gated trades
    // until 2026-09-22 — corrupted every downstream stop-tuning read.
    if (currentPeak > priorPeak || currentTrough < priorTrough) {
      await setCronState(KEY_POSITION, {
        ...pos,
        peakUnrealizedPnl: currentPeak,
        troughUnrealizedPnl: currentTrough,
      }).catch(() => {});
    }

    // 2.5. Adaptive underwater tighten — same shared trip check as
    //      PaperTrader (Fix O: notional-relative depth + 45min age).
    if (!onTarget && !trailingArmed && currentPeak <= 0) {
      const ageMin = (now - pos.openedAt) / 60_000;
      const lossUsd = -mtm.unrealizedPnlUsd;
      if (underwaterTightenTrip({ ageMin, lossUsd, notionalUsd: pos.notionalUsd })) {
        return PaperGatedTrader.closeAtMark(
          pos, markPrice, nav, now,
          `underwater-tighten: ${Math.round(ageMin)}min under, never positive, loss $${lossUsd.toFixed(2)}`,
          orderId,
        );
      }
    }

    // 3. Max-hold expiry.
    const posMaxHoldMin = pos.maxHoldMin ?? PAPER_MAX_HOLD_MIN;
    if (now - pos.openedAt >= posMaxHoldMin * 60_000) {
      return PaperGatedTrader.closeAtMark(
        pos, markPrice, nav, now,
        `max-hold expired (${Math.round(posMaxHoldMin)}min)`, orderId,
      );
    }

    // 4. Signal-flip exit — mirrors the raw-paper anti-whipsaw gates
    // (PAPER_MIN_FLIP_AGE_SEC + PAPER_MIN_FLIP_CONFIDENCE, added 2026-
    // 09-22). Gated was silently keeping the pre-anti-whipsaw behavior
    // that fired -$35/-$38 BTC losses inside 15 min of open.
    const posAgeSec = (now - pos.openedAt) / 1000;
    const { PAPER_MIN_FLIP_AGE_SEC, PAPER_MIN_FLIP_CONFIDENCE, PAPER_FLIP_EXIT_ENABLED } = await import('./config');
    if (!onTarget && PAPER_FLIP_EXIT_ENABLED && posAgeSec >= PAPER_MIN_FLIP_AGE_SEC) {
      try {
        // scanAndPickBest.all returns ALL asset predictions regardless of
        // gates (gates only affect .best), so apply the flip-specific
        // gates to `live` directly, mirroring the entry gates so weak
        // 1-source or low-consensus flips can't premature-close.
        const scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
          minConfidence: 0, minConsensus: 0, minSources: 1,
        });
        const live = scan.all[pos.asset];
        const passesFlipGates =
          live
          && (live.confidence ?? 0) >= PAPER_MIN_FLIP_CONFIDENCE
          && (live.consensus ?? 0) >= PAPER_MIN_CONSENSUS
          && (live.sources?.length ?? 0) >= PAPER_MIN_SOURCES;
        if (passesFlipGates) {
          const liveSide = recToSide(live.recommendation);
          const isStrong = live.recommendation?.startsWith('STRONG_') ?? false;
          // Fix B (2026-09-25): skip flip-close on winning positions. See
          // PaperTrader.ts for the data. Applies here too — gated trader
          // has the same premature-cut problem.
          const wasWinning = (pos.peakUnrealizedPnl ?? 0) > 0;
          if (liveSide && liveSide !== pos.side && !(PAPER_SKIP_STRONG_SIGNALS && isStrong) && !wasWinning) {
            return PaperGatedTrader.closeAtMark(
              pos, markPrice, nav, now,
              `signal flipped to ${live.recommendation} (age ${Math.round(posAgeSec)}s, conf ${Math.round(live.confidence)})`,
              orderId,
            );
          }
        }
      } catch { /* signal check is optional here */ }
    }

    return { action: 'held', reason: `holding (${Math.round((now - pos.openedAt) / 60_000)}min)`, nav };
  }

  /** Entry path — signal → sizing → AGENT GATE → open. */
  private static async handleEntry(nav: number, now: number): Promise<TickResult> {
    // selectCandidate applies its own filter chain (skip-STRONG, signal-
    // quality, etc.) so by the time it returns ok, the candidate has
    // already cleared the raw-paper gates. The gated-mode delta is
    // ONLY the runAgentGate call added below.
    // A resting entry from an earlier tick is resolved first: filled = open
    // it, still resting = wait, lapsed = look for a new candidate.
    const resting = await checkRestingEntry(KEY_RESTING_ENTRY, now, async (a) => {
      const p = await priceCandidate(a);
      return p.ok ? p.markPrice : null;
    });
    if (resting.state === 'waiting') {
      const { plan, limitPrice } = resting.entry;
      return { action: 'held', reason: `resting ${plan.side} entry on ${plan.asset} @ $${limitPrice.toFixed(4)}`, nav };
    }
    if (resting.state === 'filled') {
      return PaperGatedTrader.openPosition(resting.entry.plan, resting.entry.limitPrice, nav, now, true);
    }

    const selection = await selectCandidate(now);
    if (!selection.ok) return { action: 'skipped', reason: selection.reason, nav };
    const picked = selection.picked;
    const rec = picked.prediction.recommendation;
    const asset = picked.asset;
    const side = recToSide(rec);
    if (!side) return { action: 'skipped', reason: `non-directional (${rec})`, nav };

    // Belt-and-braces majority check — selectCandidate already ran it,
    // but the config value is read at scan time so re-verifying here
    // catches any drift between raw + gated modes.
    const aggregateDirection: 'UP' | 'DOWN' | 'NEUTRAL' =
      side === 'LONG' ? 'UP' : 'DOWN';
    const majorityPct = majorityAgreementPct(aggregateDirection, picked.prediction.sources ?? []);
    if (majorityPct < PAPER_MIN_MAJORITY_PCT) {
      return {
        action: 'skipped', nav,
        reason: `majority ${(majorityPct * 100).toFixed(0)}% < ${(PAPER_MIN_MAJORITY_PCT * 100).toFixed(0)}%`,
      };
    }

    // ── Concentration guards (2026-09-23) ────────────────────────────
    // Previously the gated trader's header comment said streak-guard
    // was 'raw-paper's job' — as an A/B statement that's true, but the
    // empirical result was ~$130 of duplicate-setup losses in 48h
    // (XRP LONG concentration, then SOL LONG). Adding the guards here
    // scoped to portfolio -4 so the two portfolios still learn
    // independently but neither pyramids losses on a losing asset.
    const { assetSideStreakRejection, assetStreakRejection } = await import('./streak-guard');
    const sideStreak = await assetSideStreakRejection(asset, side, now, PORTFOLIO_ID);
    if (sideStreak) return { action: 'skipped', reason: sideStreak, nav };
    const assetStreak = await assetStreakRejection(asset, now, PORTFOLIO_ID);
    if (assetStreak) return { action: 'skipped', reason: assetStreak, nav };

    // Price + sizing (shared helpers).
    const priceResult = await priceCandidate(asset);
    if (!priceResult.ok) return { action: 'skipped', reason: priceResult.reason, nav };
    const markPrice = priceResult.markPrice;

    const sized = await sizeCandidate(picked, nav, now);
    const { notionalUsd, signalScalar } = sized;
    if (notionalUsd < 1) {
      return { action: 'skipped', reason: `notional too small ($${notionalUsd.toFixed(2)}, signal ${sized.evidence})`, nav };
    }

    // ═══════════════════════════════════════════════════════════════════
    // THE POINT OF THIS WHOLE FILE: run the live agent gate before open.
    // ═══════════════════════════════════════════════════════════════════
    const gate = await runAgentGate({ asset, side, notionalUsd });
    if (gate.skipReason) {
      const stats = await loadStats(nav);
      stats.gateBlocks += 1;
      await setCronState(KEY_STATS, stats).catch(() => {});
      logger.info('[PaperGatedTrader] gate BLOCKED entry', {
        asset, side, notionalUsd: notionalUsd.toFixed(2), reason: gate.skipReason,
      });
      return {
        action: 'skipped', nav, gateBlocked: true,
        reason: `AGENT-GATE: ${gate.skipReason}`,
      };
    }

    const { normalizeSourceKey } = await import('@/lib/services/ai/source-calibrator');
    const plan: EntryPlan = {
      asset, side, rec, notionalUsd, signalScalar,
      conf: picked.prediction.confidence,
      cons: (picked.prediction as { consensus?: number }).consensus ?? 0,
      score: picked.score,
      probe: picked.probe,
      holdHorizonMin: picked.holdHorizonMin,
      ledgerHitRate: picked.ledgerHitRate,
      // Per-source directions at entry, so each source's call can be scored
      // against the outcome at close.
      sourceSnapshot: (picked.prediction.sources ?? []).map((s) => ({
        key: normalizeSourceKey(s.name, s.type ?? ''),
        direction: s.direction,
      })),
    };
    const { PAPER_EXECUTION } = await import('./config');
    if (PAPER_EXECUTION === 'resting') {
      await placeRestingEntry(KEY_RESTING_ENTRY, plan, markPrice, now);
      return { action: 'held', nav, reason: `resting ${side} entry placed on ${asset} @ $${markPrice.toFixed(4)}` };
    }
    return PaperGatedTrader.openPosition(plan, markPrice, nav, now, false);
  }

  /**
   * Opens `plan` at `markPrice`. `resting` = the entry filled as a resting
   * order at that price (maker fee, no slippage); otherwise a market fill.
   */
  private static async openPosition(
    plan: EntryPlan,
    markPrice: number,
    nav: number,
    now: number,
    resting: boolean,
  ): Promise<TickResult> {
    const { asset, side, rec, notionalUsd, conf, cons, signalScalar, sourceSnapshot } = plan;

    // Fix O (2026-09-27): adaptive stop at entry, parity with raw paper —
    // the static 1.2% left all gated stop-outs at 0 wins (6 closes,
    // -$1,769); the 2.5% floor in computeAdaptiveThresholds is the wider
    // stop the 2026-09-22 revert actually wanted.
    // Shared hold math (Fix O, ceiling in config); a ledger-measured
    // horizon (plan.holdHorizonMin) replaces the heuristic hold.
    const { computeMaxHoldMinutes, holdPlanTag, holdPlanMeta } = await import('./sizing');
    const { PAPER_EXIT_MODE } = await import('./config');
    const target = PAPER_EXIT_MODE === 'target' ? targetExitLevels(side, markPrice) : null;
    const maxHoldMin = target?.maxHoldMin ?? computeMaxHoldMinutes(signalScalar, 1, plan.holdHorizonMin);

    const { computeAdaptiveThresholds } = await import('./adaptive-stops');
    const stopFrac = (await computeAdaptiveThresholds(asset, { holdWindowMin: maxHoldMin })).stopLossPct;
    const stopLossPrice = target?.stopLossPrice ?? (side === 'LONG'
      ? markPrice * (1 - stopFrac)
      : markPrice * (1 + stopFrac));

    const position: SimulatedPosition = {
      ...simulateOpen(
        { asset, side, notionalUsd, leverage: PAPER_LEVERAGE, entryPrice: markPrice, resting },
        now,
      ),
      sourceSnapshot,
      peakUnrealizedPnl: 0,
      entryConfidence: conf,
      entryConsensus: cons,
      maxHoldMin,
      stopLossPrice,
      ...(target ? { takeProfitPrice: target.takeProfitPrice } : {}),
    };

    const orderId = `${ORDER_ID_PREFIX}${asset}_${Math.floor(now / 1000)}`;
    await setCronState(KEY_POSITION, position);
    await setCronState(KEY_ORDER_ID, orderId);

    try {
      // Close any orphan ACTIVE row from a prior tick before writing.
      // Prevents id-711-style ghosts where cron_state moved on without
      // the DB row closing.
      const { orphanCloseIfExists } = await import('./orphan-cleanup');
      await orphanCloseIfExists({
        portfolioId: PORTFOLIO_ID,
        asset,
        side,
        newOrderId: orderId,
      });
      await createHedge({
        orderId,
        portfolioId: PORTFOLIO_ID,
        asset,
        market: `${asset}-PERP`,
        side,
        size: position.size,
        notionalValue: notionalUsd,
        leverage: PAPER_LEVERAGE,
        entryPrice: markPrice,
        stopLoss: stopLossPrice,
        takeProfit: target?.takeProfitPrice,
        simulationMode: true,
        reason: `paper-gated: ${rec} conf=${conf.toFixed(0)} score=${plan.score.toFixed(1)} | gate=allow${holdPlanTag(maxHoldMin, plan.holdHorizonMin, plan.ledgerHitRate)}`,
        predictionMarket: 'paper-aggregate',
        chain: CHAIN,
        metadata: {
          holdPlan: holdPlanMeta(maxHoldMin, plan.holdHorizonMin, plan.ledgerHitRate),
          execution: resting ? 'resting' : 'market',
        },
      });
    } catch (e) {
      logger.warn('[PaperGatedTrader] createHedge failed (state kept)', { error: errMsg(e) });
    }

    logger.info('[PaperGatedTrader] opened', {
      asset, side, notionalUsd: notionalUsd.toFixed(2), entryPrice: markPrice,
      stopLossPrice: stopLossPrice.toFixed(4), maxHoldMin: maxHoldMin.toFixed(0),
    });

    void notifyPaperOpen('PaperGated', position, resting);

    return {
      action: 'opened', nav,
      reason: `gated ${rec} on ${asset} — notional $${notionalUsd.toFixed(2)}`,
    };
  }

  private static async closeAtMark(
    pos: SimulatedPosition,
    markPrice: number,
    priorNav: number,
    now: number,
    reason: string,
    orderId?: string,
    resting: boolean = false,
  ): Promise<TickResult> {
    const closeResult = simulateClose(pos, markPrice, now, resting);
    const realizedPnl = closeResult.realizedPnlUsd;
    const newNav = priorNav + realizedPnl;

    // Learning-loop callbacks (all wired 2026-09-22 — gated was silently
    // dropping every close as training data before):
    //
    //   1. source-calibrator: score each source's snapshot direction
    //      against actual price move → sharpens per-source weights that
    //      the aggregator reads on every scan.
    //   2. bandit: record realized PnL / notional as arm reward →
    //      biases future (asset, side) selection toward winning arms.
    //   3. probability-calibrator: feed (asset, side, opening-conf-decile,
    //      realizedPnl) into the shared trader:calibration:* buckets that
    //      both live + paper read on entry.
    const { recordCloseLearning, settleHedgeRow } = await import('./close-pipeline');

    // Settle first — analytics parity with PaperTrader, and it decides which
    // of two overlapping ticks closed the position; the loser counts nothing.
    // Unification note (2026-09-29): gated's old inline UPDATE never wrote
    // funding_paid; the pipeline settles it like every other book.
    if (orderId && (await settleHedgeRow({ orderId, pos, result: closeResult, reason, nav: priorNav })) === false) {
      // Clear the slot only if it still holds this position: the tick that
      // closed it may already have opened the next one.
      if ((await getCronState<string>(KEY_ORDER_ID)) === orderId) {
        await setCronState(KEY_POSITION, null);
        await setCronState(KEY_ORDER_ID, null);
      }
      return {
        action: 'skipped',
        reason: 'already closed by an overlapping tick',
        nav: (await getCronState<number>(KEY_NAV)) ?? priorNav,
      };
    }

    await recordCloseLearning(pos, markPrice, realizedPnl, now, {
      calibratorNamespace: 'paper',
    });

    // Update state.
    const stats = await loadStats(priorNav);
    stats.trades += 1;
    stats.cumRealizedUsd += realizedPnl;
    stats.lastRealizedUsd = realizedPnl;
    if (realizedPnl > 0) stats.wins += 1;
    else if (realizedPnl < 0) stats.losses += 1;
    if (stats.peakNavUsd < newNav) stats.peakNavUsd = newNav;

    await setCronState(KEY_NAV, newNav);
    await setCronState(KEY_POSITION, null);
    await setCronState(KEY_ORDER_ID, null);
    await setCronState(KEY_STATS, stats);

    logger.info('[PaperGatedTrader] closed', {
      asset: pos.asset, side: pos.side, realizedPnl: realizedPnl.toFixed(2),
      newNav: newNav.toFixed(2), reason,
    });

    void notifyPaperClose('PaperGated', PORTFOLIO_ID, closeResult, reason, now);

    return { action: 'closed', reason, nav: newNav };
  }
}
