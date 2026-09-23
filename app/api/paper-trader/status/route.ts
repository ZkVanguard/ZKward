/**
 * Public paper-trader status endpoint.
 *
 * Serves the /paper dashboard: current NAV, cumulative PnL vs the $100k
 * buy-hold baseline, active position (if any), recent closed trades,
 * per-asset breakdown, live signal snapshot.
 *
 * No auth — this endpoint is the public proof of edge (or lack thereof).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronState } from '@/lib/db/cron-state';
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import {
  KEY_POSITION,
  KEY_NAV,
  KEY_STATS,
  KEY_NAV_SERIES,
  KEY_LAST_RUN,
  PAPER_STARTING_NAV,
  PAPER_UNIVERSE,
  PAPER_CHAIN,
  PAPER_PORTFOLIO_ID,
  type PaperStats,
} from '@/lib/services/paper-trader/PaperTrader';
import type { SimulatedPosition } from '@/lib/services/paper-trader/simulated-executor';
import { markToMarket } from '@/lib/services/paper-trader/simulated-executor';
import { getLivePrice } from '@/lib/services/market-data/unified-price-provider';
import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BanditArm {
  key: string;
  wins: number;
  trades: number;
  totalRewardPct: number;
  lastPulledAt: number;
}
interface SourceCal {
  n: number;
  wins: number;
}

/** Summarizes the learning subsystems for the dashboard paper-pool tab.
 *  All reads are cron_state fetches — cheap, no external calls. */
async function loadLearningSnapshot() {
  try {
    const bandit = (await getCronState<Record<string, BanditArm>>('paper-trader:bandit:arms')) ?? {};
    const arms = Object.values(bandit)
      .filter((a) => a && a.trades > 0)
      .map((a) => ({
        key: a.key,
        wins: a.wins,
        trades: a.trades,
        winPct: a.trades > 0 ? (a.wins / a.trades) * 100 : 0,
        avgRewardPct: a.trades > 0 ? (a.totalRewardPct / a.trades) * 100 : 0,
      }))
      .sort((a, b) => b.avgRewardPct - a.avgRewardPct);

    // Source calibrator entries under trader:source-cal:{key}. Load in one
    // query — the LIKE scan is bounded (~200 keys total across all sources).
    const rows = await query<{ key: string; value: SourceCal }>(
      `SELECT key, value FROM cron_state WHERE key LIKE 'trader:source-cal:%'`,
    );
    const sources = rows
      .map((r) => {
        const v = r.value as unknown as SourceCal;
        const n = Number(v?.n ?? 0);
        const wins = Number(v?.wins ?? 0);
        return {
          key: r.key.replace('trader:source-cal:', ''),
          obs: n,
          wins,
          hitPct: n > 0 ? (wins / n) * 100 : 0,
          killed: n >= 15 && wins / n < 0.4,
        };
      })
      .filter((s) => s.obs >= 5)
      .sort((a, b) => b.hitPct - a.hitPct);

    return {
      bandit: {
        armCount: arms.length,
        arms,
      },
      sources: {
        total: sources.length,
        killed: sources.filter((s) => s.killed).length,
        top: sources.slice(0, 10),
        bottom: [...sources].reverse().slice(0, 10),
      },
    };
  } catch (e) {
    logger.debug('[paper-trader/status] loadLearningSnapshot failed', { error: errMsg(e) });
    return { bandit: { armCount: 0, arms: [] }, sources: { total: 0, killed: 0, top: [], bottom: [] } };
  }
}

interface ClosedTradeRow {
  id: number;
  order_id: string;
  asset: string;
  side: string;
  notional_value: string;
  entry_price: string;
  realized_pnl: string;
  funding_paid: string;
  created_at: string;
  closed_at: string;
  reason: string;
}

interface PerAssetAgg {
  trades: number;
  wins: number;
  cumRealizedUsd: number;
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    // Load active positions via the same helper the trader uses so we
    // pick up concurrent-mode entries (array under KEY_POSITIONS) AND
    // the legacy single slot. Diagnosed 2026-09-18: this endpoint was
    // reading only KEY_POSITION; in concurrent mode that's null →
    // the /paper dashboard rendered "no active position" while
    // multiple positions were actually open.
    const { loadActivePositions } = await import('@/lib/services/paper-trader/concurrent');
    const [nav, activePositions, stats, series, lastRun] = await Promise.all([
      getCronState<number>(KEY_NAV),
      loadActivePositions(),
      getCronState<PaperStats>(KEY_STATS),
      getCronState<Array<{ ts: number; nav: number }>>(KEY_NAV_SERIES),
      getCronState<number>(KEY_LAST_RUN),
    ]);

    const currentNavRealized = nav ?? PAPER_STARTING_NAV;

