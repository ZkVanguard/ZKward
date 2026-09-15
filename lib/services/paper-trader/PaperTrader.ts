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
import { getLivePrice } from '@/lib/services/market-data/unified-price-provider';
import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { createHedge, closeHedge } from '@/lib/db/hedges';
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import {
  simulateOpen,
  simulateClose,
  markToMarket,
  type SimulatedPosition,
  type Side,
} from './simulated-executor';

// ── Config (env-tunable) ─────────────────────────────────────────────────
export const PAPER_UNIVERSE = (process.env.PAPER_TRADER_ASSETS || 'BTC,ETH,SOL,XRP,DOGE')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const PAPER_STARTING_NAV = Number(process.env.PAPER_TRADER_STARTING_NAV || 100_000);
export const PAPER_LEVERAGE = Number(process.env.PAPER_TRADER_LEVERAGE || 3);
export const PAPER_STAKE_PCT = Number(process.env.PAPER_TRADER_STAKE_PCT || 0.20);
export const PAPER_MAX_HOLD_MIN = Number(process.env.PAPER_TRADER_MAX_HOLD_MIN || 20);
export const PAPER_MIN_CONFIDENCE = Number(process.env.PAPER_TRADER_MIN_CONFIDENCE || 55);
export const PAPER_MIN_CONSENSUS = Number(process.env.PAPER_TRADER_MIN_CONSENSUS || 50);
export const PAPER_MIN_SOURCES = Number(process.env.PAPER_TRADER_MIN_SOURCES || 2);

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
    const markPrice = await getLivePrice(pos.asset);
    if (!markPrice || markPrice <= 0) {
      return { action: 'skipped', reason: 'no mark price', nav };
    }

    // 1. Max-hold expiry → close
    const holdMs = now - pos.openedAt;
    if (holdMs >= PAPER_MAX_HOLD_MIN * 60_000) {
      return PaperTrader.closeAtMark(pos, markPrice, nav, now, 'max-hold expired');
    }

    // 2. Signal-flip exit (mirrors #101 confidence gate)
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

    // 3. Otherwise hold. Report mark-to-market NAV for the chart.
    const mtm = markToMarket(pos, markPrice, now);
    const currentNav = nav + mtm.unrealizedPnlUsd;
    return {
      action: 'held',
      detail: { pos, markPrice, mtm },
      nav: currentNav,
    };
  }

  private static async handleEntry(nav: number, now: number): Promise<TickResult> {
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
    if (!scan.best) return { action: 'skipped', reason: 'no edge above gates', nav };

    const asset = scan.best.asset;
    const rec = scan.best.prediction.recommendation;
    const side = recommendationToSide(rec);
    if (!side) return { action: 'skipped', reason: 'non-directional signal', nav };

    const markPrice = await getLivePrice(asset);
    if (!markPrice || markPrice <= 0) {
      return { action: 'skipped', reason: 'no mark price', nav };
    }

    const stakeUsd = nav * PAPER_STAKE_PCT;
    const notionalUsd = stakeUsd * PAPER_LEVERAGE;
    if (notionalUsd < 1) {
      return { action: 'skipped', reason: `notional too small ($${notionalUsd.toFixed(2)})`, nav };
    }

    const position = simulateOpen(
      { asset, side, notionalUsd, leverage: PAPER_LEVERAGE, entryPrice: markPrice },
      now,
    );

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
    });

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

    await setCronState(KEY_POSITION, null);
    const orderId = await getCronState<string>(KEY_ORDER_ID);
    await setCronState(KEY_ORDER_ID, null);
    await setCronState(KEY_NAV, newNav);

    // Update stats
    const stats: PaperStats = (await getCronState<PaperStats>(KEY_STATS)) ?? {
      trades: 0,
      wins: 0,
      losses: 0,
      cumRealizedUsd: 0,
      peakNavUsd: PAPER_STARTING_NAV,
      lastRealizedUsd: 0,
    };
    stats.trades += 1;
    if (result.realizedPnlUsd > 0) stats.wins += 1;
    else stats.losses += 1;
    stats.cumRealizedUsd += result.realizedPnlUsd;
    stats.lastRealizedUsd = result.realizedPnlUsd;
    stats.peakNavUsd = Math.max(stats.peakNavUsd, newNav);
    await setCronState(KEY_STATS, stats);

    // Close DB row + persist funding + close reason
    if (orderId) {
      try {
        await closeHedge(orderId, result.realizedPnlUsd, 'closed');
        // Store funding separately for the dashboard's fee-vs-alpha breakdown
        await query(
          `UPDATE hedges SET funding_paid = $1, reason = COALESCE(reason,'') || ' | close: ' || $2
           WHERE order_id = $3`,
          [result.fundingUsd, reason.slice(0, 100), orderId],
        );
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

    return { action: 'closed', reason, detail: result, nav: newNav };
  }
}
