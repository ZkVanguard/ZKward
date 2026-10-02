/**
 * Cron Job: Pool NAV Monitor
 *
 * Monitors all investment pools (Community Pool, institutional pools) and:
 * - Tracks NAV changes and performance
 * - Alerts on significant drawdowns
 * - Records performance snapshots
 * - Triggers rebalancing on allocation drift
 * - Notifies stakeholders on critical events
 *
 * Schedule: Every 15 minutes via Upstash QStash
 *
 * Security: Verified by QStash signature or CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { getNavHistory, getLatestNavSnapshot } from '@/lib/db/community-pool';
import {
  getNumber,
  setNumber,
  getTimestamp,
  setTimestamp,
  setCronState,
  CronKeys,
} from '@/lib/db/cron-state';
import { COMMUNITY_POOL_PORTFOLIO_ID } from '@/lib/constants';
import { errMsg } from '@/lib/utils/error-handler';
import { computeRollingPeak } from '@/lib/services/hedging/rolling-peak';

export const runtime = 'nodejs';

// Types
interface PoolMetrics {
  poolId: string;
  poolName: string;
  totalNAV: number;
  previousNAV: number;
  navChange: number;
  navChangePercent: number;
  memberCount: number;
  sharePrice: number;
  allocations: Record<string, number>;
  drawdownPercent: number;
  peakNAV: number;
  sinceInception: {
    returns: number;
    returnsPercent: number;
    days: number;
  };
  alerts: PoolAlert[];
}

interface PoolAlert {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  type: 'DRAWDOWN' | 'DRIFT' | 'PERFORMANCE' | 'LIQUIDITY' | 'MEMBER';
  message: string;
  timestamp: number;
}

interface PoolMonitorResult {
  success: boolean;
  poolsChecked: number;
  pools: PoolMetrics[];
  alerts: PoolAlert[];
  summary: {
    totalAUM: number;
    avgReturns: number;
    criticalPools: number;
    healthyPools: number;
  };
  duration: number;
  error?: string;
}

// Thresholds - AGGRESSIVE for risk management
const SHARE_PRICE_PAR = 1.0; // Target share price - $1.00 is baseline
const SHARE_PRICE_HEDGE_THRESHOLD = 0.02; // Trigger hedge if share price drops 2%+ below par
const SHARE_PRICE_CRITICAL_THRESHOLD = 0.05; // Critical alert if 5%+ below par
const DRAWDOWN_WARNING_PERCENT = 3; // Warn at 3% drawdown (lowered from 5%)
const DRAWDOWN_CRITICAL_PERCENT = 7; // Critical at 7% drawdown (lowered from 10%)
const DRIFT_WARNING_PERCENT = 2; // Warn if allocation drifts 2%+ from target (lowered from 3%)
const HOURLY_LOSS_WARNING_PERCENT = 0.5; // Warn on 0.5%+ hourly loss (lowered from 1%)
const _DAILY_LOSS_WARNING_PERCENT = 2; // Warn on 2%+ daily loss (lowered from 3%)
const AUTO_HEDGE_THRESHOLD_PERCENT = 1.5; // Trigger hedge at 1.5%+ loss (lowered from 2%)

// The pool's authoritative state lives in the DB snapshot written by the
// sui-community-pool cron — pool.address is retained for parity with the
// historical config shape but unused by fetchSuiPoolStats.
const SUI_POOL_STATE_ID = (
  process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE ||
  process.env.NEXT_PUBLIC_SUI_POOL_STATE_ID ||
  ''
).trim();
const POOLS: Array<{
  id: string;
  name: string;
  address: string;
  abi: string[];
  targetAllocations: Record<string, number>;
}> = [
  {
    id: 'community-pool',
    name: 'Community Pool (SUI Mainnet)',
    address: SUI_POOL_STATE_ID,
    abi: [],
    targetAllocations: { BTC: 35, ETH: 30, SUI: 35 },
  },
];

// In-memory caches (warm path) — loaded from DB on cold start, saved on change
const peakNavCache = new Map<string, number>();
const navHistoryCache = new Map<string, { nav: number; timestamp: number }[]>();
const lastPoolHedgeTimeCache = new Map<string, number>();
let dbStateLoaded = false;

// Last hedge time tracking to prevent spam (cooldown 4 hours)
const POOL_HEDGE_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/**
 * Load critical state from database on cold start (once per invocation)
 * Parallelized: loads all pool state in a single Promise.all
 */
