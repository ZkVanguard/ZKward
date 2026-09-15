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
  KEY_ORDER_ID,
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
    const [nav, activePos, activeOrderId, stats, series, lastRun] = await Promise.all([
      getCronState<number>(KEY_NAV),
      getCronState<SimulatedPosition>(KEY_POSITION),
      getCronState<string>(KEY_ORDER_ID),
      getCronState<PaperStats>(KEY_STATS),
      getCronState<Array<{ ts: number; nav: number }>>(KEY_NAV_SERIES),
      getCronState<number>(KEY_LAST_RUN),
    ]);

    const currentNavRealized = nav ?? PAPER_STARTING_NAV;

    // If a position is open, mark it to market so the dashboard shows a
    // live-ish NAV rather than the last-realized snapshot.
    let unrealizedNav = currentNavRealized;
    let activePosOut: any = null;
    if (activePos) {
      const markPrice = await getLivePrice(activePos.asset).catch(() => 0);
      if (markPrice > 0) {
        const mtm = markToMarket(activePos, markPrice, Date.now());
        unrealizedNav = currentNavRealized + mtm.unrealizedPnlUsd;
        activePosOut = {
          asset: activePos.asset,
          side: activePos.side,
          entryPrice: activePos.entryPrice,
          markPrice,
          notionalUsd: activePos.notionalUsd,
          leverage: activePos.leverage,
          openedAt: activePos.openedAt,
          holdSeconds: Math.round((Date.now() - activePos.openedAt) / 1000),
          unrealizedPnlUsd: mtm.unrealizedPnlUsd,
          fundingAccruedUsd: mtm.fundingAccruedUsd,
          orderId: activeOrderId,
        };
      } else {
        activePosOut = {
          asset: activePos.asset,
          side: activePos.side,
          entryPrice: activePos.entryPrice,
          markPrice: null,
          notionalUsd: activePos.notionalUsd,
          leverage: activePos.leverage,
          openedAt: activePos.openedAt,
          holdSeconds: Math.round((Date.now() - activePos.openedAt) / 1000),
          orderId: activeOrderId,
        };
      }
    }

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
    });
  } catch (e) {
    logger.error('[paper-trader/status] failed', { error: errMsg(e) });
    return NextResponse.json(
      { success: false, error: errMsg(e) },
      { status: 500 },
    );
  }
}
