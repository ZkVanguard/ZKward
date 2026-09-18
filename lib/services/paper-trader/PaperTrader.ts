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
import { createHedge } from '@/lib/db/hedges';
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import {
  simulateOpen,
  simulateClose,
  markToMarket,
  type SimulatedPosition,
  type SourceSnapshot,
  type Side,
} from './simulated-executor';
import { normalizeSourceKey, recordSourceOutcome } from '@/lib/services/ai/source-calibrator';

// ── Config (env-tunable) ─────────────────────────────────────────────────
export const PAPER_UNIVERSE = (process.env.PAPER_TRADER_ASSETS || 'BTC,ETH,SOL,XRP,DOGE')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const PAPER_STARTING_NAV = Number(process.env.PAPER_TRADER_STARTING_NAV || 100_000);
export const PAPER_LEVERAGE = Number(process.env.PAPER_TRADER_LEVERAGE || 3);
// Reduced 2026-09-17 from 0.20 -> 0.05. At 20% stake × 3x leverage, every
// trade risked 60% of NAV in gross notional. Observed 118 trades, 25% win
// rate, -$62.5k in 2.4 days on a $607k NAV — sizing did the damage, not
// signal quality.
export const PAPER_STAKE_PCT = Number(process.env.PAPER_TRADER_STAKE_PCT || 0.05);
export const PAPER_MAX_HOLD_MIN = Number(process.env.PAPER_TRADER_MAX_HOLD_MIN || 20);
export const PAPER_MIN_CONFIDENCE = Number(process.env.PAPER_TRADER_MIN_CONFIDENCE || 55);
export const PAPER_MIN_CONSENSUS = Number(process.env.PAPER_TRADER_MIN_CONSENSUS || 50);
export const PAPER_MIN_SOURCES = Number(process.env.PAPER_TRADER_MIN_SOURCES || 2);

// Risk-control gates added 2026-09-17.
export const PAPER_PROFIT_LOCK_DRAWDOWN_PCT = Number(
  process.env.PAPER_TRADER_PROFIT_LOCK_DRAWDOWN || 0.05,
);
export const PAPER_STOP_LOSS_PCT = Number(process.env.PAPER_TRADER_STOP_LOSS_PCT || 0.02);
export const PAPER_MAX_CONSECUTIVE_LOSSES = Number(
  process.env.PAPER_TRADER_MAX_CONSECUTIVE_LOSSES || 5,
);
export const PAPER_HALT_HOURS = Number(process.env.PAPER_TRADER_HALT_HOURS || 4);

// Trailing-stop + confidence-weighting + regret cooldown (2026-09-17 pt.2).
// The trader now uses signal strength directly instead of treating a 55%
// confidence and a 90% confidence identically.
export const PAPER_TRAILING_STOP_ARM_PCT = Number(
  process.env.PAPER_TRADER_TRAILING_ARM_PCT || 0.01,
);
export const PAPER_TRAILING_STOP_GIVEBACK_PCT = Number(
  process.env.PAPER_TRADER_TRAILING_GIVEBACK_PCT || 0.5,
);
export const PAPER_REGRET_COOLDOWN_PCT = Number(
  process.env.PAPER_TRADER_REGRET_COOLDOWN_PCT || 0.02,
);
export const PAPER_REGRET_WINDOW = Number(process.env.PAPER_TRADER_REGRET_WINDOW || 20);

/** Per-asset volatility multiplier — the "vol parity" fix. SOL and small-caps
 *  are ~2x more volatile than BTC; equal notional means unequal risk. This
 *  scales stake DOWN for high-vol assets so the max-loss floor lines up.
 *  Override with PAPER_TRADER_ASSET_VOL_MULT='{"BTC":1,"ETH":0.9,...}'. */
export const PAPER_ASSET_VOL_MULT: Record<string, number> = (() => {
  const raw = process.env.PAPER_TRADER_ASSET_VOL_MULT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Fall through to default.
    }
  }
  return { BTC: 1.0, ETH: 0.85, SOL: 0.55, XRP: 0.65, DOGE: 0.50 };
})();

/**
 * Confidence-weighted stake scalar. Rides the 55–100 confidence range and
 * the 50–100 consensus range, averaged to a single scalar in [0.4, 2.0].
 * Ensures a min-gate 55/50 signal gets 0.4× nominal (skin in the game) and
 * a 100/100 exceptional signal gets 2× nominal.
 */
export function computeSignalScalar(confidence: number, consensus: number): number {
  const confN = Math.max(0, Math.min(1, (confidence - 55) / 45));
  const consN = Math.max(0, Math.min(1, (consensus - 50) / 50));
  const avg = (confN + consN) / 2;
  return 0.4 + avg * 1.6;
}