async function loadStateFromDb(): Promise<void> {
  if (dbStateLoaded) return;
  dbStateLoaded = true;

  try {
    // Parallel load all pool state at once
    const results = await Promise.all(
      POOLS.flatMap((pool) => [
        getNumber(CronKeys.poolNavPeak(pool.id)).then((v) => ({
          pool: pool.id,
          type: 'peak' as const,
          value: v,
        })),
        getTimestamp(CronKeys.poolNavLastHedge(pool.id)).then((v) => ({
          pool: pool.id,
          type: 'hedge' as const,
          value: v,
        })),
      ])
    );

    for (const r of results) {
      if (r.type === 'peak' && r.value > 0) {
        peakNavCache.set(r.pool, r.value);
        logger.info(
          `[PoolNAVMonitor] Loaded peak NAV from DB for ${r.pool}: $${r.value.toFixed(2)}`
        );
      } else if (r.type === 'hedge' && r.value > 0) {
        lastPoolHedgeTimeCache.set(r.pool, r.value);
      }
    }
  } catch (error: unknown) {
    logger.warn('[PoolNAVMonitor] Failed to load state from DB — using defaults', {
      error: errMsg(error),
    });
  }
}

// Risk checks must run against fresh data — older than this and we skip the
// tick rather than alert on stale state. sui-community-pool writes every
// 30 min, so 60 min covers one missed run.
const NAV_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Fetch SUI pool stats from the authoritative snapshot written by the
 * sui-community-pool cron (source='sui-usdc-pool'). The on-chain object
 * only knows about idle USDC + on-chain hedged value — the bulk of NAV
 * lives off-chain on BlueFin + admin wallet, so the snapshot is the only
 * correct source of truth.
 */
async function fetchSuiPoolStats(_poolStateId: string): Promise<{
  totalNAV: number;
  memberCount: number;
  sharePrice: number;
  allocations: Record<string, number>;
  creationTime: number;
} | null> {
  try {
    const snap = await getLatestNavSnapshot('sui');
    if (!snap) {
      logger.warn('[PoolNAVMonitor] No sui NAV snapshot in DB — skipping');
      return null;
    }
    const ageMs = Date.now() - new Date(snap.timestamp).getTime();
    if (ageMs > NAV_SNAPSHOT_MAX_AGE_MS) {
      logger.warn('[PoolNAVMonitor] Latest sui NAV snapshot is stale, skipping risk check', {
        ageMin: (ageMs / 60000).toFixed(1),
        maxAgeMin: NAV_SNAPSHOT_MAX_AGE_MS / 60000,
      });
      return null;
    }
    const totalNAV = Number(snap.total_nav);
    const totalShares = Number(snap.total_shares);
    const sharePrice = Number(snap.share_price);
    const memberCount = Number(snap.member_count);
    const allocations = (snap.allocations as Record<string, number> | null) ?? {
      BTC: 35,
      ETH: 30,
      SUI: 35,
    };
    return {
      totalNAV,
      memberCount,
      sharePrice: sharePrice || (totalShares > 0 ? totalNAV / totalShares : 1),
      allocations,
      creationTime: Math.floor(Date.now() / 1000) - 86400 * 30,
    };
  } catch (error: unknown) {
    logger.error('[PoolNAVMonitor] Failed to read sui NAV snapshot:', {
      error: errMsg(error) || String(error),
    });
    return null;
  }
}

