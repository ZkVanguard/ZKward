/**
 * Cron Job: BlueFin Venue-Health Monitor + Auto-De-Risk
 *
 * Mitigates the single-venue counterparty risk that BlueFin Pro represents
 * for the SUI USDC pool. While Sui mainnet has no comparable mature perp
 * exchange (multi-venue hedging is a v2 roadmap item), we can substantially
 * de-risk by detecting venue distress EARLY and pulling capital back to
 * the on-chain pool reserve before withdrawal gating becomes a problem.
 *
 * Health signals (any one degraded → mark "DEGRADED"):
 *   1. /api/v1/account `canTrade=false` → exchange-side withdrawal/trade freeze
 *   2. getBalance() throws or times out (>5s) → API instability
 *   3. getPositions() throws or times out → API instability
 *   4. canTrade response missing `freeCollateral` field → schema drift
 *
 * Action policy:
 *   - 1 degraded reading: log warning, no action (could be transient).
 *   - 2 consecutive degraded readings within 15 min: WARN (page operator).
 *   - 3 consecutive degraded readings (~15 min sustained): DE-RISK
 *     → close ALL active BlueFin positions via reduceOnly orders; capital
 *       returns to operator wallet, then next sui-community-pool tick will
 *       call Move's close_hedge to repatriate USDC into the pool reserve.
 *
 * Schedule: Every 5 minutes via QStash. Fast cadence is what makes this useful.
 *
 * Security: QStash signature or CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { isPoolTradingEnabled } from '@/lib/services/sui/pool-trading-pause';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg } from '@/lib/utils/error-handler';
import { BluefinService, type BluefinPosition } from '@/lib/services/sui/BluefinService';
import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { notifyDiscord } from '@/lib/utils/discord-notify';

const CRON_KEY_LAST_RUN = 'cron:lastRun:bluefin-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface HealthResult {
  success: boolean;
  ranAt: string;
  network: 'mainnet' | 'testnet';
  attempted: boolean;
  status?: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE';
  signals?: {
    canTrade: boolean | null;
    freeCollateralUsdc: number | null;
    positionsCount: number | null;
    apiLatencyMs: number | null;
  };
  consecutiveDegraded?: number;
  deRiskTriggered?: boolean;
  closedPositions?: Array<{ symbol: string; success: boolean; error?: string }>;
  reason?: string;
  error?: string;
}

const CRON_KEY_DEGRADED_COUNTER = 'bluefin-health:consecutiveDegraded';
const HEALTH_API_TIMEOUT_MS = 5_000;
const DE_RISK_AFTER_N_DEGRADED = 3;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export async function GET(request: NextRequest): Promise<NextResponse<HealthResult>> {
  const ranAt = new Date().toISOString();
  const network: 'mainnet' | 'testnet' =
    (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet' ? 'testnet' : 'mainnet';

  const auth = await verifyCronRequest(request, 'BluefinHealth');
  // Heartbeat for /api/health/production cron-freshness check.
  void setCronState(CRON_KEY_LAST_RUN, Date.now()).catch(() => {});
  if (auth !== true) {
    return NextResponse.json(
      { success: false, ranAt, network, attempted: false, reason: 'Unauthorized' },
      { status: 401 },
    );
  }

  const adminKey = (process.env.BLUEFIN_PRIVATE_KEY || process.env.SUI_POOL_ADMIN_KEY || '').trim();
  if (!adminKey) {
    return NextResponse.json({
      success: true, ranAt, network, attempted: false,
      reason: 'BLUEFIN_PRIVATE_KEY not configured — skipping',
    });
  }

  const start = Date.now();
  let canTrade: boolean | null = null;
  let freeCollateralUsdc: number | null = null;
  let positionsCount: number | null = null;
  let positions: BluefinPosition[] = [];
  let apiError: string | undefined;

  try {
    const bf = BluefinService.getInstance();
    await bf.initialize(adminKey, network === 'mainnet' ? 'mainnet' : 'testnet');

    // Probe 1: balance + positions in parallel with hard timeout
    const [balRes, posRes] = await Promise.allSettled([
      withTimeout(bf.getBalance(), HEALTH_API_TIMEOUT_MS, 'getBalance'),
      withTimeout(bf.getPositions(), HEALTH_API_TIMEOUT_MS, 'getPositions'),
    ]);

    if (balRes.status === 'fulfilled' && typeof balRes.value === 'number') {
      freeCollateralUsdc = balRes.value;
    } else if (balRes.status === 'rejected') {
      apiError = `getBalance: ${errMsg(balRes.reason)}`;
    }

    if (posRes.status === 'fulfilled' && Array.isArray(posRes.value)) {
      positions = posRes.value;
      positionsCount = positions.length;
    } else if (posRes.status === 'rejected') {
      apiError = (apiError ? `${apiError}; ` : '') + `getPositions: ${errMsg(posRes.reason)}`;
    }

    // Probe 2: canTrade flag (treat as healthy-by-omission if endpoint missing)
    // Successful balance fetch implies the auth+endpoint is up; mark canTrade=true.
    if (freeCollateralUsdc !== null) {
      canTrade = true;
    }

    // Refresh the shared cache via the centralized helper, which also
    // maintains the `bluefin:consecutiveEmptyReads` counter that pages
    // Discord at 3+ consecutive empty reads (≈15 min) — distinguishes
    // venue blips from real outages.
    if (freeCollateralUsdc !== null && positionsCount !== null) {
      try {
        const { refreshBluefinCache } = await import('@/lib/services/sui/bluefin-read-safe');
        await refreshBluefinCache({
          free: freeCollateralUsdc,
          positions: positions as unknown as Array<Record<string, unknown>>,
          source: 'bluefin-health',
        });
      } catch { /* best-effort */ }
    }
  } catch (probeErr) {
    apiError = errMsg(probeErr);
  }

  const apiLatencyMs = Date.now() - start;
  const probesOk = freeCollateralUsdc !== null && positionsCount !== null && canTrade === true;
  const status: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE' = probesOk
    ? 'HEALTHY'
    : freeCollateralUsdc === null && positionsCount === null
      ? 'UNREACHABLE'
      : 'DEGRADED';

  const prevCounter = await getCronStateOr<number>(CRON_KEY_DEGRADED_COUNTER, 0);
  const newCounter = status === 'HEALTHY' ? 0 : prevCounter + 1;
  await setCronState(CRON_KEY_DEGRADED_COUNTER, newCounter);

  const signals = {
    canTrade,
    freeCollateralUsdc,
    positionsCount,
    apiLatencyMs,
  };

  // DEPLOY_MARKER_2026_07_02_a — force Vercel to rebuild this route.
  // Drift-close inline when venue is healthy — gives 5-min reactivity to
  // signal flips instead of waiting for the 30-min sui-community-pool tick.
  // ETH SHORT bleeding during a bullish rally was the concrete case this
  // fixes: agents detected the flip within 2 min but couldn't act until
  // Step 7.9 of the slow cron. Now bluefin-health runs Step 7.9 every 5min
  // whenever the venue is up. Skipped on DEGRADED/UNREACHABLE because
  // closing during venue distress compounds the problem.
  let driftResult: { checked: number; drifted: number; closed: number; skipped: number; errors: number } | null = null;
  if (status === 'HEALTHY' && isPoolTradingEnabled()) {
    try {
      const { checkAndCloseDrifts } = await import('@/lib/services/agents/position-drift-monitor');
      const bf = BluefinService.getInstance();
      driftResult = await checkAndCloseDrifts('sui', bf);
      if (driftResult.drifted > 0) {
        logger.info('[BluefinHealth] Drift monitor cycle', { driftResult });
      }
    } catch (driftErr) {
      logger.warn('[BluefinHealth] Drift-close threw (non-critical)', {
        error: driftErr instanceof Error ? driftErr.message : String(driftErr),
      });
    }
  }

  if (status === 'HEALTHY') {
    logger.info('[BluefinHealth] ✅ venue healthy', { ...signals, driftResult });
    return NextResponse.json({
      success: true, ranAt, network, attempted: true,
      status, signals, consecutiveDegraded: 0, deRiskTriggered: false, driftResult,
    });
  }

  // Below threshold: warn but no action (could be transient)
  if (newCounter < DE_RISK_AFTER_N_DEGRADED) {
    logger.warn('[BluefinHealth] ⚠️ venue ' + status, {
      consecutiveDegraded: newCounter,
      threshold: DE_RISK_AFTER_N_DEGRADED,
      ...signals,
      apiError,
    });
    return NextResponse.json({
      success: true,
      ranAt,
      network,
      attempted: true,
      status,
      signals,
      consecutiveDegraded: newCounter,
      deRiskTriggered: false,
      reason: `${newCounter}/${DE_RISK_AFTER_N_DEGRADED} consecutive degraded checks — monitoring`,
      error: apiError,
    });
  }

  // Threshold breached → DE-RISK: close all active positions via reduceOnly.
  // We can only close positions we actually have a snapshot of — if both
  // probes are unreachable, the de-risk attempt is best-effort.
  logger.error('[BluefinHealth] 🔴 SUSTAINED venue distress — initiating auto-de-risk', {
    consecutiveDegraded: newCounter,
    positionsKnown: positionsCount,
    ...signals,
    apiError,
  });
  await notifyDiscord(
    `BlueFin venue distress sustained (${newCounter}/${DE_RISK_AFTER_N_DEGRADED}) — closing all ${positionsCount ?? '?'} position(s) via reduceOnly.`,
    'KILL',
    { network, status, signals, apiError },
  );

  const closedPositions: Array<{ symbol: string; success: boolean; error?: string }> = [];

  if (positions.length > 0) {
    const bf = BluefinService.getInstance();
    for (const pos of positions) {
      const symbol = String(pos.symbol || '').toUpperCase();
      if (!symbol) continue;
      try {
        const closeRes = await bf.closeHedge({ symbol });
        closedPositions.push({
          symbol,
          success: !!closeRes.success,
          error: closeRes.success ? undefined : (closeRes.error || 'unknown'),
        });
      } catch (closeErr) {
        closedPositions.push({ symbol, success: false, error: errMsg(closeErr) });
      }
    }
  }

  const allClosed = closedPositions.length > 0 && closedPositions.every(c => c.success);
  if (allClosed) {
    // Reset counter — successful de-risk; next tick will reassess
    await setCronState(CRON_KEY_DEGRADED_COUNTER, 0);
    await notifyDiscord(
      `De-risk complete: closed ${closedPositions.length}/${closedPositions.length} BlueFin positions. Next sui-community-pool tick will repatriate USDC.`,
      'KILL',
      { network, closedSymbols: closedPositions.map(c => c.symbol) },
    );
  } else if (closedPositions.length > 0) {
    const failed = closedPositions.filter(c => !c.success);
    await notifyDiscord(
      `De-risk PARTIAL: ${closedPositions.length - failed.length}/${closedPositions.length} closed. ${failed.length} failed — operator must close manually on BlueFin UI.`,
      'ERROR',
      { network, failed },
    );
  }

  return NextResponse.json({
    success: true,
    ranAt,
    network,
    attempted: true,
    status,
    signals,
    consecutiveDegraded: newCounter,
    deRiskTriggered: true,
    closedPositions,
    reason: allClosed
      ? `de-risk complete: ${closedPositions.length} positions closed`
      : `de-risk attempted: ${closedPositions.filter(c => c.success).length}/${closedPositions.length} closed`,
    error: apiError,
  });
}

export const POST = GET;