// Reserved portfolio ID for paper trader (community pool = -1, SUI = -2).
export const PAPER_PORTFOLIO_ID = -3;
export const PAPER_CHAIN = 'hedera-testnet';

// ── State keys ───────────────────────────────────────────────────────────
export const KEY_POSITION = 'paper-trader:active-position';
export const KEY_ORDER_ID = 'paper-trader:active-order-id';
export const KEY_NAV = 'paper-trader:nav-usd';
export const KEY_STATS = 'paper-trader:stats';
export const KEY_NAV_SERIES = 'paper-trader:nav-series'; // ring of {ts, nav}
export const KEY_LAST_RUN = 'cron:lastRun:paper-trader';

const NAV_SERIES_MAX = 500;

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
    // Fresh day resets the halt. Consecutive-losses count carries across
    // days on purpose — a losing streak is still a losing streak.
    stats.haltedUntilMs = 0;
    stats.lastHaltReason = undefined;
  }
  if ((stats.dailyPeakNavUsd ?? 0) < nav) stats.dailyPeakNavUsd = nav;
  if (stats.peakNavUsd < nav) stats.peakNavUsd = nav;
  return stats;
}

export class PaperTrader {
  /** One paper-trading tick. Idempotent w.r.t. state — safe to double-invoke. */
  static async runTick(now: number = Date.now()): Promise<TickResult> {
    try {
      const nav = (await getCronState<number>(KEY_NAV)) ?? PAPER_STARTING_NAV;
      const activePos = await getCronState<SimulatedPosition>(KEY_POSITION);

      const result = activePos
        ? await PaperTrader.handleActive(activePos, nav, now)
        : await PaperTrader.handleEntry(nav, now);

      // Update NAV series on every tick so the chart is dense
      await pushNavSample(now, result.nav ?? nav);

      return result;
    } catch (e) {
      logger.error('[PaperTrader] runTick failed', { error: errMsg(e) });
      return { action: 'skipped', reason: `error: ${errMsg(e)}` };
    } finally {
      await setCronState(KEY_LAST_RUN, now).catch(() => {});
    }
  }

