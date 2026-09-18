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
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { notifyPaper, flushPaperDigestIfDue } from './discord-digest';
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
  KEY_NAV_SERIES,
  KEY_LAST_RUN,
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
  KEY_NAV_SERIES,
  KEY_LAST_RUN,
  NAV_SERIES_MAX,
} from './config';
import {
  computeSignalScalar,
  computeMaxHoldMinutes,
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
 * Sum realized PnL for the last N closed paper trades on (asset, side).
 * Feeds the regret cooldown — an (asset, side) with a deep recent loss
 * gets skipped even if the current signal is strong. Fails soft (returns 0)
 * so a DB blip doesn't paralyze the trader.
 */
async function assetSideRecentPnl(
  asset: string,
  side: Side,
  limit: number,
): Promise<number> {
  try {
    const rows = await query<{ pnl: string | number }>(
      `SELECT COALESCE(current_pnl, realized_pnl, 0) AS pnl
       FROM hedges
       WHERE order_id LIKE 'paper_%' AND asset = $1 AND side = $2 AND status = 'closed'
       ORDER BY closed_at DESC NULLS LAST
       LIMIT $3`,
      [asset, side, limit],
    );
    return rows.reduce((sum, r) => sum + Number(r.pnl ?? 0), 0);
  } catch (e) {
    logger.debug('[PaperTrader] regret lookup failed (non-fatal)', { error: errMsg(e) });
    return 0;
  }
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
    try {
      // Flush accumulated OPEN/CLOSE digest events if due (opt-in via
      // PAPER_TRADER_DISCORD_DIGEST=1). No-op when digest disabled.
      await flushPaperDigestIfDue(now);

      const nav = (await getCronState<number>(KEY_NAV)) ?? PAPER_STARTING_NAV;

      // Concurrent-mode branch: PAPER_MAX_CONCURRENT > 1 unlocks the
      // array-based active-positions storage + correlation gates. Legacy
      // single-position path stays untouched otherwise.
      const { PAPER_MAX_CONCURRENT } = await import('./config');
      if (PAPER_MAX_CONCURRENT > 1) {
        const result = await PaperTrader.runTickConcurrent(nav, now);
        await pushNavSample(now, result.nav ?? nav);
        return result;
      }

      const activePos = await getCronState<SimulatedPosition>(KEY_POSITION);
      const activeOrderId = await getCronState<string>(KEY_ORDER_ID);
      const result = activePos
        ? await PaperTrader.handleActive(activePos, nav, now, activeOrderId ?? undefined)
        : await PaperTrader.handleEntry(nav, now);
      await pushNavSample(now, result.nav ?? nav);
      return result;
    } catch (e) {
      logger.error('[PaperTrader] runTick failed', { error: errMsg(e) });
      return { action: 'skipped', reason: `error: ${errMsg(e)}` };
    } finally {
      await setCronState(KEY_LAST_RUN, now).catch(() => {});
    }
  }

  /**
   * Concurrent-mode tick: process every active position first (may close
   * some), then look for new opens up to PAPER_MAX_CONCURRENT, filtered
   * by same-asset dedup + correlation cluster caps.
   * Returns a synthetic TickResult summarizing the tick (last close's nav
   * is used for the caller-facing NAV bar).
   */
  private static async runTickConcurrent(nav: number, now: number): Promise<TickResult> {
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

    // 1. Stop-loss (2026-09-17) — bail before the 20-min max-hold if the
    //    position has already leaked > PAPER_STOP_LOSS_PCT of NAV. Prevents
    //    the "hold-through-drawdown" pattern that dominated the -$62k bleed.
    const mtm = markToMarket(pos, markPrice, now);
    if (mtm.unrealizedPnlUsd < -nav * PAPER_STOP_LOSS_PCT) {
      return PaperTrader.closeAtMark(
        pos,
        markPrice,
        nav,
        now,
        `stop-loss: unrealized -$${Math.abs(mtm.unrealizedPnlUsd).toFixed(2)} > ${(PAPER_STOP_LOSS_PCT * 100).toFixed(1)}% of NAV`,
        orderId,
      );
    }

    // 2. Trailing stop — once we've been up >= PAPER_TRAILING_STOP_ARM_PCT
    //    of NAV, close if we've given back PAPER_TRAILING_STOP_GIVEBACK_PCT
    //    of that peak. Locks in half the winner instead of letting max-hold
    //    return the full move to zero.
    const priorPeak = pos.peakUnrealizedPnl ?? 0;
    const currentPeak = Math.max(priorPeak, mtm.unrealizedPnlUsd);
    const trailingArmed = currentPeak >= nav * PAPER_TRAILING_STOP_ARM_PCT;
    if (
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
    // Persist the updated peak so cross-tick reads see the ratchet.
    // positionUpdate handles the legacy vs concurrent branch internally.
    if (currentPeak > priorPeak && orderId) {
      await positionUpdate(orderId, (p) => ({ ...p, peakUnrealizedPnl: currentPeak }));
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
    try {
      const scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
        minConfidence: 0,
        minConsensus: 0,
        minSources: 1,
      });
      const livePred = scan.all[pos.asset];
      if (livePred && (livePred.confidence ?? 0) >= PAPER_MIN_CONFIDENCE) {
        const liveSide = recommendationToSide(livePred.recommendation);
        const isStrong = livePred.recommendation?.startsWith('STRONG_') ?? false;
        // Mirror the entry skip-STRONG filter on flip: STRONG_ signals had
        // 13% win rate on the live trader (2026-08-28 data) — they fire
        // when the market is already priced in and mean-reversion follows.
        // If we refuse to OPEN on STRONG_, we shouldn't let STRONG_ force
        // a CLOSE either (2026-09-18 asymmetry fix).
        const { PAPER_SKIP_STRONG_SIGNALS } = await import('./config');
        if (liveSide && liveSide !== pos.side && !(PAPER_SKIP_STRONG_SIGNALS && isStrong)) {
          return PaperTrader.closeAtMark(
            pos,
            markPrice,
            nav,
            now,
            `signal flipped to ${livePred.recommendation}`,
            orderId,
          );
        }
      }
    } catch (e) {
      logger.debug('[PaperTrader] flip re-scan failed (non-fatal)', { error: errMsg(e) });
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

    if (stats.haltedUntilMs && stats.haltedUntilMs > now) {
      await setCronState(KEY_STATS, stats);
      return {
        action: 'skipped',
        reason: `halted until ${new Date(stats.haltedUntilMs).toISOString()} (${stats.lastHaltReason ?? 'unknown'})`,
        nav,
      };
    }

    const dailyPeak = stats.dailyPeakNavUsd ?? nav;
    const dailyDrawdown = dailyPeak > 0 ? (dailyPeak - nav) / dailyPeak : 0;
    if (dailyDrawdown >= PAPER_PROFIT_LOCK_DRAWDOWN_PCT) {
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
      void notifyDiscord(
        `Paper HALT (profit-lock) • daily peak $${(dailyPeak / 1000).toFixed(1)}k → NAV $${(nav / 1000).toFixed(1)}k • drawdown ${(dailyDrawdown * 100).toFixed(1)}% • resumes ${new Date(stats.haltedUntilMs).toISOString()}`,
        'KILL',
        { source: 'paper-trader', dailyPeak, nav, drawdownPct: dailyDrawdown },
      ).catch(() => undefined);
      return { action: 'skipped', reason: stats.lastHaltReason, nav };
    }

    if ((stats.consecutiveLosses ?? 0) >= PAPER_MAX_CONSECUTIVE_LOSSES) {
      stats.haltedUntilMs = now + PAPER_HALT_HOURS * 60 * 60 * 1000;
      stats.lastHaltReason = `${stats.consecutiveLosses} consecutive losses`;
      await setCronState(KEY_STATS, stats);
      logger.warn('[PaperTrader] consecutive-loss halt', {
        consecutiveLosses: stats.consecutiveLosses,
        haltHours: PAPER_HALT_HOURS,
      });
      void notifyDiscord(
        `Paper HALT (streak) • ${stats.consecutiveLosses} consecutive losses • cooling off ${PAPER_HALT_HOURS}h`,
        'KILL',
        { source: 'paper-trader', consecutiveLosses: stats.consecutiveLosses },
      ).catch(() => undefined);
      return { action: 'skipped', reason: stats.lastHaltReason, nav };
    }

    // Persist any daily-peak refresh from loadStats().
    await setCronState(KEY_STATS, stats);

    // 1. Signal scan + rank + filter → picked candidate (or skip reason).
    //    Helper handles: skip-STRONG, signal-quality, concurrency, signal-history.
    const selection = await selectCandidate(now, concurrencyFilter);
    if (!selection.ok) {
      return { action: 'skipped', reason: selection.reason, nav };
    }
    const { picked } = selection;
    const asset = picked.asset;
    const rec = picked.prediction.recommendation;
    const side = picked.side;

    // 2. Per-asset regret cooldown — chronically wrong (asset, side) skipped.
    const recentPnl = await assetSideRecentPnl(asset, side, PAPER_REGRET_WINDOW);
    if (recentPnl < -nav * PAPER_REGRET_COOLDOWN_PCT) {
      logger.info('[PaperTrader] regret cooldown skip', {
        asset,
        side,
        recentPnl: recentPnl.toFixed(2),
        threshold: (-nav * PAPER_REGRET_COOLDOWN_PCT).toFixed(2),
      });
      return {
        action: 'skipped',
        reason: `regret-cooldown: ${asset} ${side} last ${PAPER_REGRET_WINDOW} = $${recentPnl.toFixed(0)}`,
        nav,
      };
    }

    // 3. Multi-source validated price at open — catches stale-cache bugs.
    const priceResult = await priceCandidate(asset);
    if (!priceResult.ok) {
      void notifyDiscord(
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

    const position: SimulatedPosition = {
      ...simulateOpen(
        { asset, side, notionalUsd, leverage: PAPER_LEVERAGE, entryPrice: markPrice },
        now,
      ),
      sourceSnapshot,
      peakUnrealizedPnl: 0,
      entryConfidence: conf,
      entryConsensus: cons,
      maxHoldMin: computeMaxHoldMinutes(signalScalar),
    };

    const orderId = `paper_${asset}_${Math.floor(now / 1000)}`;
    // positionOpen picks the storage slot (concurrent array vs legacy
    // single) based on PAPER_MAX_CONCURRENT.
    await positionOpen({ orderId, position });

    // Persist to hedges table for reuse by dashboard + analytics
    try {
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
        simulationMode: true,
        reason: `paper: ${rec} conf=${picked.prediction.confidence.toFixed(0)} score=${picked.score.toFixed(1)}`,
        predictionMarket: 'paper-aggregate',
        chain: PAPER_CHAIN,
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
      score: picked.score.toFixed(1),
      signalScalar: signalScalar.toFixed(2),
      volMult: volMult.toFixed(2),
      calibrationBoost: calibrationBoost.toFixed(2),
      maxHoldMin: (position.maxHoldMin ?? PAPER_MAX_HOLD_MIN).toFixed(0),
    });

    void notifyPaper(
      `Paper OPEN ${asset} ${side} @ $${markPrice.toFixed(2)} • notional $${(notionalUsd / 1000).toFixed(1)}k • conf ${conf.toFixed(0)} • cons ${cons.toFixed(0)}`,
      'TRADE',
      {
        source: 'paper-trader',
        asset,
        side,
        notionalUsd,
        confidence: conf,
        consensus: cons,
        signalScalar,
        volMult,
        recommendation: rec,
      },
      { at: now, kind: 'open', asset, side, notionalUsd },
    ).catch(() => undefined);

    return {
      action: 'opened',
      detail: { asset, side, notionalUsd, markPrice, recommendation: rec },
      nav,
    };
  }

  private static async closeAtMark(
    pos: SimulatedPosition,
    exitPrice: number,
    nav: number,
    now: number,
    reason: string,
    passedOrderId?: string,
  ): Promise<TickResult> {
    const result = simulateClose(pos, exitPrice, now);
    const newNav = nav + result.realizedPnlUsd;

    // Per-source outcome recording — the training signal for the meta-
    // learner. Actual direction is the sign of the price move; each
    // source's snapshot direction gets scored against it. NEUTRAL on
    // either side is a no-op inside recordSourceOutcome.
    const actualDirection: 'UP' | 'DOWN' | 'NEUTRAL' =
      exitPrice > pos.entryPrice ? 'UP' : exitPrice < pos.entryPrice ? 'DOWN' : 'NEUTRAL';
    if (pos.sourceSnapshot && pos.sourceSnapshot.length > 0) {
      await Promise.all(
        pos.sourceSnapshot.map((s) =>
          recordSourceOutcome({
            sourceKey: s.key,
            sourceDirection: s.direction,
            actualDirection,
          }).catch(() => undefined),
        ),
      );
    }

    // Passed-in orderId is the source of truth. In legacy mode it may
    // be undefined (older call sites); fall back to KEY_ORDER_ID for
    // back-compat. Concurrent mode always provides the arg.
    // 2026-09-18: without this fallback, closeAtMark in concurrent mode
    // skipped the DB UPDATE and left rows status='active' after closing
    // in memory (observed on paper_XRP_1789759203).
    const orderId = passedOrderId ?? (await getCronState<string>(KEY_ORDER_ID)) ?? undefined;
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

    // Close DB row + persist funding + close reason
    if (orderId) {
      try {
        // Single atomic UPDATE — status + pnl + funding + close-reason together.
        // Prior code did closeHedge() then a separate UPDATE for funding + reason;
        // if the 2nd write failed, the row landed in a "closed but no close-reason"
        // state that matched the phantom-close pattern from the reconciler bug
        // and confused monitoring (observed 2026-09-17).
        await query(
          `UPDATE hedges
           SET status = 'closed',
               realized_pnl = $1,
               current_pnl = $1,
               funding_paid = $2,
               closed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP,
               reason = COALESCE(reason,'') || ' | close: ' || $3
           WHERE order_id = $4`,
          [result.realizedPnlUsd, result.fundingUsd, reason.slice(0, 100), orderId],
        );
        // Paper trades MUST NOT credit the real treasury. Diagnosed
        // 2026-09-18: 126 paper closes polluted treasury_ledger with
        // -$62,158.96 of fake losses. Real trader had ~-$6 in the same
        // window. Paper is a separate portfolio (id=-3, chain=hedera-
        // testnet), stats live in cron_state — never touches treasury.
      } catch (e) {
        logger.warn('[PaperTrader] closeHedge DB write failed', { error: errMsg(e) });
      }
    }

    logger.info('[PaperTrader] closed', {
      asset: pos.asset,
      side: pos.side,
      reason,
      realizedUsd: result.realizedPnlUsd.toFixed(2),
      grossUsd: result.grossPnlUsd.toFixed(2),
      fees: (result.openFeeUsd + result.closeFeeUsd).toFixed(2),
      funding: result.fundingUsd.toFixed(4),
      holdSec: result.holdSeconds,
      newNavUsd: newNav.toFixed(2),
    });

    // Notify Discord — TRADE level for wins, WARN for losses. Stop-loss
    // and trailing-stop closes get their own log line via `reason` so
    // operators can distinguish them from natural signal-flip exits.
    // TRADE-level closes buffer into digest when PAPER_TRADER_DISCORD_DIGEST=1;
    // WARN (losses) always fires immediately so drawdowns are visible.
    const level = result.realizedPnlUsd >= 0 ? 'TRADE' : 'WARN';
    void notifyPaper(
      `Paper CLOSE ${pos.asset} ${pos.side} • ${result.realizedPnlUsd >= 0 ? '+' : ''}$${result.realizedPnlUsd.toFixed(2)} • ${reason} • NAV $${(newNav / 1000).toFixed(1)}k`,
      level,
      {
        source: 'paper-trader',
        asset: pos.asset,
        side: pos.side,
        realizedUsd: result.realizedPnlUsd,
        reason,
        holdSec: result.holdSeconds,
        newNavUsd: newNav,
      },
      {
        at: now,
        kind: 'close',
        asset: pos.asset,
        side: pos.side,
        notionalUsd: pos.notionalUsd,
        pnlUsd: result.realizedPnlUsd,
        reason,
      },
    ).catch(() => undefined);

    return { action: 'closed', reason, detail: result, nav: newNav };
  }
}