    // Mark every active position to market so the dashboard shows a
    // live-ish NAV summing unrealized PnL across all open positions.
    let unrealizedNav = currentNavRealized;
    const activePositionsOut: any[] = [];
    for (const entry of activePositions) {
      const p = entry.position;
      const markPrice = await getLivePrice(p.asset).catch(() => 0);
      if (markPrice > 0) {
        const mtm = markToMarket(p, markPrice, Date.now());
        unrealizedNav += mtm.unrealizedPnlUsd;
        activePositionsOut.push({
          asset: p.asset,
          side: p.side,
          entryPrice: p.entryPrice,
          markPrice,
          notionalUsd: p.notionalUsd,
          leverage: p.leverage,
          openedAt: p.openedAt,
          holdSeconds: Math.round((Date.now() - p.openedAt) / 1000),
          unrealizedPnlUsd: mtm.unrealizedPnlUsd,
          fundingAccruedUsd: mtm.fundingAccruedUsd,
          orderId: entry.orderId,
        });
      } else {
        activePositionsOut.push({
          asset: p.asset,
          side: p.side,
          entryPrice: p.entryPrice,
          markPrice: null,
          notionalUsd: p.notionalUsd,
          leverage: p.leverage,
          openedAt: p.openedAt,
          holdSeconds: Math.round((Date.now() - p.openedAt) / 1000),
          orderId: entry.orderId,
        });
      }
    }
    // Back-compat: keep activePosition as the newest single entry so
    // existing UI code that reads .activePosition continues to work.
    const activePosOut = activePositionsOut[0] ?? null;

    // Recent closed trades
    let recent: ClosedTradeRow[] = [];
    try {
      const rows = await query<ClosedTradeRow>(
        `SELECT id, order_id, asset, side,
                notional_value::text as notional_value,
                entry_price::text as entry_price,
                realized_pnl::text as realized_pnl,
                COALESCE(funding_paid, 0)::text as funding_paid,
                created_at::text as created_at,
                closed_at::text as closed_at,
                COALESCE(reason, '') as reason
         FROM hedges
         WHERE chain = $1 AND status = 'closed'
         ORDER BY closed_at DESC
         LIMIT 20`,
        [PAPER_CHAIN],
      );
      recent = rows;
    } catch (e) {
      logger.warn('[paper-trader/status] recent trades query failed', { error: errMsg(e) });
    }

    // Per-asset breakdown
    const perAsset: Record<string, PerAssetAgg> = {};
    for (const r of recent) {
      const bucket = perAsset[r.asset] ?? { trades: 0, wins: 0, cumRealizedUsd: 0 };
      const rp = Number(r.realized_pnl);
      bucket.trades += 1;
      if (rp > 0) bucket.wins += 1;
      bucket.cumRealizedUsd += rp;
      perAsset[r.asset] = bucket;
    }

    // Live signals snapshot
    let signals: Record<string, { recommendation: string; confidence: number; sources: number }> = {};
    try {
      const preds = await PredictionAggregatorService.getPerAssetPredictions(PAPER_UNIVERSE);
      for (const [asset, p] of Object.entries(preds)) {
        signals[asset] = {
          recommendation: p.recommendation,
          confidence: Math.round(p.confidence),
          sources: p.sources.length,
        };
      }
    } catch (e) {
      logger.warn('[paper-trader/status] signals query failed', { error: errMsg(e) });
    }

    const s: PaperStats = stats ?? {
      trades: 0,
      wins: 0,
      losses: 0,
      cumRealizedUsd: 0,
      peakNavUsd: PAPER_STARTING_NAV,
      lastRealizedUsd: 0,
    };

    return NextResponse.json({
      success: true,
      generatedAt: new Date().toISOString(),
      lastTickAt: lastRun ? new Date(lastRun).toISOString() : null,
      config: {
        startingNavUsd: PAPER_STARTING_NAV,
        universe: PAPER_UNIVERSE,
        chain: PAPER_CHAIN,
        portfolioId: PAPER_PORTFOLIO_ID,
      },
      nav: {
        currentUsd: unrealizedNav,
        realizedUsd: currentNavRealized,
        peakUsd: s.peakNavUsd,
        startingUsd: PAPER_STARTING_NAV,
        cumReturnPct: ((unrealizedNav - PAPER_STARTING_NAV) / PAPER_STARTING_NAV) * 100,
        drawdownFromPeakPct:
          s.peakNavUsd > 0
            ? ((s.peakNavUsd - unrealizedNav) / s.peakNavUsd) * 100
            : 0,
      },
      stats: {
        trades: s.trades,
        wins: s.wins,
        losses: s.losses,
        winRatePct: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
        cumRealizedUsd: s.cumRealizedUsd,
        lastRealizedUsd: s.lastRealizedUsd,
      },
      activePosition: activePosOut,
      activePositions: activePositionsOut,
      recentTrades: recent.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        asset: r.asset,
        side: r.side,
        notionalUsd: Number(r.notional_value),
        entryPrice: Number(r.entry_price),
        realizedPnlUsd: Number(r.realized_pnl),
        fundingUsd: Number(r.funding_paid),
        openedAt: r.created_at,
        closedAt: r.closed_at,
        reason: r.reason,
      })),
      perAsset,
      signals,
      navSeries: series ?? [],
      learning: await loadLearningSnapshot(),
    });
  } catch (e) {
    logger.error('[paper-trader/status] failed', { error: errMsg(e) });
    return NextResponse.json(
      { success: false, error: errMsg(e) },
      { status: 500 },
    );
  }
}
