/**
 * PaperTrader — shadow strategy runner for edge-proving.
 *
 * Reuses the same PredictionAggregatorService the live trader consumes,
 * but routes fills through SimulatedTradeExecutor at oracle mark price
 * with realistic BlueFin-parity friction (13 bp round-trip + 11% APR
 * funding). Answers the question the live pool can't: does the signal
 * source have edge net of fees at a size where the minQty gap doesn't
 * force asset concentration?
 *
 * Isolation from the live trader:
 *   • Positions tracked under `paper-trader:*` cron_state keys
 *   • Hedge rows written with chain='hedera-testnet' and portfolio_id=-3
 *   • No BlueFin API calls, no on-chain writes, no real capital
 *   • Piggy-backed on polymarket-edge-trader's 5-min tick (QStash cap = 10)
 *
 * The trader-side signal-flip confidence gate from #101 is mirrored here
 * so paper and live share the same exit discipline.
 */
import {
  getLivePrice,
  getMultiSourceValidatedPrice,
} from '@/lib/services/market-data/unified-price-provider';
import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { positionOpen, positionUpdate, positionClose } from './concurrent';
import { selectCandidate, priceCandidate, sizeCandidate } from './entry-helpers';
import { createHedge } from '@/lib/db/hedges';
import { orphanCloseIfExists } from './orphan-cleanup';
import { recordCloseLearning, settleHedgeRow, categorizeCloseReason } from './close-pipeline';
import { targetExitLevels, takeProfitFill } from './target-exit';
import { checkRestingEntry, placeRestingEntry, type EntryPlan } from './resting-orders';
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { notifyPaper, notifyPaperOpen, notifyPaperClose, postPaperScoreboardIfDue } from './notifications';
import {
  simulateOpen,
  simulateClose,
  markToMarket,
  type SimulatedPosition,
  type SourceSnapshot,
  type Side,
} from './simulated-executor';
import {
  normalizeSourceKey,
  recordSourceOutcome,
} from '@/lib/services/ai/source-calibrator';

// ── Config + sizing helpers re-exported from focused modules ────────────
// Existing external imports keep working after this refactor. New code
// should import directly from ./config or ./sizing for less indirection.
// PAPER_STARTING_NAV is re-exported below for external callers.
export {
  PAPER_UNIVERSE,
  PAPER_STARTING_NAV,
  PAPER_LEVERAGE,
  PAPER_STAKE_PCT,
  PAPER_MAX_HOLD_MIN,
  PAPER_MAX_HOLD_EXTRA_MIN,
  PAPER_MIN_CONFIDENCE,
  PAPER_MIN_CONSENSUS,
  PAPER_MIN_SOURCES,
  PAPER_PROFIT_LOCK_DRAWDOWN_PCT,
  PAPER_STOP_LOSS_PCT,
  PAPER_MAX_CONSECUTIVE_LOSSES,
  PAPER_HALT_HOURS,
  PAPER_TRAILING_STOP_ARM_PCT,
  PAPER_TRAILING_STOP_GIVEBACK_PCT,
  PAPER_REGRET_COOLDOWN_PCT,
  PAPER_REGRET_WINDOW,
  PAPER_ASSET_VOL_MULT,
  PAPER_PORTFOLIO_ID,
  PAPER_CHAIN,
  KEY_POSITION,
  KEY_ORDER_ID,
  KEY_NAV,
  KEY_STATS,
  KEY_SESSION_STARTED_AT,
  KEY_NAV_SERIES,
  KEY_LAST_RUN,
  KEY_LAST_SKIP,
  NAV_SERIES_MAX,
} from './config';
export {
  computeSignalScalar,
  computeMaxHoldMinutes,
  computeCalibrationBoost,
} from './sizing';

import {
  PAPER_UNIVERSE,
  PAPER_STARTING_NAV,
  PAPER_LEVERAGE,
  PAPER_STAKE_PCT,
  PAPER_MAX_HOLD_MIN,
  PAPER_MIN_CONFIDENCE,
  PAPER_MIN_CONSENSUS,
  PAPER_MIN_SOURCES,
  PAPER_PROFIT_LOCK_DRAWDOWN_PCT,
  PAPER_STOP_LOSS_PCT,
  PAPER_MAX_CONSECUTIVE_LOSSES,
  PAPER_HALT_HOURS,
  PAPER_ROLLING_LOSS_WINDOW_MIN,
  PAPER_ROLLING_LOSS_COUNT_TRIP,
  PAPER_ROLLING_LOSS_USD_TRIP,
  PAPER_ROLLING_LOSS_HALT_HOURS,
  PAPER_DISABLE_HALTS,
  PAPER_MIN_FLIP_AGE_SEC,
  PAPER_FLIP_EXIT_ENABLED,
  PAPER_EXIT_MODE,
  PAPER_EXECUTION,
  KEY_RESTING_ENTRY,
  PAPER_MIN_FLIP_CONFIDENCE,
  PAPER_TRAILING_STOP_GIVEBACK_PCT,
  PAPER_ASSET_VOL_MULT,
  PAPER_PORTFOLIO_ID,
  PAPER_CHAIN,
  KEY_POSITION,
  KEY_ORDER_ID,
  KEY_NAV,
  KEY_STATS,
  KEY_SESSION_STARTED_AT,
  KEY_NAV_SERIES,
  KEY_LAST_RUN,
  KEY_LAST_SKIP,
  NAV_SERIES_MAX,
} from './config';
import {
  computeSignalScalar,
  computeMaxHoldMinutes,
  holdPlanTag,
  holdPlanMeta,
  computeCalibrationBoost,
} from './sizing';

// ── Types ─────────────────────────────────────────────────────────────────
export interface PaperStats {
  trades: number;
  wins: number;
  losses: number;
  cumRealizedUsd: number;
  peakNavUsd: number;
  lastRealizedUsd: number;
  // Optional so old stats records deserialize cleanly; hydrated on first
  // update after the 2026-09-17 risk-control patch.
  consecutiveLosses?: number;
  dailyPeakNavUsd?: number;
  dailyPeakDateUtc?: string;
  haltedUntilMs?: number;
  lastHaltReason?: string;
}

export interface TickResult {
  action: 'opened' | 'held' | 'closed' | 'skipped';
  reason?: string;
  detail?: unknown;
  nav?: number;
}