  private static async handleActive(
    pos: SimulatedPosition,
    nav: number,
    now: number,
  ): Promise<TickResult> {
    let markPrice = await getLivePrice(pos.asset);
    if (!markPrice || markPrice <= 0) {
      // Stale price. Two escape hatches:
      //   1. If we're past max-hold AND multi-source can price the asset,
      //      close at multi-source price (avoid stuck-position bug 2026-09-18
      //      where XRP stayed open 4+ hours because getLivePrice returned 0).
      //   2. Otherwise HOLD — don't force-close on bad data; next tick retries.
      const holdMs = now - pos.openedAt;
      if (holdMs >= PAPER_MAX_HOLD_MIN * 60_000) {
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
      );
    }
    // Persist the updated peak so cross-tick reads see the ratchet.
    if (currentPeak > priorPeak) {
      await setCronState(KEY_POSITION, { ...pos, peakUnrealizedPnl: currentPeak });
    }

    // 3. Max-hold expiry → close
    const holdMs = now - pos.openedAt;
    if (holdMs >= PAPER_MAX_HOLD_MIN * 60_000) {
      return PaperTrader.closeAtMark(pos, markPrice, nav, now, 'max-hold expired');
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
        if (liveSide && liveSide !== pos.side) {
          return PaperTrader.closeAtMark(
            pos,
            markPrice,
            nav,
            now,
            `signal flipped to ${livePred.recommendation}`,
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

  private static async handleEntry(nav: number, now: number): Promise<TickResult> {
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

    let scan: Awaited<ReturnType<typeof PredictionAggregatorService.scanAndPickBest>>;
    try {
      scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
        minConfidence: PAPER_MIN_CONFIDENCE,
        minConsensus: PAPER_MIN_CONSENSUS,
        minSources: PAPER_MIN_SOURCES,
      });
    } catch (e) {
      return { action: 'skipped', reason: `scan failed: ${errMsg(e)}`, nav };
    }
    if (!scan.best) {
      logger.warn('[PaperTrader] scan.best null — no asset met gates', {
        min: { conf: PAPER_MIN_CONFIDENCE, cons: PAPER_MIN_CONSENSUS, sources: PAPER_MIN_SOURCES },
        universeSize: PAPER_UNIVERSE.length,
      });
      return { action: 'skipped', reason: 'no edge above gates', nav };
    }

    const asset = scan.best.asset;
    const rec = scan.best.prediction.recommendation;
    const side = recommendationToSide(rec);
    if (!side) {
      logger.warn('[PaperTrader] non-directional signal skipped', {
        asset, rec, conf: scan.best.prediction.confidence,
      });
      return { action: 'skipped', reason: 'non-directional signal', nav };
    }

    // Per-asset regret cooldown — a losing (asset, side) streak means the
    // signal has been chronically wrong on that leg. Skip until the losing
    // trades roll out of the rolling window.
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

    // Multi-source validated price at open — the 2026-09-17 forensic showed
    // ETH trading blind at a 74-day-stale $2016.64 because single-source
    // getLivePrice never checked freshness. Multi-source median across
    // 3 providers with 2% deviation cap catches this. Fails hard on
    // insufficient sources or deviation; skip the trade rather than
    // guess.
    let markPrice = 0;
    try {
      // 8s timeout: crypto.com REST + MCP fetches can push 3-5s each in
      // Vercel serverless cold starts. 4s was too aggressive — every entry
      // timed out silently on 2026-09-17 post-deploy.
      const validated = await getMultiSourceValidatedPrice(asset, {
        minSources: 2,
        maxDeviationPercent: 2,
        timeout: 8000,
      });
      markPrice = validated.price;
    } catch (e) {
      const msg = errMsg(e);
      logger.warn('[PaperTrader] multi-source price failed at open', {
        asset,
        side,
        error: msg,
      });
      void notifyDiscord(
        `Paper SKIP ${asset} ${side} — price validation failed: ${msg}`,
        'WARN',
        { source: 'paper-trader', asset, error: msg },
      ).catch(() => undefined);
      return { action: 'skipped', reason: `price validation failed: ${msg.slice(0, 80)}`, nav };
    }
    if (!markPrice || markPrice <= 0) {
      return { action: 'skipped', reason: 'no mark price after validation', nav };
    }

    // Sizing: base stake × confidence-scalar × per-asset vol multiplier.
    // The confidence scalar weights strong signals bigger and weak signals
    // smaller; the vol multiplier stops SOL from carrying 2× BTC risk at
    // equal notional (SOL vol ~2× BTC vol in normal markets).
    const conf = scan.best.prediction.confidence ?? 0;
    const cons = (scan.best.prediction as { consensus?: number }).consensus ?? 0;
    const signalScalar = computeSignalScalar(conf, cons);
    const volMult = PAPER_ASSET_VOL_MULT[asset] ?? 1.0;
    const stakeUsd = nav * PAPER_STAKE_PCT * signalScalar * volMult;
    const notionalUsd = stakeUsd * PAPER_LEVERAGE;
    if (notionalUsd < 1) {
      return { action: 'skipped', reason: `notional too small ($${notionalUsd.toFixed(2)})`, nav };
    }

    // Snapshot the source list at open so we can score each source against
    // the actual price move at close. Store normalized keys so rolling-
    // title markets (Polymarket / Delphi 5-min) accumulate in one bucket.
    const rawSources = scan.best.prediction.sources ?? [];
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
    };

    const orderId = `paper_${asset}_${Math.floor(now / 1000)}`;
    await setCronState(KEY_POSITION, position);
    await setCronState(KEY_ORDER_ID, orderId);

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
        reason: `paper: ${rec} conf=${scan.best.prediction.confidence.toFixed(0)} score=${scan.best.score.toFixed(1)}`,
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
      score: scan.best.score.toFixed(1),
      signalScalar: signalScalar.toFixed(2),
      volMult: volMult.toFixed(2),
    });

    void notifyDiscord(
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

    await setCronState(KEY_POSITION, null);
    const orderId = await getCronState<string>(KEY_ORDER_ID);
    await setCronState(KEY_ORDER_ID, null);
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
        // Treasury credit — kept as separate call (fire-and-forget, non-blocking).
        // Guard mirrors closeHedge's own guard: only credit meaningful amounts.
        if (Math.abs(result.realizedPnlUsd) > 0.01) {
          try {
            const { recordPnlCredit } = await import('@/lib/db/treasury');
            await recordPnlCredit(orderId, result.realizedPnlUsd, `paperClose ${reason.slice(0, 60)}`);
          } catch (err) {
            logger.warn('[PaperTrader] treasury credit failed after close (non-fatal)', {
              orderId,
              error: err instanceof Error ? err.message : err,
            });
          }
        }
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
    const level = result.realizedPnlUsd >= 0 ? 'TRADE' : 'WARN';
    void notifyDiscord(
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
    ).catch(() => undefined);

    return { action: 'closed', reason, detail: result, nav: newNav };
  }
}
