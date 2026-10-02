/**
 * GET /api/dashboard/autonomy-status
 *
 * Wallet-agnostic snapshot of the autonomy machinery for the dashboard's
 * "AI Agents" live panel. Aggregates:
 *   - cron heartbeats (last-run timestamps + freshness classification)
 *   - trader stats (win rate, PnL, dormancy streak, calibration state)
 *   - active hedges count (real, filtering operational micro-hedges)
 *   - alarm state (dust flags, starvation alarm, halts, profit-lock)
 *   - signal directives per asset
 *
 * Read-only, CDN-cacheable 30s (matches cron cadence — no point in
 * fresher). No secrets in the response. Safe to render for anonymous
 * visitors on the dashboard.
 */

import { NextResponse } from 'next/server';
import { getCronStateByPrefix, getCronStateOr } from '@/lib/db/cron-state';
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { isLiveJob, staleLimitMin } from '@/lib/services/alerting/cron-cadence';
import { getLiveAssetSignals, type LiveAssetSignal } from '@/lib/services/market-data/live-signals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface CronHeartbeat {
  name: string;
  lastRunMs: number;
  ageMinutes: number;
  status: 'fresh' | 'stale' | 'silent';
}

interface AutonomyStatus {
  fetchedAt: number;
  crons: CronHeartbeat[];
  trader: {
    trades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    totalPnlUsd: number;
    noEdgeStreakTicks: number;
    hoursDormant: number;
    lastSkipReason: string | null;
    activeTradeAsset: string | null;
  };
  hedges: {
    active: number;
    activeOnChainDust: number;
    closedLifetime: number;
    realizedPnlLifetime: number;
  };
  alarms: {
    dustFlags: number;
    starvationAlerted: boolean;
    haltsActive: number;
    profitLockActive: boolean;
  };
  signals: Record<string, { side: 'LONG' | 'SHORT' | null; confidence: number; reason: string }>;
}

export async function GET() {
  const startedAt = Date.now();
  try {
    // ── 1. Cron heartbeats ──
    const cronMap = await getCronStateByPrefix<number>('cron:lastRun:');
    // Scheduled jobs only: retired routes, claim markers and sub-task keys
    // also live under cron:lastRun:* and made "jobs healthy" read 20/23
    // forever. Staleness uses the heartbeat monitor's own per-job cadence.
    const crons: CronHeartbeat[] = Array.from(cronMap.entries())
      .map(([key, value]) => ({ name: key.replace('cron:lastRun:', ''), lastRunMs: Number(value) }))
      .filter(({ name }) => isLiveJob(name))
      .map(({ name, lastRunMs }) => {
        const ageMinutes = Math.round((Date.now() - lastRunMs) / 60_000);
        const limit = staleLimitMin(name);
        const status: CronHeartbeat['status'] =
          ageMinutes <= limit ? 'fresh' : ageMinutes <= limit * 6 ? 'stale' : 'silent';
        return { name, lastRunMs, ageMinutes, status };
      })
      .sort((a, b) => a.ageMinutes - b.ageMinutes);

    // ── 2. Trader stats ──
    interface TraderStats {
      trades?: number;
      wins?: number;
      losses?: number;
      totalPnlUsd?: number;
    }
    interface LastSkip {
      action?: string;
      reason?: string;
    }
    interface ActiveTrade {
      asset?: string;
    }
    const [stats, lastSkip, streak, active] = await Promise.all([
      getCronStateOr<TraderStats>('polymarket-edge:stats', {}),
      getCronStateOr<LastSkip | null>('polymarket-edge:last-skip', null),
      getCronStateOr<number>('polymarket-edge:noedge-streak', 0),
      getCronStateOr<ActiveTrade | null>('polymarket-edge:active-trade', null),
    ]);
    const trades = Number(stats.trades ?? 0);
    const wins = Number(stats.wins ?? 0);
    const losses = Number(stats.losses ?? 0);
    const totalPnlUsd = Number(stats.totalPnlUsd ?? 0);
    const noEdgeStreakTicks = Number(streak) || 0;

    // ── 3. Hedges — active + lifetime ──
    const [activeRows, closedRows] = await Promise.all([
      query<{ count: string; dust: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE notional_value >= 1)::text AS count,
           COUNT(*) FILTER (WHERE notional_value < 1)::text AS dust
         FROM hedges WHERE chain='sui' AND status='active'`,
      ),
      query<{ count: string; sum: string }>(
        `SELECT COUNT(*)::text AS count,
                COALESCE(SUM(realized_pnl), 0)::text AS sum
         FROM hedges WHERE chain='sui' AND status='closed'`,
      ),
    ]);

    // ── 4. Alarms ──
    const [dustMap, starvationFlag, haltMap, profitLockZeroSince] = await Promise.all([
      getCronStateByPrefix<number | boolean>('stale-dust-flag:'),
      getCronStateOr<number>('polymarket-edge:starvation-alert-flag', 0),
      getCronStateByPrefix<number>('cron:haltUntil:'),
      getCronStateOr<number | null>('profit-lock:zero-since', null),
    ]);
    const now = Date.now();
    const haltsActive = Array.from(haltMap.values()).filter((v) => Number(v) > now).length;
    const starvationAlerted =
      Number(starvationFlag) > 0 && now - Number(starvationFlag) < 24 * 60 * 60 * 1000;

    // ── 5. Signals per asset ──
    // Live from the aggregator — the same read the Risk view uses. The
    // stored agent directives this used to render were last written when
    // the lead cycle ran (2026-09-22) and were shown as live.
    const live = await getLiveAssetSignals().catch(() => ({} as Record<string, LiveAssetSignal>));
    const signals: AutonomyStatus['signals'] = {};
    for (const [asset, sig] of Object.entries(live)) {
      signals[asset] = {
        side: sig.direction === 'UP' ? 'LONG' : sig.direction === 'DOWN' ? 'SHORT' : null,
        confidence: sig.confidence,
        reason: sig.recommendation.slice(0, 80),
      };
    }

    const body: AutonomyStatus = {
      fetchedAt: startedAt,
      crons,
      trader: {
        trades,
        wins,
        losses,
        winRatePct: trades > 0 ? Math.round((wins / trades) * 100) : 0,
        totalPnlUsd,
        noEdgeStreakTicks,
        hoursDormant: Math.round((noEdgeStreakTicks * 5) / 60),
        lastSkipReason: lastSkip?.reason ? String(lastSkip.reason).slice(0, 140) : null,
        activeTradeAsset: active?.asset ?? null,
      },
      hedges: {
        active: Number(activeRows[0]?.count ?? 0),
        activeOnChainDust: Number(activeRows[0]?.dust ?? 0),
        closedLifetime: Number(closedRows[0]?.count ?? 0),
        realizedPnlLifetime: Number(closedRows[0]?.sum ?? 0),
      },
      alarms: {
        dustFlags: dustMap.size,
        starvationAlerted,
        haltsActive,
        profitLockActive: profitLockZeroSince != null,
      },
      signals,
    };

    return NextResponse.json(body, {
      headers: {
        // Same cadence as cron heartbeats — no reason to fetch fresher.
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch (e) {
    logger.warn('[autonomy-status] failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { error: 'autonomy status unavailable', fetchedAt: startedAt },
      { status: 500 },
    );
  }
}