function recommendationToSide(rec: string): Side | null {
  if (rec.includes('LONG')) return 'LONG';
  if (rec.includes('SHORT')) return 'SHORT';
  return null;
}

async function pushNavSample(ts: number, nav: number): Promise<void> {
  const series = ((await getCronState<Array<{ ts: number; nav: number }>>(KEY_NAV_SERIES)) ?? []);
  series.push({ ts, nav });
  const trimmed = series.length > NAV_SERIES_MAX ? series.slice(-NAV_SERIES_MAX) : series;
  await setCronState(KEY_NAV_SERIES, trimmed);
}

function utcDateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Load stats or seed a fresh record. Reconciles daily peak on UTC-day
 * rollover so the profit-lock resets naturally at midnight rather than
 * staying halted forever after a bad day.
 */
async function loadStats(nav: number, now: number): Promise<PaperStats> {
  const stats = (await getCronState<PaperStats>(KEY_STATS)) ?? {
    trades: 0,
    wins: 0,
    losses: 0,
    cumRealizedUsd: 0,
    peakNavUsd: nav,
    lastRealizedUsd: 0,
  };
  const today = utcDateStr(now);
  if (stats.dailyPeakDateUtc !== today) {
    stats.dailyPeakDateUtc = today;
    stats.dailyPeakNavUsd = nav;
    // Fresh day resets halt AND consecutive-loss counter — a UTC-day
    // rollover is a genuine reset signal (regime change, session end,
    // etc). Old logic kept the streak alive across days which combined
    // with the halt-expiration bug below to create permanent lockouts.
    stats.haltedUntilMs = 0;
    stats.lastHaltReason = undefined;
    stats.consecutiveLosses = 0;
  }
  // Halt expiration reset (2026-09-18): once a streak halt cools off,
  // the trader must get a fresh 5-loss budget. Otherwise the halt
  // check passes (haltedUntilMs <= now) → immediately hits the
  // consecutive-loss re-trip which halts again → permanent lockout.
  // Observed 09-18 18:25 UTC on prod: trader had been halted-and-
  // re-halted for hours because the counter never cleared.
  if (
    stats.haltedUntilMs &&
    stats.haltedUntilMs <= now &&
    (stats.consecutiveLosses ?? 0) >= PAPER_MAX_CONSECUTIVE_LOSSES
  ) {
    stats.consecutiveLosses = 0;
    stats.haltedUntilMs = 0;
    stats.lastHaltReason = undefined;
    logger.info('[PaperTrader] halt expired — resetting consecutive-loss counter');
  }
  if ((stats.dailyPeakNavUsd ?? 0) < nav) stats.dailyPeakNavUsd = nav;
  if (stats.peakNavUsd < nav) stats.peakNavUsd = nav;
  return stats;
}

export class PaperTrader {
  /** One paper-trading tick. Idempotent w.r.t. state — safe to double-invoke. */
  static async runTick(now: number = Date.now()): Promise<TickResult> {
    let result: TickResult = { action: 'skipped', reason: 'unset' };
    try {
      await postPaperScoreboardIfDue(now);

      // L13 — rolling-drawdown kill switch. If the last 7-day PnL is
      // more than 2× worse than the previous 7-day period, halt for
      // 24h. Prevents another -$68K accumulation like the one that
      // triggered this whole learning-loop project.
      //
      // Cheap: one aggregate query, gated to run at most every hour
      // via a cron_state key. Failure is non-fatal — trader keeps
      // running if the check errors.
      //
      // Bypassed when PAPER_TRADER_DISABLE_HALTS=1 — pure data-gathering
      // mode wants to see the whole return distribution, not just the
      // segments where safeties allowed trading.
      //
      // A halt stops new entries only. It used to return here, before the
      // open positions were looked at, so a halted book ran no stop and no
      // time limit: on 2026-10-09 a long sat at -500 bp behind a -200 bp stop.
      let entryHalt: string | null = null;
      if (!PAPER_DISABLE_HALTS) {
        // Fix G — short-window loss halt (loss count OR magnitude in a
        // rolling 90-min window). Catches the "8/8 losses in 3h" pattern
        // that the interspersed-win-resistant consecutive-loss counter
        // silently walks around.
        entryHalt = (await PaperTrader.rollingDrawdownCheck(now))
          ?? (await PaperTrader.shortWindowLossCheck(now));
      }

      // L4 — signal-source decay check. Runs at most hourly (gated inside),
      // disables sources whose 30-trade win rate collapses below the floor.
      // Fire-and-forget: even if it errors we keep trading.
      void (async () => {
        try {
          const { runSourceDecayCheck } = await import('./source-decay');
          await runSourceDecayCheck(now);
        } catch { /* non-fatal */ }
      })();

      const nav = (await getCronState<number>(KEY_NAV)) ?? PAPER_STARTING_NAV;

      // Concurrent-mode branch: PAPER_MAX_CONCURRENT > 1 unlocks the
      // array-based active-positions storage + correlation gates. Legacy
      // single-position path stays untouched otherwise.
      const { PAPER_MAX_CONCURRENT } = await import('./config');
      if (PAPER_MAX_CONCURRENT > 1) {
        result = await PaperTrader.runTickConcurrent(nav, now, entryHalt);
        await pushNavSample(now, result.nav ?? nav);
        return result;
      }

      const activePos = await getCronState<SimulatedPosition>(KEY_POSITION);
      const activeOrderId = await getCronState<string>(KEY_ORDER_ID);
      result = activePos
        ? await PaperTrader.handleActive(activePos, nav, now, activeOrderId ?? undefined)
        : entryHalt
          ? { action: 'skipped', reason: entryHalt, nav }
          : await PaperTrader.handleEntry(nav, now);
      await pushNavSample(now, result.nav ?? nav);
      return result;
    } catch (e) {
      logger.error('[PaperTrader] runTick failed', { error: errMsg(e) });
      result = { action: 'skipped', reason: `error: ${errMsg(e)}` };
      return result;
    } finally {
      await setCronState(KEY_LAST_RUN, now).catch(() => {});
      if (result.action === 'skipped') {
        await setCronState(KEY_LAST_SKIP, {
          at: now,
          reason: result.reason ?? '',
        }).catch(() => {});
      }
    }
  }

