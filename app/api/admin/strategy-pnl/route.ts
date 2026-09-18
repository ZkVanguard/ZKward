/**
 * Admin: Strategy PnL & Signal Validation
 *
 * Single endpoint to answer: "Is the trading pipeline actually profitable?"
 *
 * Combines hedge realised PnL, fees, funding, NAV trajectory, and Polymarket
 * signal win-rate so we can decide whether to keep the strategy on, tighten
 * it, or disable it.
 *
 * Auth: Bearer CRON_SECRET.
 *
 * GET /api/admin/strategy-pnl                → 7-day window
 * GET /api/admin/strategy-pnl?days=30        → 30-day window
 * GET /api/admin/strategy-pnl?source=...     → signal source filter
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/postgres';
import { getSignalStats } from '@/lib/db/signal-outcomes';
import { logger } from '@/lib/utils/logger';
import { HEDGES_REAL_ONLY_SQL } from '@/lib/db/hedges-scope';
import { verifyAdminBearer } from '@/lib/security/auth-middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorize(req: NextRequest): boolean {
  return verifyAdminBearer(req, ['CRON_SECRET']);
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') || 7)));
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const signalSource = url.searchParams.get('source') || 'polymarket-5min';

  // ── Hedge PnL ───────────────────────────────────────────────────────
  const hedgeAggregate = {
    total: 0,
    closed: 0,
    active: 0,
    realizedPnlUsd: 0,
    fundingPaidUsd: 0,
    feesPaidUsd: 0,
    grossNotionalUsd: 0,
    winners: 0,
    losers: 0,
    breakeven: 0,
    winRate: 0,
    avgRealizedPnl: 0,
    largestWinUsd: 0,
    largestLossUsd: 0,
  };

  let hedgeByAsset: Array<{
    asset: string;
    closed: number;
    realized: number;
    funding: number;
    winRate: number;
  }> = [];

  try {
    const rows = await query<{
      status: string;
      asset: string;
      realized_pnl: string | null;
      funding_paid: string | null;
      notional_value: string | null;
    }>(
      `SELECT status, asset, realized_pnl, funding_paid, notional_value
       FROM hedges
       WHERE ${HEDGES_REAL_ONLY_SQL}
         AND (created_at >= $1 OR closed_at >= $1)`,
      [sinceIso]
    );

    hedgeAggregate.total = rows.length;
    for (const r of rows) {
      const realized = Number(r.realized_pnl ?? 0);
      const funding = Number(r.funding_paid ?? 0);
      const notional = Number(r.notional_value ?? 0);
      hedgeAggregate.grossNotionalUsd += notional;
      hedgeAggregate.fundingPaidUsd += funding;
      if (r.status === 'active') {
        hedgeAggregate.active++;
        continue;
      }
      hedgeAggregate.closed++;
      hedgeAggregate.realizedPnlUsd += realized;
      if (realized > 0.01) hedgeAggregate.winners++;
      else if (realized < -0.01) hedgeAggregate.losers++;
      else hedgeAggregate.breakeven++;
      hedgeAggregate.largestWinUsd = Math.max(hedgeAggregate.largestWinUsd, realized);
      hedgeAggregate.largestLossUsd = Math.min(hedgeAggregate.largestLossUsd, realized);
    }
    if (hedgeAggregate.closed > 0) {
      hedgeAggregate.winRate = hedgeAggregate.winners / hedgeAggregate.closed;
      hedgeAggregate.avgRealizedPnl = hedgeAggregate.realizedPnlUsd / hedgeAggregate.closed;
    }

    // Per-asset breakdown
    const byAsset: Record<
      string,
      { closed: number; realized: number; funding: number; winners: number }
    > = {};
    for (const r of rows) {
      if (r.status === 'active') continue;
      const a = (r.asset || 'UNKNOWN').toUpperCase();
      byAsset[a] ??= { closed: 0, realized: 0, funding: 0, winners: 0 };
      byAsset[a].closed++;
      byAsset[a].realized += Number(r.realized_pnl ?? 0);
      byAsset[a].funding += Number(r.funding_paid ?? 0);
      if (Number(r.realized_pnl ?? 0) > 0.01) byAsset[a].winners++;
    }
    hedgeByAsset = Object.entries(byAsset)
      .map(([asset, b]) => ({
        asset,
        closed: b.closed,
        realized: Number(b.realized.toFixed(2)),
        funding: Number(b.funding.toFixed(2)),
        winRate: b.closed > 0 ? Number((b.winners / b.closed).toFixed(3)) : 0,
      }))
      .sort((x, y) => y.closed - x.closed);
  } catch (err) {
    logger.warn('[strategy-pnl] hedge aggregate failed', {
      error: err instanceof Error ? err.message : err,
    });
  }

  // ── NAV trajectory (share-price drift) ─────────────────────────────
  const nav = {
    firstSharePrice: 0,
    lastSharePrice: 0,
    deltaPct: 0,
    snapshots: 0,
    minSharePrice: 0,
    maxSharePrice: 0,
  };
  try {
    const navRows = await query<{
      share_price: string | null;
      created_at: string;
    }>(
      `SELECT share_price, created_at FROM community_pool_nav_history
       WHERE chain = 'sui' AND created_at >= $1
       ORDER BY created_at ASC`,
      [sinceIso]
    );
    if (navRows.length > 0) {
      nav.snapshots = navRows.length;
      const prices = navRows.map((r) => Number(r.share_price ?? 0)).filter((p) => p > 0);
      if (prices.length > 0) {
        nav.firstSharePrice = prices[0];
        nav.lastSharePrice = prices[prices.length - 1];
        nav.minSharePrice = Math.min(...prices);
        nav.maxSharePrice = Math.max(...prices);
        nav.deltaPct =
          nav.firstSharePrice > 0
            ? ((nav.lastSharePrice - nav.firstSharePrice) / nav.firstSharePrice) * 100
            : 0;
      }
    }
  } catch (err) {
    logger.warn('[strategy-pnl] NAV trajectory failed', {
      error: err instanceof Error ? err.message : err,
    });
  }

  // ── Signal accuracy ────────────────────────────────────────────────
  const signalStats = await getSignalStats(days, signalSource).catch(() => null);

  // ── Rough cost estimate ────────────────────────────────────────────
  // Friction-cost bound: assume 0.1% slippage per leg + 0.05% perp round-trip
  // on every closed hedge, plus funding actually paid.
  const estFrictionCost = hedgeAggregate.grossNotionalUsd * 0.0015 + hedgeAggregate.fundingPaidUsd;
  const netPnl = hedgeAggregate.realizedPnlUsd - hedgeAggregate.fundingPaidUsd;
  const profitability =
    hedgeAggregate.closed === 0
      ? 'NO_DATA'
      : netPnl > 0.5
        ? 'PROFITABLE'
        : netPnl > -0.5
          ? 'BREAK_EVEN'
          : 'LOSING';

  // ── Verdict / recommendation ───────────────────────────────────────
  const recommendations: string[] = [];
  if (hedgeAggregate.closed < 5) {
    recommendations.push(
      'Insufficient closed hedges — keep KILL_SWITCH on or run defensively until ≥20 closes accumulate.'
    );
  }
  if (signalStats && signalStats.resolved >= 20 && signalStats.winRate < 0.55) {
    recommendations.push(
      `Signal win-rate ${(signalStats.winRate * 100).toFixed(1)}% < 55% breakeven. Disable HEDGE_REQUIRE_PREDICTION_SIGNAL gate or set KILL_SWITCH.`
    );
  }
  if (signalStats && signalStats.resolved >= 20 && signalStats.winRate >= 0.58) {
    recommendations.push(
      `Signal win-rate ${(signalStats.winRate * 100).toFixed(1)}% — above breakeven. Safe to run.`
    );
  }
  if (hedgeAggregate.closed >= 10 && hedgeAggregate.winRate < 0.45) {
    recommendations.push(
      `Hedge win-rate ${(hedgeAggregate.winRate * 100).toFixed(1)}% < 45%. Strategy is likely losing — set KILL_SWITCH=true.`
    );
  }
  if (nav.deltaPct < -1) {
    recommendations.push(
      `Share price drifted ${nav.deltaPct.toFixed(2)}% in ${days}d. Drawdown brake should already be engaged.`
    );
  }

  return NextResponse.json({
    success: true,
    windowDays: days,
    sinceIso,
    profitability,
    netPnlUsd: Number(netPnl.toFixed(2)),
    hedge: {
      total: hedgeAggregate.total,
      closed: hedgeAggregate.closed,
      active: hedgeAggregate.active,
      realizedPnlUsd: Number(hedgeAggregate.realizedPnlUsd.toFixed(2)),
      fundingPaidUsd: Number(hedgeAggregate.fundingPaidUsd.toFixed(2)),
      grossNotionalUsd: Number(hedgeAggregate.grossNotionalUsd.toFixed(2)),
      winners: hedgeAggregate.winners,
      losers: hedgeAggregate.losers,
      breakeven: hedgeAggregate.breakeven,
      winRate: Number(hedgeAggregate.winRate.toFixed(3)),
      avgRealizedPnlUsd: Number(hedgeAggregate.avgRealizedPnl.toFixed(2)),
      largestWinUsd: Number(hedgeAggregate.largestWinUsd.toFixed(2)),
      largestLossUsd: Number(hedgeAggregate.largestLossUsd.toFixed(2)),
      estimatedFrictionUsd: Number(estFrictionCost.toFixed(2)),
      byAsset: hedgeByAsset,
    },
    nav: {
      firstSharePriceUsd: Number(nav.firstSharePrice.toFixed(6)),
      lastSharePriceUsd: Number(nav.lastSharePrice.toFixed(6)),
      deltaPct: Number(nav.deltaPct.toFixed(3)),
      minSharePriceUsd: Number(nav.minSharePrice.toFixed(6)),
      maxSharePriceUsd: Number(nav.maxSharePrice.toFixed(6)),
      snapshots: nav.snapshots,
    },
    signal: signalStats
      ? {
          source: signalSource,
          total: signalStats.total,
          resolved: signalStats.resolved,
          pending: signalStats.pending,
          correct: signalStats.correct,
          incorrect: signalStats.incorrect,
          winRate: Number(signalStats.winRate.toFixed(3)),
          avgConfidence: Number(signalStats.avgConfidence.toFixed(2)),
          byStrength: signalStats.byStrength,
        }
      : null,
    recommendations,
    note: 'Friction cost is a lower bound (slippage 0.1% × 1.5 legs + actual funding). Actual cost typically 1.5–2x this.',
  });
}
