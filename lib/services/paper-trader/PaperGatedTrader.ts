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
 *   • Skips redundant safeties (rolling-drawdown kill, source-decay,
 *     streak-guard) — those are raw-paper's job. Gated mode tests the
 *     agent-gate delta cleanly.
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
import { runAgentGate } from '@/app/api/cron/polymarket-edge-trader/handlers/agent-gate';
import {
  PAPER_UNIVERSE,
  PAPER_STARTING_NAV,
  PAPER_LEVERAGE,
  PAPER_MIN_CONFIDENCE,
  PAPER_MIN_CONSENSUS,
  PAPER_MIN_SOURCES,
  PAPER_MAX_HOLD_MIN,
  PAPER_TRAILING_STOP_ARM_PCT,
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

    // 2. Trailing stop.
    const mtm = markToMarket(pos, markPrice, now);
    const priorPeak = pos.peakUnrealizedPnl ?? 0;
    const priorTrough = pos.troughUnrealizedPnl ?? 0;
    const currentPeak = Math.max(priorPeak, mtm.unrealizedPnlUsd);
    const currentTrough = Math.min(priorTrough, mtm.unrealizedPnlUsd);
    const trailingArmed = currentPeak >= nav * PAPER_TRAILING_STOP_ARM_PCT;
    if (trailingArmed && mtm.unrealizedPnlUsd < currentPeak * (1 - PAPER_TRAILING_STOP_GIVEBACK_PCT)) {
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
    const { PAPER_MIN_FLIP_AGE_SEC, PAPER_MIN_FLIP_CONFIDENCE } = await import('./config');
    if (posAgeSec >= PAPER_MIN_FLIP_AGE_SEC) {
      try {
        const scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
          minConfidence: 0, minConsensus: 0, minSources: 1,
        });
        const live = scan.all[pos.asset];
        if (live && (live.confidence ?? 0) >= PAPER_MIN_FLIP_CONFIDENCE) {
          const liveSide = recToSide(live.recommendation);
          const isStrong = live.recommendation?.startsWith('STRONG_') ?? false;
          if (liveSide && liveSide !== pos.side && !(PAPER_SKIP_STRONG_SIGNALS && isStrong)) {
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

    // Price + sizing (shared helpers).
    const priceResult = await priceCandidate(asset);
    if (!priceResult.ok) return { action: 'skipped', reason: priceResult.reason, nav };
    const markPrice = priceResult.markPrice;

    const sized = await sizeCandidate(picked, nav, now);
    const { notionalUsd, signalScalar } = sized;
    if (notionalUsd < 1) {
      return { action: 'skipped', reason: `notional too small ($${notionalUsd.toFixed(2)})`, nav };
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

    // Compute stop-loss price (static threshold, no async vol fetch).
    const { _STATIC_STOP_LOSS_PCT } = await import('./adaptive-stops');
    const stopFrac = _STATIC_STOP_LOSS_PCT;
    const stopLossPrice = side === 'LONG'
      ? markPrice * (1 - stopFrac)
      : markPrice * (1 + stopFrac);

    // Simple max-hold: base + signal scalar bonus (min 45 default).
    const maxHoldMin = PAPER_MAX_HOLD_MIN + Math.max(0, (signalScalar - 0.4) * 45);

    // Snapshot the per-source directions at open so recordSourceOutcome
    // can score each source's call against the actual outcome at close.
    // Was missing until 2026-09-22 — gated closes never fed source-cal.
    const { normalizeSourceKey } = await import('@/lib/services/ai/source-calibrator');
    const sourceSnapshot = (picked.prediction.sources ?? []).map((s) => ({
      key: normalizeSourceKey(s.name, s.type ?? ''),
      direction: s.direction,
    }));

    const position: SimulatedPosition = {
      ...simulateOpen(
        { asset, side, notionalUsd, leverage: PAPER_LEVERAGE, entryPrice: markPrice },
        now,
      ),
      sourceSnapshot,
      peakUnrealizedPnl: 0,
      entryConfidence: picked.prediction.confidence,
      entryConsensus: (picked.prediction as { consensus?: number }).consensus,
      maxHoldMin,
      stopLossPrice,
    };

    const orderId = `${ORDER_ID_PREFIX}${asset}_${Math.floor(now / 1000)}`;
    await setCronState(KEY_POSITION, position);
    await setCronState(KEY_ORDER_ID, orderId);

    try {
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
        simulationMode: true,
        reason: `paper-gated: ${rec} conf=${picked.prediction.confidence.toFixed(0)} score=${picked.score.toFixed(1)} | gate=allow`,
        predictionMarket: 'paper-aggregate',
        chain: CHAIN,
      });
    } catch (e) {
      logger.warn('[PaperGatedTrader] createHedge failed (state kept)', { error: errMsg(e) });
    }

    logger.info('[PaperGatedTrader] opened', {
      asset, side, notionalUsd: notionalUsd.toFixed(2), entryPrice: markPrice,
      stopLossPrice: stopLossPrice.toFixed(4), maxHoldMin: maxHoldMin.toFixed(0),
    });

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
  ): Promise<TickResult> {
    const closeResult = simulateClose(pos, markPrice, now);
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
    const actualDir: 'UP' | 'DOWN' | 'NEUTRAL' =
      markPrice > pos.entryPrice ? 'UP' : markPrice < pos.entryPrice ? 'DOWN' : 'NEUTRAL';
    if (pos.sourceSnapshot && pos.sourceSnapshot.length > 0) {
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
    if (pos.notionalUsd > 0) {
      try {
        const { recordArmOutcome } = await import('./bandit');
        await recordArmOutcome(pos.asset, pos.side, realizedPnl / pos.notionalUsd, now);
      } catch { /* non-fatal */ }
    }
    if (pos.entryConfidence !== undefined && (pos.side === 'LONG' || pos.side === 'SHORT')) {
      try {
        const { recordOutcome } = await import('@/lib/services/ai/probability-calibrator');
        await recordOutcome({
          asset: pos.asset,
          side: pos.side,
          openConfidencePct: pos.entryConfidence,
          realizedPnl,
        });
      } catch { /* non-fatal */ }
    }

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

    // Update hedges row — categorized close_reason + attribution metadata
    // parity with PaperTrader so structured monitoring / source-decay /
    // MFE-MAE-based stop tuning all cover gated trades too.
    if (orderId) {
      try {
        const { PaperTrader } = await import('./PaperTrader');
        const category = PaperTrader.categorizeCloseReason(reason);
        const attribution = (pos.sourceSnapshot ?? []).map((s) => ({
          key: s.key,
          dir: s.direction,
          wasCorrect: s.direction !== 'NEUTRAL' && s.direction === actualDir,
        }));
        const meta = {
          mfeUsd: pos.peakUnrealizedPnl ?? 0,
          maeUsd: pos.troughUnrealizedPnl ?? 0,
          mfePctOfNav: priorNav > 0 ? (pos.peakUnrealizedPnl ?? 0) / priorNav : 0,
          maePctOfNav: priorNav > 0 ? (pos.troughUnrealizedPnl ?? 0) / priorNav : 0,
          actualDir,
          attribution,
          exitReason: reason.slice(0, 100),
        };
        await query(
          `UPDATE hedges
             SET status = 'closed',
                 realized_pnl = $1,
                 current_pnl = $1,
                 closed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP,
                 reason = COALESCE(reason,'') || ' | close: ' || $2,
                 close_reason = $3,
                 metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
           WHERE order_id = $5`,
          [realizedPnl, reason.slice(0, 100), category, JSON.stringify(meta), orderId],
        );
      } catch (e) {
        logger.warn('[PaperGatedTrader] close DB write failed', { error: errMsg(e), orderId });
      }
    }

    logger.info('[PaperGatedTrader] closed', {
      asset: pos.asset, side: pos.side, realizedPnl: realizedPnl.toFixed(2),
      newNav: newNav.toFixed(2), reason,
    });

    return { action: 'closed', reason, nav: newNav };
  }
}