  /**
   * Concurrent-mode tick: process every active position first (may close
   * some), then look for new opens up to PAPER_MAX_CONCURRENT, filtered
   * by same-asset dedup + correlation cluster caps.
   * Returns a synthetic TickResult summarizing the tick (last close's nav
   * is used for the caller-facing NAV bar).
   */
  private static async runTickConcurrent(nav: number, now: number, entryHalt: string | null = null): Promise<TickResult> {
    const {
      loadActivePositions,
      removeActivePosition,
      rejectionReason,
    } = await import('./concurrent');
    const { PAPER_MAX_CONCURRENT } = await import('./config');

    const active = await loadActivePositions();
    let currentNav = nav;
    let lastActionResult: TickResult = { action: 'skipped', reason: 'no-op tick', nav };
    let closesThisTick = 0;

    // 1) Process each active position. handleActive was written for the
    //    legacy path and clears KEY_POSITION on close — in concurrent mode
    //    we drop the entry from the array instead. Detect a close by the
    //    action string.
    for (const entry of active) {
      const r = await PaperTrader.handleActive(entry.position, currentNav, now, entry.orderId);
      if (r.action === 'closed') {
        await removeActivePosition(entry.orderId);
        if (typeof r.nav === 'number') currentNav = r.nav;
        closesThisTick++;
        lastActionResult = r;
      }
    }

    if (entryHalt) {
      return closesThisTick > 0 ? lastActionResult : { action: 'skipped', reason: entryHalt, nav: currentNav };
    }

    // 2) Reload after any closes. Try to open new positions until cap.
    const remaining = await loadActivePositions();
    if (remaining.length >= PAPER_MAX_CONCURRENT) {
      return closesThisTick > 0
        ? lastActionResult
        : { action: 'held', reason: `cap: ${remaining.length}/${PAPER_MAX_CONCURRENT}`, nav: currentNav };
    }

    // handleEntry opens ONE position per call; in concurrent mode we
    // still open just one per tick (keeps per-tick blast radius small
    // and lets the correlation gate re-evaluate between opens). Pass
    // the current active-set filter so handleEntry can skip candidates
    // that would fail the gate.
    const r = await PaperTrader.handleEntry(currentNav, now, {
      activeAssets: remaining.map((p) => p.position.asset),
      rejectionReason: (asset, side) => rejectionReason(asset, side, remaining),
    });
    if (r.action === 'opened' || r.action === 'skipped') {
      return r;
    }
    return closesThisTick > 0 ? lastActionResult : r;
  }