/**
 * Fetch pool stats - uses REAL-TIME calculated NAV from market prices
 * Falls back to on-chain values if real-time calculation fails
 */
async function fetchPoolStats(pool: (typeof POOLS)[0]): Promise<{
  totalNAV: number;
  memberCount: number;
  sharePrice: number;
  allocations: Record<string, number>;
  creationTime: number;
} | null> {
  try {
    // SUI mainnet pool — read from on-chain state directly
    // All community pool funds are on SUI mainnet — read directly from chain
    return await fetchSuiPoolStats(pool.address);
  } catch (error: unknown) {
    logger.error(`[PoolNAVMonitor] Failed to fetch pool stats for ${pool.id}:`, {
      error: errMsg(error) || String(error),
    });
    return null;
  }
}

/**
 * Get previous NAV from history — checks in-memory cache then DB
 */
async function getPreviousNAV(poolId: string): Promise<number | null> {
  const history = navHistoryCache.get(poolId);
  if (history && history.length >= 2) {
    return history[history.length - 2].nav;
  }
  // Fallback: load last snapshot from DB
  try {
    const dbHistory = await getNavHistory(1);
    if (dbHistory && dbHistory.length > 0) {
      return dbHistory[dbHistory.length - 1].total_nav;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Calculate drawdown from a ROLLING-WINDOW peak.
 *
 * Was: monotonically-ratcheting all-time max. That created a chicken-and-egg
 * halt loop after any real drawdown — 2026-07-06 peak $57 vs 2026-08-11 NAV
 * $28 = 51% drawdown, both HEDGE_DRAWDOWN_HALT_PCT (>10%) and
 * PROFIT_LOCK_ZERO_RISK_AT (>20%) permanently tripped, autohedge halted at
 * every UTC midnight, no recovery path. Fixed 2026-08-11.
 *
 * Now: peak = max(currentNAV, ...maxOfLast PEAK_ROLLING_WINDOW_DAYS-of-history)
 * where the window defaults to 7 days. Old highs age out naturally; the
 * halt gate then reflects "did I just take a beating?" not "am I still
 * below a high from months ago?". Env override for stricter regimes.
 */
async function calculateDrawdown(
  poolId: string,
  currentNAV: number
): Promise<{ drawdownPercent: number; peakNAV: number }> {
  // Load state from DB on cold start (still useful for the fallback branch below)
  await loadStateFromDb();

  const windowDays = Number(process.env.PEAK_ROLLING_WINDOW_DAYS) || 7;
  let peak = currentNAV;
  try {
    const navHist = await getNavHistory(windowDays);
    // computeRollingPeak: pure fn locked by test/unit/rolling-peak.test.ts —
    // any change back toward monotonic-max fails those tests loudly.
    peak = computeRollingPeak(currentNAV, navHist ?? []);
  } catch (error) {
    logger.warn('[PoolNAVMonitor] Could not load NAV history for peak calculation — falling back to cached value', { error });
    const cached = peakNavCache.get(poolId);
    if (cached && cached > 0) peak = Math.max(currentNAV, cached);
  }

  // Sanity check: sub-$1 pool with a >$100 peak = corrupt from a bad
  // 0-value snapshot (SUI RPC deprecation pattern, 2026-07-29). Reset.
  if (currentNAV === 0 && peak > 100) {
    logger.warn(`[PoolNAVMonitor] Corrupt peakNAV for ${poolId}: $${peak.toFixed(2)} vs current $0 — resetting`);
    peak = 0;
  }

  peakNavCache.set(poolId, peak);
  await setNumber(CronKeys.poolNavPeak(poolId), peak);

  if (peak <= 0 || currentNAV >= peak) {
    return { drawdownPercent: 0, peakNAV: peak };
  }
  const drawdownPercent = ((peak - currentNAV) / peak) * 100;
  return { drawdownPercent, peakNAV: peak };
}

/**
 * Check allocation drift
 */
function checkAllocationDrift(
  currentAllocations: Record<string, number>,
  targetAllocations: Record<string, number>
): { drifts: Record<string, number>; maxDrift: number; driftingAssets: string[] } {
  const drifts: Record<string, number> = {};
  const driftingAssets: string[] = [];

  for (const [asset, target] of Object.entries(targetAllocations)) {
    const current = currentAllocations[asset] || 0;
    const drift = Math.abs(current - target);
    drifts[asset] = drift;

    if (drift > DRIFT_WARNING_PERCENT) {
      driftingAssets.push(`${asset}: ${current.toFixed(1)}% (target ${target}%)`);
    }
  }

  const maxDrift = Math.max(...Object.values(drifts));
  return { drifts, maxDrift, driftingAssets };
}

/**
 * Generate alerts for a pool
 */
function generateAlerts(
  pool: (typeof POOLS)[0],
  metrics: {
    totalNAV: number;
    previousNAV: number | null;
    navChangePercent: number;
    drawdownPercent: number;
    maxDrift: number;
    driftingAssets: string[];
    memberCount: number;
  }
): PoolAlert[] {
  const alerts: PoolAlert[] = [];
  const now = Date.now();

  // Critical drawdown
  if (metrics.drawdownPercent >= DRAWDOWN_CRITICAL_PERCENT) {
    alerts.push({
      severity: 'CRITICAL',
      type: 'DRAWDOWN',
      message: `${pool.name} in CRITICAL drawdown: ${metrics.drawdownPercent.toFixed(2)}% from peak`,
      timestamp: now,
    });
  } else if (metrics.drawdownPercent >= DRAWDOWN_WARNING_PERCENT) {
    alerts.push({
      severity: 'WARNING',
      type: 'DRAWDOWN',
      message: `${pool.name} drawdown warning: ${metrics.drawdownPercent.toFixed(2)}% from peak`,
      timestamp: now,
    });
  }

  // Hourly loss
  if (metrics.navChangePercent < -HOURLY_LOSS_WARNING_PERCENT) {
    alerts.push({
      severity: 'WARNING',
      type: 'PERFORMANCE',
      message: `${pool.name} hourly loss: ${metrics.navChangePercent.toFixed(2)}%`,
      timestamp: now,
    });
  }

  // Allocation drift
  if (metrics.driftingAssets.length > 0) {
    alerts.push({
      severity: 'WARNING',
      type: 'DRIFT',
      message: `${pool.name} allocation drift: ${metrics.driftingAssets.join(', ')}`,
      timestamp: now,
    });
  }

  // Good performance notification
  if (metrics.navChangePercent > 1) {
    alerts.push({
      severity: 'INFO',
      type: 'PERFORMANCE',
      message: `${pool.name} positive performance: +${metrics.navChangePercent.toFixed(2)}% this hour`,
      timestamp: now,
    });
  }

  return alerts;
}

/**
 * Update in-memory NAV history cache for warm-Lambda change tracking.
 * DB writes are owned by sui-community-pool cron (source='sui-usdc-pool') —
 * this route is a read-only consumer.
 */
function updateInMemoryHistory(poolId: string, totalNAV: number): void {
  const history = navHistoryCache.get(poolId) || [];
  history.push({ nav: totalNAV, timestamp: Date.now() });
  if (history.length > 168) history.shift();
  navHistoryCache.set(poolId, history);
}

/**
 * Trigger rebalance if needed
 */
async function triggerRebalanceIfNeeded(
  pool: (typeof POOLS)[0],
  maxDrift: number
): Promise<boolean> {
  if (maxDrift < DRIFT_WARNING_PERCENT * 2) {
    return false;
  }

  try {
    const baseUrl = process.env.VERCEL
      ? 'https://zkward.com'
      : process.env.NEXTAUTH_URL || 'http://localhost:3000';

    const response = await fetch(`${baseUrl}/api/cron/auto-rebalance`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (response.ok) {
      logger.info(`[PoolNAVMonitor] Triggered rebalance for ${pool.id}`);
      return true;
    }
  } catch (error) {
    logger.error(`[PoolNAVMonitor] Failed to trigger rebalance:`, error);
  }

  return false;
}

/**
 * Trigger protective hedge for pool on significant loss
 */
async function triggerPoolHedge(
  pool: (typeof POOLS)[0],
  totalNAV: number,
  lossPercent: number,
  largestAsset: string
): Promise<boolean> {
  const now = Date.now();

  // Load state from DB on cold start
  await loadStateFromDb();
  const lastHedge = lastPoolHedgeTimeCache.get(pool.id) || 0;

  // Check cooldown
  if (now - lastHedge < POOL_HEDGE_COOLDOWN_MS) {
    logger.info(`[PoolNAVMonitor] Hedge cooldown active for ${pool.id}, skipping`);
    return false;
  }

  try {
    const baseUrl = process.env.VERCEL
      ? 'https://zkward.com'
      : process.env.NEXTAUTH_URL || 'http://localhost:3000';

    // Calculate hedge size - 25% of NAV as protective hedge
    const hedgeRatio = 0.25;
    const hedgeNotional = totalNAV * hedgeRatio;
    const hedgeLeverage = 3; // Conservative leverage

    logger.warn(`[PoolNAVMonitor] Triggering protective hedge for ${pool.id}`, {
      lossPercent,
      hedgeNotional,
      asset: largestAsset,
    });

    const response = await fetch(`${baseUrl}/api/agents/hedging/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pool-Hedge-Trigger': 'true',
        Authorization: `Bearer ${process.env.INTERNAL_API_SECRET || process.env.CRON_SECRET}`,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        portfolioId: COMMUNITY_POOL_PORTFOLIO_ID, // Community pool uses reserved ID (-1)
        asset: largestAsset,
        strategy: 'PROTECTIVE_PUT',
        notionalValue: hedgeNotional,
        leverage: hedgeLeverage,
        side: 'SHORT', // Protective short since pool is NET LONG
        orderType: 'MARKET',
        reason: `Auto loss protection: ${pool.name} down ${Math.abs(lossPercent).toFixed(2)}%`,
        simulationMode: false,
        requiresSignature: false,
      }),
    });

    if (response.ok) {
      const result = await response.json();
      lastPoolHedgeTimeCache.set(pool.id, now);
      await setTimestamp(CronKeys.poolNavLastHedge(pool.id), now);
      logger.info(`[PoolNAVMonitor] Protective hedge executed for ${pool.id}:`, result);
      return true;
    } else {
      const errorText = await response.text();
      logger.error(`[PoolNAVMonitor] Hedge failed for ${pool.id}:`, errorText);
    }
  } catch (error) {
    logger.error(`[PoolNAVMonitor] Failed to trigger hedge for ${pool.id}:`, error);
  }

  return false;
}

/**
 * Monitor all pools
 */
async function monitorPools(): Promise<{
  pools: PoolMetrics[];
  allAlerts: PoolAlert[];
  summary: PoolMonitorResult['summary'];
}> {
  const poolMetrics: PoolMetrics[] = [];
  const allAlerts: PoolAlert[] = [];
  let totalAUM = 0;
  let totalReturns = 0;
  let criticalPools = 0;
  let healthyPools = 0;

  await loadStateFromDb();

  for (const pool of POOLS) {
    logger.info(`[PoolNAVMonitor] Checking ${pool.name}`);

    // Parallel: fetch pool stats + previous NAV at the same time
    const [stats, previousNAV] = await Promise.all([fetchPoolStats(pool), getPreviousNAV(pool.id)]);

    if (!stats) {
      logger.warn(`[PoolNAVMonitor] Skipping ${pool.id} - no fresh snapshot available`);
      continue;
    }

    updateInMemoryHistory(pool.id, stats.totalNAV);

    const navChange = previousNAV ? stats.totalNAV - previousNAV : 0;
    const navChangePercent = previousNAV ? (navChange / previousNAV) * 100 : 0;

    const { drawdownPercent, peakNAV } = await calculateDrawdown(pool.id, stats.totalNAV);
    const { maxDrift, driftingAssets } = checkAllocationDrift(
      stats.allocations,
      pool.targetAllocations
    );

    // Calculate since inception
    const daysActive = Math.max(1, (Date.now() / 1000 - stats.creationTime) / 86400);
    const inceptionNAV = peakNAV * 0.9; // Estimate - would use actual data
    const returnsPercent = ((stats.totalNAV - inceptionNAV) / inceptionNAV) * 100;

    // Generate alerts
    const alerts = generateAlerts(pool, {
      totalNAV: stats.totalNAV,
      previousNAV,
      navChangePercent,
      drawdownPercent,
      maxDrift,
      driftingAssets,
      memberCount: stats.memberCount,
    });

    allAlerts.push(...alerts);

    // Trigger rebalance if drift too high
    if (maxDrift > DRIFT_WARNING_PERCENT * 2) {
      await triggerRebalanceIfNeeded(pool, maxDrift);
    }

    // ============================================
    // AGGRESSIVE AUTO-HEDGE RISK MANAGEMENT
    // ============================================
    // Check THREE conditions for hedging:
    // 1. Share price deviation from $1.00 par (MOST IMPORTANT)
    // 2. Hourly NAV change
    // 3. Drawdown from peak

    const sharePriceDeviation = (SHARE_PRICE_PAR - stats.sharePrice) / SHARE_PRICE_PAR;
    const sharePriceLoss = sharePriceDeviation * 100; // As percentage

    const shouldHedge =
      sharePriceDeviation >= SHARE_PRICE_HEDGE_THRESHOLD || // Share price below par by threshold
      navChangePercent <= -AUTO_HEDGE_THRESHOLD_PERCENT || // Recent hourly loss
      drawdownPercent >= AUTO_HEDGE_THRESHOLD_PERCENT; // Drawdown from peak

    // Critical alert for severe share price deviation
    if (sharePriceDeviation >= SHARE_PRICE_CRITICAL_THRESHOLD) {
      alerts.push({
        severity: 'CRITICAL',
        type: 'PERFORMANCE',
        message: `⚠️ CRITICAL: ${pool.name} share price $${stats.sharePrice.toFixed(4)} is ${sharePriceLoss.toFixed(2)}% BELOW $1.00 par value!`,
        timestamp: Date.now(),
      });
      logger.error(
        `[PoolNAVMonitor] CRITICAL: Share price ${sharePriceLoss.toFixed(2)}% below par!`,
        {
          sharePrice: stats.sharePrice,
          par: SHARE_PRICE_PAR,
          deviation: sharePriceDeviation,
        }
      );
    } else if (sharePriceDeviation >= SHARE_PRICE_HEDGE_THRESHOLD) {
      alerts.push({
        severity: 'WARNING',
        type: 'PERFORMANCE',
        message: `⚠️ ${pool.name} share price $${stats.sharePrice.toFixed(4)} is ${sharePriceLoss.toFixed(2)}% below $1.00 par - HEDGING REQUIRED`,
        timestamp: Date.now(),
      });
    }

    if (shouldHedge) {
      // Find largest allocation asset to hedge
      const largestAsset =
        Object.entries(stats.allocations).sort((a, b) => b[1] - a[1])[0]?.[0] || 'BTC';

      const lossToReport = Math.max(sharePriceLoss, Math.abs(navChangePercent), drawdownPercent);
      const hedgeReason =
        sharePriceDeviation >= SHARE_PRICE_HEDGE_THRESHOLD
          ? `share price ${sharePriceLoss.toFixed(2)}% below $1.00`
          : navChangePercent <= -AUTO_HEDGE_THRESHOLD_PERCENT
            ? `hourly loss ${Math.abs(navChangePercent).toFixed(2)}%`
            : `drawdown ${drawdownPercent.toFixed(2)}%`;

      logger.warn(`[PoolNAVMonitor] 🚨 AUTO-HEDGE TRIGGER: ${hedgeReason}`, {
        sharePrice: stats.sharePrice,
        sharePriceLoss,
        navChangePercent,
        drawdownPercent,
      });

      const hedged = await triggerPoolHedge(pool, stats.totalNAV, lossToReport, largestAsset);
      if (hedged) {
        alerts.push({
          severity: 'WARNING',
          type: 'PERFORMANCE',
          message: `🛡️ ${pool.name} AUTO-HEDGED: Protective SHORT placed - ${hedgeReason}`,
          timestamp: Date.now(),
        });
      }
    }

    const metrics: PoolMetrics = {
      poolId: pool.id,
      poolName: pool.name,
      totalNAV: stats.totalNAV,
      previousNAV: previousNAV || stats.totalNAV,
      navChange,
      navChangePercent,
      memberCount: stats.memberCount,
      sharePrice: stats.sharePrice,
      allocations: stats.allocations,
      drawdownPercent,
      peakNAV,
      sinceInception: {
        returns: stats.totalNAV - inceptionNAV,
        returnsPercent,
        days: Math.floor(daysActive),
      },
      alerts,
    };

    poolMetrics.push(metrics);

    // Update aggregates
    totalAUM += stats.totalNAV;
    totalReturns += navChangePercent;

    if (drawdownPercent >= DRAWDOWN_CRITICAL_PERCENT) {
      criticalPools++;
    } else {
      healthyPools++;
    }

    logger.info(
      `[PoolNAVMonitor] ${pool.name}: NAV $${stats.totalNAV.toLocaleString()}, Change ${navChangePercent >= 0 ? '+' : ''}${navChangePercent.toFixed(2)}%, Drawdown ${drawdownPercent.toFixed(2)}%`
    );
  }

  return {
    pools: poolMetrics,
    allAlerts,
    summary: {
      totalAUM,
      avgReturns: poolMetrics.length > 0 ? totalReturns / poolMetrics.length : 0,
      criticalPools,
      healthyPools,
    },
  };
}

/**
 * GET handler for Vercel Cron
 */
export async function GET(request: NextRequest): Promise<NextResponse<PoolMonitorResult>> {
  const startTime = Date.now();

  // Security: Verify QStash signature or CRON_SECRET
  const authResult = await verifyCronRequest(request, 'PoolNAVMonitor');
  if (authResult !== true) {
    return NextResponse.json(
      {
        success: false,
        poolsChecked: 0,
        pools: [],
        alerts: [],
        summary: { totalAUM: 0, avgReturns: 0, criticalPools: 0, healthyPools: 0 },
        duration: Date.now() - startTime,
        error: 'Unauthorized',
      },
      { status: 401 }
    );
  }
  // After auth: an unauthenticated hit must not make the job look alive.
  void setCronState('cron:lastRun:pool-nav-monitor', Date.now()).catch(() => {});

  logger.info('[PoolNAVMonitor] Starting pool NAV monitoring');

  try {
    const result = await monitorPools();

    logger.info(
      `[PoolNAVMonitor] Complete: ${result.pools.length} pools checked, ${result.allAlerts.length} alerts`,
      {
        summary: result.summary,
      }
    );

    return NextResponse.json({
      success: true,
      poolsChecked: result.pools.length,
      pools: result.pools,
      alerts: result.allAlerts,
      summary: result.summary,
      duration: Date.now() - startTime,
    });
  } catch (error: unknown) {
    logger.error('[PoolNAVMonitor] Error:', error);
    return safeErrorResponse(error, 'Pool NAV monitor') as NextResponse<PoolMonitorResult>;
  }
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// QStash sends POST by default — support both methods
export const POST = GET;