  private static async handleActive(
    pos: SimulatedPosition,
    nav: number,
    now: number,
    orderId?: string,
  ): Promise<TickResult> {
    let markPrice = await getLivePrice(pos.asset);
    if (!markPrice || markPrice <= 0) {
      // Stale price. Two escape hatches:
      //   1. If we're past max-hold AND multi-source can price the asset,
      //      close at multi-source price (avoid stuck-position bug 2026-09-18
      //      where XRP stayed open 4+ hours because getLivePrice returned 0).
      //   2. Otherwise HOLD — don't force-close on bad data; next tick retries.
      const posMaxHoldMin = pos.maxHoldMin ?? PAPER_MAX_HOLD_MIN;
      const holdMs = now - pos.openedAt;
      if (holdMs >= posMaxHoldMin * 60_000) {
        try {
          const v = await getMultiSourceValidatedPrice(pos.asset, {
            minSources: 2,
            maxDeviationPercent: 2,
            timeout: 8000,
          });
          if (v.price > 0) {
            logger.warn('[PaperTrader] stale getLivePrice past max-hold — using multi-source fallback', {
              asset: pos.asset,
              fallbackPrice: v.price,
              holdMinutes: Math.round(holdMs / 60_000),
            });
            markPrice = v.price;
          }
        } catch (e) {
          logger.warn('[PaperTrader] multi-source fallback failed on stuck position', {
            asset: pos.asset,
            holdMinutes: Math.round(holdMs / 60_000),
            error: errMsg(e),
          });
        }
      }
      if (!markPrice || markPrice <= 0) {
        logger.warn('[PaperTrader] stale/absent mark on active position — holding', {
          asset: pos.asset,
          side: pos.side,
          holdMinutes: Math.round((now - pos.openedAt) / 60_000),
        });
        return { action: 'skipped', reason: 'stale mark price on active position (held)', nav };
      }
    }

    // 1a. Price-anchored stop-loss — fires the tick mark crosses the
    //     line set at open. Deterministic vs the old NAV-percentage
    //     check which quietly never triggered (see post-mortem in
    //     simulated-executor SimulatedPosition JSDoc).
    if (pos.stopLossPrice) {
      const hit = pos.side === 'LONG' ? markPrice <= pos.stopLossPrice : markPrice >= pos.stopLossPrice;
      if (hit) {
        return PaperTrader.closeAtMark(
          pos,
          markPrice,
          nav,
          now,
          `stop-loss: mark $${markPrice.toFixed(4)} crossed $${pos.stopLossPrice.toFixed(4)}`,
          orderId,
        );
      }
    }

    // 1b. Target-exit take-profit. A position that carries one closes at the
    //     target, the stop above or the time limit below, and skips every
    //     other exit: each of those would end the trade early and pull the
    //     realized win rate away from what the shape was measured to give.
    const onTarget = pos.takeProfitPrice !== undefined;
    const tpFill = takeProfitFill(pos, markPrice);
    if (tpFill) {
      return PaperTrader.closeAtMark(
        pos,
        tpFill.price,
        nav,
        now,
        `take-profit: mark $${markPrice.toFixed(4)} reached $${(pos.takeProfitPrice ?? 0).toFixed(4)}`,
        orderId,
        tpFill.resting,
      );
    }

    // (No hard take-profit — see JSDoc on the entry-side stopLossPrice
    // computation. Trailing-stop below handles the "let winners run,
    // ratchet at give-back" case without capping the fat-tail winners
    // that carry paper trader EV.)

    const mtm = markToMarket(pos, markPrice, now);

    // 2. Trailing stop — once we've been up >= the notional-relative arm
    //    threshold, close if we've given back PAPER_TRAILING_STOP_GIVEBACK_PCT
    //    of that peak. Fix O (2026-09-27): arm was NAV-relative (nav ×
    //    trailingArmPct ≈ $2K unrealized on a ≤$30K notional = a 6.7%
    //    price move) — the trailing stop had NEVER fired in the trader's
    //    life. Now arms on the position's own notional.
    const priorPeak = pos.peakUnrealizedPnl ?? 0;
    const priorTrough = pos.troughUnrealizedPnl ?? 0;
    const currentPeak = Math.max(priorPeak, mtm.unrealizedPnlUsd);
    const currentTrough = Math.min(priorTrough, mtm.unrealizedPnlUsd);
    const { trailingArmThresholdUsd, underwaterTightenTrip } = await import('./adaptive-stops');
    const trailingArmed = currentPeak >= trailingArmThresholdUsd(pos.notionalUsd);
    if (
      !onTarget &&
      trailingArmed &&
      mtm.unrealizedPnlUsd < currentPeak * (1 - PAPER_TRAILING_STOP_GIVEBACK_PCT)
    ) {
      return PaperTrader.closeAtMark(
        pos,
        markPrice,
        nav,
        now,
        `trailing-stop: peak +$${currentPeak.toFixed(2)}, gave back to +$${mtm.unrealizedPnlUsd.toFixed(2)}`,
        orderId,
      );
    }
    // Persist the updated peak/trough so cross-tick reads see the ratchet.
    // Trough (MAE) travels only in the losing direction; peak (MFE) only in
    // the winning direction. Both persisted for post-hoc stop tuning.
    if (orderId && (currentPeak > priorPeak || currentTrough < priorTrough)) {
      await positionUpdate(orderId, (p) => ({
        ...p,
        peakUnrealizedPnl: currentPeak,
        troughUnrealizedPnl: currentTrough,
      }));
    }

    // 2.5. Adaptive underwater tighten — close a position that has NEVER
    //      gone positive once it's old AND deep underwater relative to
    //      its own notional. Fix O (2026-09-27): the old $50-flat / NAV-pct
    //      thresholds fired at a 0.17% adverse move at exactly minute 31 —
    //      15 closes, 0 wins, -$2,660 since the 9/22 reset. Thresholds
    //      live in config (PAPER_TIGHTEN_AGE_MIN / _NOTIONAL_FRAC); the
    //      shared trip check is in adaptive-stops.ts.
    if (orderId && !onTarget && !trailingArmed && currentPeak <= 0) {
      const ageMin = (now - pos.openedAt) / 60_000;
      const lossUsd = -mtm.unrealizedPnlUsd; // positive = deeper underwater
      if (underwaterTightenTrip({ ageMin, lossUsd, notionalUsd: pos.notionalUsd })) {
        return PaperTrader.closeAtMark(
          pos,
          markPrice,
          nav,
          now,
          `underwater-tighten: ${Math.round(ageMin)}min under, never positive, loss $${lossUsd.toFixed(2)}`,
          orderId,
        );
      }
    }

    // 3. Max-hold expiry → close. Uses per-position maxHoldMin (scaled by
    //    signal strength at open) with fallback to the static base for
    //    positions opened before this feature landed.
    const posMaxHoldMin = pos.maxHoldMin ?? PAPER_MAX_HOLD_MIN;
    const holdMs = now - pos.openedAt;
    if (holdMs >= posMaxHoldMin * 60_000) {
      return PaperTrader.closeAtMark(pos, markPrice, nav, now, `max-hold expired (${Math.round(posMaxHoldMin)}min)`, orderId);
    }

    // 4. Signal-flip exit (mirrors #101 confidence gate)
    //
    // Anti-whipsaw gates (2026-09-22): the raw "opposite signal above
    // 55% conf → close immediately" path caused a documented whipsaw
    // pattern — BTC LONG closed at -$35/-$38/-$39 within 15 min of open
    // because signals flipped between 60s ticks and fees + micro-adverse
    // moves ate every position. Two symmetric gates now protect exit:
    //   (a) position must be older than PAPER_MIN_FLIP_AGE_SEC (default 180s)
    //   (b) opposite signal must clear PAPER_MIN_FLIP_CONFIDENCE (default 65,
    //       higher than the 55 entry gate) to justify the round-trip cost.
    // Both env-tunable. Max-hold still catches anything that goes stale.
    const posAgeSec = (now - pos.openedAt) / 1000;
    if (onTarget || !PAPER_FLIP_EXIT_ENABLED || posAgeSec < PAPER_MIN_FLIP_AGE_SEC) {
      // Flip exit off (PAPER_TRADER_FLIP_EXIT) or too fresh to flip — falls
      // through to hold; stop, trailing and max-hold still close.
    } else {
      try {
        // scanAndPickBest.all returns ALL asset predictions regardless of
        // the gates arg (gates only affect .best selection), so we apply
        // the flip-specific gates to livePred directly — mirroring the
        // entry gates so weak 1-source or low-consensus flips can't
        // unwind a position that was opened on 3+ sources with strong
        // consensus.
        const scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
          minConfidence: 0, minConsensus: 0, minSources: 1,
        });
        const livePred = scan.all[pos.asset];
        const passesFlipGates =
          livePred
          && (livePred.confidence ?? 0) >= PAPER_MIN_FLIP_CONFIDENCE
          && (livePred.consensus ?? 0) >= PAPER_MIN_CONSENSUS
          && (livePred.sources?.length ?? 0) >= PAPER_MIN_SOURCES;
        if (passesFlipGates) {
          const liveSide = recommendationToSide(livePred.recommendation);
          const isStrong = livePred.recommendation?.startsWith('STRONG_') ?? false;
          // Mirror the entry skip-STRONG filter on flip: STRONG_ signals had
          // 13% win rate on the live trader (2026-08-28 data) — they fire
          // when the market is already priced in and mean-reversion follows.
          // If we refuse to OPEN on STRONG_, we shouldn't let STRONG_ force
          // a CLOSE either (2026-09-18 asymmetry fix).
          const { PAPER_SKIP_STRONG_SIGNALS } = await import('./config');
          // Fix B (2026-09-25): skip flip-close on winning positions.
          // 7d data: flip-close 47 trades / 25min avg hold / 45% wins / -$4 avg,
          // vs max-hold 26 trades / 130min avg hold / 50% wins / +$115 avg.
          // Half the flip-closed trades were profitable at some point (peak > 0)
          // — cutting them early cost the strategy. If already positive, ride
          // to max-hold; the winning direction has already been validated by
          // the market for this position.
          const wasWinning = (pos.peakUnrealizedPnl ?? 0) > 0;
          if (liveSide && liveSide !== pos.side && !(PAPER_SKIP_STRONG_SIGNALS && isStrong) && !wasWinning) {
            return PaperTrader.closeAtMark(
              pos,
              markPrice,
              nav,
              now,
              `signal flipped to ${livePred.recommendation} (age ${Math.round(posAgeSec)}s, conf ${Math.round(livePred.confidence)})`,
              orderId,
            );
          }
        }
      } catch (e) {
        logger.debug('[PaperTrader] flip re-scan failed (non-fatal)', { error: errMsg(e) });
      }
    }

    // 5. Otherwise hold. Report mark-to-market NAV for the chart (reuse mtm from stop-loss check above).
    const currentNav = nav + mtm.unrealizedPnlUsd;
    return {
      action: 'held',
      detail: { pos, markPrice, mtm },
      nav: currentNav,
    };
  }

  /**
   * Consider opening one new position. In legacy single-position mode
   * the concurrency filter is null (any asset viable). In concurrent
   * mode the caller passes a filter that rejects candidates already
   * active or blocked by correlation cluster caps.
   */
  private static async handleEntry(
    nav: number,
    now: number,
    concurrencyFilter?: {
      activeAssets: string[];
      rejectionReason: (asset: string, side: Side) => string | null;
    },
  ): Promise<TickResult> {
    // ── Risk-control gates (2026-09-17) ────────────────────────────────
    // Run BEFORE the signal scan so a halted trader doesn't waste an API
    // round-trip. All gates share one halted-until timestamp so a fresh
    // trip extends rather than stacks halts.
    const stats = await loadStats(nav, now);

    if (!PAPER_DISABLE_HALTS && stats.haltedUntilMs && stats.haltedUntilMs > now) {
      await setCronState(KEY_STATS, stats);
      return {
        action: 'skipped',
        reason: `halted until ${new Date(stats.haltedUntilMs).toISOString()} (${stats.lastHaltReason ?? 'unknown'})`,
        nav,
      };
    }

    const dailyPeak = stats.dailyPeakNavUsd ?? nav;
    const dailyDrawdown = dailyPeak > 0 ? (dailyPeak - nav) / dailyPeak : 0;
    if (!PAPER_DISABLE_HALTS && dailyDrawdown >= PAPER_PROFIT_LOCK_DRAWDOWN_PCT) {
      // Halt for min(PAPER_HALT_HOURS, until UTC midnight). The daily-peak
      // reset in loadStats() clears the halt at next UTC-day rollover.
      const utcMidnight = new Date(now);
      utcMidnight.setUTCHours(24, 0, 0, 0);
      stats.haltedUntilMs = Math.min(
        utcMidnight.getTime(),
        now + PAPER_HALT_HOURS * 60 * 60 * 1000,
      );
      stats.lastHaltReason = `profit-lock: daily drawdown ${(dailyDrawdown * 100).toFixed(1)}%`;
      await setCronState(KEY_STATS, stats);
      logger.warn('[PaperTrader] profit-lock tripped', {
        dailyPeak: dailyPeak.toFixed(2),
        nav: nav.toFixed(2),
        drawdownPct: (dailyDrawdown * 100).toFixed(1),
        haltedUntilMs: stats.haltedUntilMs,
      });
      void notifyPaper(
        `Paper HALT (profit-lock) • daily peak $${(dailyPeak / 1000).toFixed(1)}k → NAV $${(nav / 1000).toFixed(1)}k • drawdown ${(dailyDrawdown * 100).toFixed(1)}% • resumes ${new Date(stats.haltedUntilMs).toISOString()}`,
        'KILL',
        { source: 'paper-trader', dailyPeak, nav, drawdownPct: dailyDrawdown },
      ).catch(() => undefined);
      return { action: 'skipped', reason: stats.lastHaltReason, nav };
    }

    if (!PAPER_DISABLE_HALTS && (stats.consecutiveLosses ?? 0) >= PAPER_MAX_CONSECUTIVE_LOSSES) {
      stats.haltedUntilMs = now + PAPER_HALT_HOURS * 60 * 60 * 1000;
      stats.lastHaltReason = `${stats.consecutiveLosses} consecutive losses`;
      await setCronState(KEY_STATS, stats);
      logger.warn('[PaperTrader] consecutive-loss halt', {
        consecutiveLosses: stats.consecutiveLosses,
        haltHours: PAPER_HALT_HOURS,
      });
      void notifyPaper(
        `Paper HALT (streak) • ${stats.consecutiveLosses} consecutive losses • cooling off ${PAPER_HALT_HOURS}h`,
        'KILL',
        { source: 'paper-trader', consecutiveLosses: stats.consecutiveLosses },
      ).catch(() => undefined);
      return { action: 'skipped', reason: stats.lastHaltReason, nav };
    }

    // Persist any daily-peak refresh from loadStats().
    await setCronState(KEY_STATS, stats);

    // A resting entry from an earlier tick is resolved before anything new
    // is considered: filled = open it, still resting = wait, lapsed = move on.
    const resting = await checkRestingEntry(KEY_RESTING_ENTRY, now, async (a) => {
      const p = await priceCandidate(a);
      return p.ok ? p.markPrice : null;
    });
    if (resting.state === 'waiting') {
      const { plan, limitPrice } = resting.entry;
      return { action: 'held', reason: `resting ${plan.side} entry on ${plan.asset} @ $${limitPrice.toFixed(4)}`, nav };
    }
    if (resting.state === 'filled') {
      const { plan, limitPrice } = resting.entry;
      if (!concurrencyFilter?.rejectionReason(plan.asset, plan.side)) {
        return PaperTrader.openPosition(plan, limitPrice, nav, now, true);
      }
    }

    // 1. Signal scan + rank + filter → picked candidate (or skip reason).
    //    Helper handles: skip-STRONG, signal-quality, concurrency, signal-history,
    //    calibrator, AND the extra gates below (streak/vol/regret) via
    //    the extraGate callback so a top-pick rejection walks to the next
    //    candidate instead of aborting the whole tick.
    const { assetSideStreakRejection, assetStreakRejection, regretCooldownRejection } = await import('./streak-guard');
    const { lowVolatilityRejection } = await import('./volatility-gate');
    const extraGate = async (asset: string, side: Side, gateNow: number): Promise<string | null> => {
      const streakReject = await assetSideStreakRejection(asset, side, gateNow);
      if (streakReject) return streakReject;
      // Asset-level concentration guard — catches mixed-side loss piles
      // (e.g. SOL LONG loses → SOL SHORT loses → SOL LONG loses again).
      const assetReject = await assetStreakRejection(asset, gateNow);
      if (assetReject) return assetReject;
      const volReject = await lowVolatilityRejection(asset);
      if (volReject) return volReject;
      return regretCooldownRejection(asset, side, nav);
    };
    const selection = await selectCandidate(now, concurrencyFilter, extraGate);
    if (!selection.ok) {
      return { action: 'skipped', reason: selection.reason, nav };
    }
    const { picked } = selection;
    const asset = picked.asset;
    const rec = picked.prediction.recommendation;
    const side = picked.side;

    // Streak / vol / regret gates all ran inside extraGate above,
    // so we walk down the ranked candidate list on any per-candidate
    // rejection rather than aborting the tick on the top pick alone.

    // 3. Multi-source validated price at open — catches stale-cache bugs.
    const priceResult = await priceCandidate(asset);
    if (!priceResult.ok) {
      void notifyPaper(
        `Paper SKIP ${asset} ${side} — ${priceResult.reason}`,
        'WARN',
        { source: 'paper-trader', asset, error: priceResult.reason },
      ).catch(() => undefined);
      return { action: 'skipped', reason: priceResult.reason, nav };
    }
    const markPrice = priceResult.markPrice;

    // 4. Sizing: base stake × confidence × vol × source-calibration.
    const sized = await sizeCandidate(picked, nav, now);
    const { notionalUsd, signalScalar, volMult, calibrationBoost } = sized;
    if (notionalUsd < 1) {
      return { action: 'skipped', reason: `notional too small ($${notionalUsd.toFixed(2)})`, nav };
    }
    const conf = picked.prediction.confidence ?? 0;
    const cons = (picked.prediction as { consensus?: number }).consensus ?? 0;

    // Snapshot the source list at open so we can score each source against
    // the actual price move at close. Store normalized keys so rolling-
    // title markets (Polymarket / Delphi 5-min) accumulate in one bucket.
    const rawSources = picked.prediction.sources ?? [];
    const sourceSnapshot: SourceSnapshot[] = rawSources.map((s: any) => ({
      key: normalizeSourceKey(s.name ?? '', s.type ?? ''),
      direction: (s.direction ?? 'NEUTRAL') as 'UP' | 'DOWN' | 'NEUTRAL',
    }));

    const plan: EntryPlan = {
      asset, side, rec, notionalUsd, conf, cons, signalScalar, sourceSnapshot,
      score: picked.score,
      probe: picked.probe,
      holdHorizonMin: picked.holdHorizonMin,
      ledgerHitRate: picked.ledgerHitRate,
    };
    logger.info('[PaperTrader] entry sized', {
      asset, side,
      volMult: volMult.toFixed(2),
      calibrationBoost: calibrationBoost.toFixed(2),
      execution: PAPER_EXECUTION,
    });
    if (PAPER_EXECUTION === 'resting') {
      await placeRestingEntry(KEY_RESTING_ENTRY, plan, markPrice, now);
      return { action: 'held', reason: `resting ${side} entry placed on ${asset} @ $${markPrice.toFixed(4)}`, nav };
    }
    return PaperTrader.openPosition(plan, markPrice, nav, now, false);
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

    // Price-anchored stop-loss computed from the adaptive vol threshold
    // AT OPEN. The prior implementation only compared mtm.unrealizedPnlUsd
    // against -nav*stopLossPct — a NAV-blow-up threshold, not a per-trade
    // risk cut. At ~$600K NAV, 0.4% stop = $2.4K, needing a ~2.7% adverse
    // move on a $90K notional to trigger. In the Sept 15-17 pain window
    // every stop check quietly returned "not yet" while positions ran the
    // full max-hold. Anchoring the stop to a concrete price locks the
    // exit in at entry time and fires deterministically the moment mark
    // crosses. Exposed via `hedges.stop_loss` for dashboard + post-mortem.
    //
    // NO hard take-profit — backtest on 164 historical trades (scripts/
    // backtest-paper-trader-stops.ts, 2026-09-20) showed a 1% TP capped
    // winners for -$18K net vs stop-only. Signal has right-skewed wins
    // (a single +$11,794 trade in the window); the trailing-stop path
    // handles "let winners run, ratchet at give-back" without capping.
    //
    // Fix O (2026-09-27): entry stop wired to computeAdaptiveThresholds,
    // whose 2.5% MIN_STOP_PCT floor (commit 510b2a3f) never actually
    // reached the stop path — entry kept using the static 1.2% constant,
    // so all 9 post-reset stop-outs clustered at 1.35-1.5% of notional
    // with 0 wins (-$2,818, avg -$313 vs avg win $143). The 2026-09-22
    // revert to static was a response to the OLD 1.0-1.2% adaptive
    // floors; the raised floor is the wider stop that revert wanted.
    // Regime-scale the max-hold: CHOP shrinks 0.75× (~34min), TREND
    // expands 1.5× (~68min). maxHoldMult was dead until 2026-09-22.
    // A ledger-measured horizon (plan.holdHorizonMin) replaces all of it.
    const { getCurrentRegime, getRegimeMultipliers } = await import('./regime');
    const { regime } = await getCurrentRegime(now);
    const regMults = getRegimeMultipliers(regime);
    const target = PAPER_EXIT_MODE === 'target' ? targetExitLevels(side, markPrice) : null;
    const maxHoldMin = target?.maxHoldMin ?? computeMaxHoldMinutes(signalScalar, regMults.maxHoldMult, plan.holdHorizonMin);

    const { computeAdaptiveThresholds } = await import('./adaptive-stops');
    const stopFrac = (await computeAdaptiveThresholds(asset, { holdWindowMin: maxHoldMin })).stopLossPct;
    const stopLossPrice = target?.stopLossPrice ?? (side === 'LONG' ? markPrice * (1 - stopFrac) : markPrice * (1 + stopFrac));

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

    const orderId = `paper_${asset}_${Math.floor(now / 1000)}`;
    // positionOpen picks the storage slot (concurrent array vs legacy
    // single) based on PAPER_MAX_CONCURRENT.
    await positionOpen({ orderId, position });

    // Persist to hedges table for reuse by dashboard + analytics.
    // First close any orphan ACTIVE row for the same (portfolio, asset,
    // side) — historical bug: if the trader's cron_state moved on
    // without the row being closed (e.g. crash mid-close, redeploy
    // during close), the old row lingers as 'active' forever. Query
    // dashboards + reconcilers then double-count. Auto-close is safer
    // than manual reconcile.
    try {
      await orphanCloseIfExists({
        portfolioId: PAPER_PORTFOLIO_ID,
        asset,
        side,
        newOrderId: orderId,
      });
      await createHedge({
        orderId,
        portfolioId: PAPER_PORTFOLIO_ID,
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
        reason: `paper: ${rec} conf=${conf.toFixed(0)} score=${plan.score.toFixed(1)}${plan.probe ? ' | probe' : ''}${holdPlanTag(maxHoldMin, plan.holdHorizonMin, plan.ledgerHitRate)}`,
        predictionMarket: 'paper-aggregate',
        chain: PAPER_CHAIN,
        metadata: {
          holdPlan: holdPlanMeta(maxHoldMin, plan.holdHorizonMin, plan.ledgerHitRate),
          execution: resting ? 'resting' : 'market',
        },
      });
    } catch (e) {
      logger.warn('[PaperTrader] createHedge failed (state kept)', { error: errMsg(e) });
    }

    logger.info('[PaperTrader] opened', {
      asset,
      side,
      notionalUsd: notionalUsd.toFixed(2),
      entryPrice: markPrice,
      recommendation: rec,
      score: plan.score.toFixed(1),
      signalScalar: signalScalar.toFixed(2),
      resting,
      maxHoldMin: (position.maxHoldMin ?? PAPER_MAX_HOLD_MIN).toFixed(0),
    });

    void notifyPaperOpen('PaperTrader', position, resting);

    return {
      action: 'opened',
      detail: { asset, side, notionalUsd, markPrice, recommendation: rec },
      nav,
    };
  }

  /**
   * L13 — rolling-drawdown kill switch.
   *
   * Compares the last 7-day realized PnL to the previous 7-day period.
   * If the recent period is more than 2× more negative than the prior
   * one AND both are negative, halt the trader for 24 hours. This
   * catches the "getting worse fast" pattern without punishing a merely
   * quiet week.
   *
   * Gated by cron_state key so the check runs at most every 60 minutes.
   * Failure is non-fatal — check errors leave the trader running.
   *
   * Returns a halt-reason string if the trader should skip, or null.
   */
  private static async rollingDrawdownCheck(now: number): Promise<string | null> {
    const CHECK_KEY = 'paper-trader:rolling-dd-last-check';
    const HALT_KEY = 'paper-trader:rolling-dd-halt-until';
    try {
      const haltUntil = (await getCronState<number>(HALT_KEY)) ?? 0;
      if (haltUntil > now) {
        const minsLeft = Math.round((haltUntil - now) / 60_000);
        return `rolling-drawdown halt (${minsLeft}min remaining)`;
      }
      const lastCheck = (await getCronState<number>(CHECK_KEY)) ?? 0;
      if (now - lastCheck < 60 * 60_000) return null; // check once per hour
      await setCronState(CHECK_KEY, now);

      // Aggregate 7-day PnL windows, bounded at the current session start.
      // A session reset only resets NAV/stats in cron_state — hedges rows keep
      // the same portfolio_id — so without the bound, pre-reset losses halt a
      // freshly reset book that has made no trades at all.
      const sessionStart = (await getCronState<number>(KEY_SESSION_STARTED_AT)) ?? 0;
      const rows = await query<{ recent: string; prior: string }>(
        `SELECT
           COALESCE(SUM(realized_pnl) FILTER (WHERE closed_at > NOW() - INTERVAL '7 days'), 0) AS recent,
           COALESCE(SUM(realized_pnl) FILTER (WHERE closed_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'), 0) AS prior
         FROM hedges
         WHERE portfolio_id = $1 AND order_id LIKE 'paper_%' AND status = 'closed'
           AND closed_at >= to_timestamp($2 / 1000.0)`,
        [PAPER_PORTFOLIO_ID, sessionStart],
      );
      const recent = Number(rows[0]?.recent ?? 0);
      const prior = Number(rows[0]?.prior ?? 0);
      // Trigger only when: both periods lost money AND the recent loss
      // is at least 2× the prior loss. Bumps up sensitivity without
      // firing on a single bad day inside an otherwise steady curve.
      if (recent < 0 && prior < 0 && recent < prior * 2) {
        const haltMs = 24 * 60 * 60_000;
        await setCronState(HALT_KEY, now + haltMs);
        const msg = `rolling-drawdown: 7d PnL $${recent.toFixed(0)} vs prior 7d $${prior.toFixed(0)} — halted 24h`;
        try {
          await notifyPaper(`Paper HALT • ${msg}`, 'KILL', { component: 'paper-trader' });
        } catch { /* discord failure non-fatal */ }
        return msg;
      }
      return null;
    } catch (e) {
      logger.debug('[PaperTrader] rolling-dd check failed (non-fatal)', { error: errMsg(e) });
      return null;
    }
  }

  /**
   * Fix G — short-window rolling-loss halt.
   *
   * Counts losses in the trailing PAPER_ROLLING_LOSS_WINDOW_MIN minutes.
   * Halts if EITHER:
   *   - loss count ≥ PAPER_ROLLING_LOSS_COUNT_TRIP (default 5), OR
   *   - cumulative loss magnitude ≥ PAPER_ROLLING_LOSS_USD_TRIP (default $500)
   *
   * Different from the existing consecutive-loss halt (which resets on
   * any interspersed win) and the 7-day rolling-DD (which needs 14 days
   * of data). Designed for the "8/8 losses in 3h during a chop regime"
   * pattern observed 2026-09-25 17:00 UTC.
   *
   * Fires at most once per hour (gated by check key) and halts for
   * PAPER_ROLLING_LOSS_HALT_HOURS (default 4h) or until UTC midnight,
   * whichever comes first.
   */
  private static async shortWindowLossCheck(now: number): Promise<string | null> {
    const CHECK_KEY = 'paper-trader:short-window-loss-last-check';
    const HALT_KEY = 'paper-trader:short-window-loss-halt-until';
    try {
      const haltUntil = (await getCronState<number>(HALT_KEY)) ?? 0;
      if (haltUntil > now) {
        const minsLeft = Math.round((haltUntil - now) / 60_000);
        return `short-window-loss halt (${minsLeft}min remaining)`;
      }
      const lastCheck = (await getCronState<number>(CHECK_KEY)) ?? 0;
      // Re-check every 5 min so a fresh bad streak trips within one tick,
      // not up to an hour later like the 7-day check.
      if (now - lastCheck < 5 * 60_000) return null;
      await setCronState(CHECK_KEY, now);

      const windowStartMs = now - PAPER_ROLLING_LOSS_WINDOW_MIN * 60_000;
      const rows = await query<{ loss_count: string; loss_sum: string }>(
        `SELECT COUNT(*) FILTER (WHERE realized_pnl < 0)::text AS loss_count,
                COALESCE(SUM(realized_pnl) FILTER (WHERE realized_pnl < 0), 0)::text AS loss_sum
         FROM hedges
         WHERE portfolio_id = $1
           AND order_id LIKE 'paper_%'
           AND status = 'closed'
           AND closed_at >= to_timestamp($2 / 1000.0)`,
        [PAPER_PORTFOLIO_ID, windowStartMs],
      );
      const lossCount = Number(rows[0]?.loss_count ?? 0);
      const lossSum = Number(rows[0]?.loss_sum ?? 0); // negative
      const countTrip = lossCount >= PAPER_ROLLING_LOSS_COUNT_TRIP;
      const usdTrip = Math.abs(lossSum) >= PAPER_ROLLING_LOSS_USD_TRIP;
      if (!countTrip && !usdTrip) return null;

      const utcMidnight = new Date(now);
      utcMidnight.setUTCHours(24, 0, 0, 0);
      const haltMs = Math.min(
        utcMidnight.getTime() - now,
        PAPER_ROLLING_LOSS_HALT_HOURS * 60 * 60_000,
      );
      await setCronState(HALT_KEY, now + haltMs);
      const trippedBy = countTrip && usdTrip ? 'count + usd'
        : countTrip ? 'count'
        : 'usd';
      const msg = `short-window-loss halt (${trippedBy}): ${lossCount} losses / $${lossSum.toFixed(0)} in ${PAPER_ROLLING_LOSS_WINDOW_MIN}min — halted ${Math.round(haltMs / 60_000)}min`;
      try {
        await notifyPaper(`Paper HALT • ${msg}`, 'KILL', {
          component: 'paper-trader',
          lossCount, lossSumUsd: lossSum,
          windowMin: PAPER_ROLLING_LOSS_WINDOW_MIN,
        });
      } catch { /* discord failure non-fatal */ }
      return msg;
    } catch (e) {
      logger.debug('[PaperTrader] short-window-loss check failed (non-fatal)', { error: errMsg(e) });
      return null;
    }
  }

  /**
   * Map a raw close-reason string to a canonical short category that
   * fits the hedges.close_reason varchar(64) column. Monitoring queries
   * ("what % of paper closes are max-hold vs signal-flip vs stop-loss")
   * pivot on this — the free-text `reason` column is fine for humans
   * reading a single row but useless for structured aggregation.
   *
   * Kept as a static so the same mapping applies for both closeAtMark
   * writes and the backfill script.
   */
  /** Delegates to the shared close-pipeline (extracted 2026-09-29, audit R3). */
  static categorizeCloseReason(rawReason: string): string {
    return categorizeCloseReason(rawReason);
  }

  private static async closeAtMark(
    pos: SimulatedPosition,
    exitPrice: number,
    nav: number,
    now: number,
    reason: string,
    passedOrderId?: string,
    resting: boolean = false,
  ): Promise<TickResult> {
    const result = simulateClose(pos, exitPrice, now, resting);
    const newNav = nav + result.realizedPnlUsd;

    // Passed-in orderId is the source of truth. In legacy mode it may
    // be undefined (older call sites); fall back to KEY_ORDER_ID for
    // back-compat. Concurrent mode always provides the arg.
    // 2026-09-18: without this fallback, closeAtMark in concurrent mode
    // skipped the DB UPDATE and left rows status='active' after closing
    // in memory (observed on paper_XRP_1789759203).
    const orderId = passedOrderId ?? (await getCronState<string>(KEY_ORDER_ID)) ?? undefined;

    // Settle the hedges row FIRST via the shared pipeline (single atomic
    // UPDATE, MFE/MAE + attribution analytics): it decides which of two
    // overlapping ticks closed the position. The loser counts nothing.
    // Paper trades MUST NOT credit the real treasury — portfolio -3 stats
    // live in cron_state only (the 2026-09-18 treasury-pollution lesson).
    if (orderId && (await settleHedgeRow({ orderId, pos, result, reason, nav })) === false) {
      await positionClose(orderId);
      return {
        action: 'skipped',
        reason: 'already closed by an overlapping tick',
        nav: (await getCronState<number>(KEY_NAV)) ?? nav,
      };
    }

    // Learning callbacks — shared pipeline (source outcomes, bandit arm,
    // probability-calibrator in the 'paper' namespace per Fix O).
    await recordCloseLearning(pos, exitPrice, result.realizedPnlUsd, now, {
      calibratorNamespace: 'paper',
    });

    if (orderId) await positionClose(orderId);
    await setCronState(KEY_NAV, newNav);

    // Update stats — reuse loadStats so daily-peak + halt-reset stay in sync.
    const stats = await loadStats(newNav, now);
    stats.trades += 1;
    if (result.realizedPnlUsd > 0) {
      stats.wins += 1;
      stats.consecutiveLosses = 0;
    } else {
      stats.losses += 1;
      stats.consecutiveLosses = (stats.consecutiveLosses ?? 0) + 1;
    }
    stats.cumRealizedUsd += result.realizedPnlUsd;
    stats.lastRealizedUsd = result.realizedPnlUsd;
    stats.peakNavUsd = Math.max(stats.peakNavUsd, newNav);
    if ((stats.dailyPeakNavUsd ?? 0) < newNav) stats.dailyPeakNavUsd = newNav;
    await setCronState(KEY_STATS, stats);

    logger.info('[PaperTrader] closed', {
      asset: pos.asset,
      side: pos.side,
      reason,
      realizedUsd: result.realizedPnlUsd.toFixed(2),
      grossUsd: result.grossPnlUsd.toFixed(2),
      fees: (result.openFeeUsd + result.closeFeeUsd).toFixed(2),
      slippage: result.slippageUsd.toFixed(2),
      funding: result.fundingUsd.toFixed(4),
      holdSec: result.holdSeconds,
      newNavUsd: newNav.toFixed(2),
    });

    void notifyPaperClose('PaperTrader', PAPER_PORTFOLIO_ID, result, reason, now);

    return { action: 'closed', reason, detail: result, nav: newNav };
  }
}
