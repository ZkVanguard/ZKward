/**
 * QStash Cron Job: Master Orchestrator (SOLE QStash schedule as of 2026-09-12)
 *
 * Fires every 5 minutes via QStash → fans out to all sub-cron routes in
 * parallel. Each sub-cron internally gates cadence via tryClaimCronRun,
 * so a 15-min job that gets pinged every 5 min just no-ops until its
 * interval elapses.
 *
 * Why: QStash free tier is 1000 messages/day. 10 individual schedules were
 * consuming ~1800/day and hit the ceiling, silently stopping all crons.
 * Consolidating to ONE schedule → 288 messages/day, well under the limit.
 *
 * Trade-off vs 10 schedules:
 *   - Lost per-cron QStash retries (QStash retries the master, not individual
 *     sub-crons). Mitigated by each sub-cron's own internal tryClaimCronRun.
 *   - Single point of failure — if master times out (>300s Vercel cap), all
 *     sub-crons miss. Mitigated by parallel exec + per-sub-cron timeouts.
 *
 * Security: Verified by QStash signature or CRON_SECRET for internal calls
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg, errName } from '@/lib/utils/error-handler';

export const runtime = 'nodejs';

interface SubCronResult {
  name: string;
  success: boolean;
  duration: number;
  data?: Record<string, unknown>;
  error?: string;
}

interface MasterCronResult {
  success: boolean;
  ranAt: string;
  totalDuration: number;
  subTasks: SubCronResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };
}

/**
 * Base URL for sub-cron fetches. MUST be the production alias, NOT
 * VERCEL_URL — deployment URLs (foo-abc123.vercel.app) have deployment
 * protection enabled by default and require Vercel SSO, so an internal
 * fetch against them returns 401 regardless of CRON_SECRET.
 *
 * Override with CRON_SUB_BASE_URL for staging / preview environments.
 */
function subCronBaseUrl(): string {
  const override = process.env.CRON_SUB_BASE_URL?.trim();
  if (override) return override;
  if (process.env.VERCEL) return 'https://www.zkward.com';
  return process.env.NEXTAUTH_URL || 'http://localhost:3000';
}

/**
 * Call a sub-cron endpoint and capture result. Each sub-cron has its own
 * timeout — a hang in one doesn't block the rest.
 */
async function runSubCron(name: string, path: string, cronSecret: string, timeoutMs = 25_000): Promise<SubCronResult> {
  const start = Date.now();
  const url = `${subCronBaseUrl()}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cronSecret}`,
      },
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({ status: response.status }));
    const duration = Date.now() - start;

    if (response.ok) {
      return { name, success: true, duration, data };
    } else {
      logger.warn(`[MasterCron] ${name} returned ${response.status} in ${duration}ms`);
      return { name, success: false, duration, error: `HTTP ${response.status}`, data };
    }
  } catch (error: unknown) {
    const duration = Date.now() - start;
    const errorMsg = errName(error) === 'AbortError' ? `Timeout (${timeoutMs}ms)` : errMsg(error);
    logger.error(`[MasterCron] ${name} failed in ${duration}ms: ${errorMsg}`);
    return { name, success: false, duration, error: errorMsg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET handler — Vercel Cron entry point
 * Runs all sub-crons sequentially to stay within execution limits
 */
export async function GET(request: NextRequest): Promise<NextResponse<MasterCronResult>> {
  const startTime = Date.now();
  const ranAt = new Date().toISOString();
  
  // Security: Verify QStash signature or CRON_SECRET
  const authResult = await verifyCronRequest(request, 'MasterCron');
  if (authResult !== true) {
    return NextResponse.json(
      { 
        success: false, 
        ranAt, 
        totalDuration: Date.now() - startTime,
        subTasks: [], 
        summary: { total: 0, succeeded: 0, failed: 0 } 
      },
      { status: 401 }
    );
  }
  const cronSecret = process.env.CRON_SECRET?.trim() || '';
  
  logger.info('[MasterCron] Starting master cron orchestration');

  const cronJobs: Array<{ name: string; path: string; timeoutMs?: number }> = [
    { name: 'BlueFin Health',           path: '/api/cron/bluefin-health' },
    { name: 'Polymarket Edge Trader',   path: '/api/cron/polymarket-edge-trader' },
    { name: 'Liquidation Guard',        path: '/api/cron/liquidation-guard' },
    { name: 'Agent Signal Tick',        path: '/api/cron/agent-signal-tick' },
    { name: 'Pool NAV Monitor',         path: '/api/cron/pool-nav-monitor' },
    { name: 'BlueFin DB Reconcile',     path: '/api/cron/bluefin-db-reconcile' },
    { name: 'Alert Response Loop',      path: '/api/cron/alert-response-loop' },
    { name: 'SUI Community Pool',       path: '/api/cron/sui-community-pool', timeoutMs: 60_000 },
    { name: 'SUI Hedge Reconcile',      path: '/api/cron/sui-hedge-reconcile' },
    { name: 'SUI Collect Fees',         path: '/api/cron/sui-collect-fees' },
    // Watchdog for THIS orchestrator — if master itself stops firing, no cron
    // updates its heartbeat, heartbeat-monitor detects the stale-cron gap and
    // fires a Discord KILL. Added 2026-09-20 during the recovery from the
    // 24h jobs.zkward.com HMAC-secret-mismatch outage.
    { name: 'Heartbeat Monitor',        path: '/api/cron/heartbeat-monitor', timeoutMs: 15_000 },
  ];

  // Fire-and-forget: return 202 immediately so the scheduler (jobs.zkward.com)
  // gets an ack well within its per-delivery HTTP timeout. Sub-crons run in
  // the Fluid Compute background via `after()`, which keeps the function
  // alive up to maxDuration=300s after the response is flushed.
  //
  // Previously master awaited all sub-crons before responding — a 60s wait
  // caused jobs.zkward.com to time out every delivery and retry to
  // exhaustion (2026-09-19 obs: 4/8 attempts pending on a single delivery).
  after(async () => {
    const bgStart = Date.now();
    logger.info(`[MasterCron:bg] fanning out to ${cronJobs.length} sub-crons in parallel`);
    const results = await Promise.allSettled(
      cronJobs.map((job) => runSubCron(job.name, job.path, cronSecret || '', job.timeoutMs)),
    );
    const subTasks: SubCronResult[] = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { name: cronJobs[i].name, success: false, duration: 0, error: errMsg(r.reason) },
    );
    const succeeded = subTasks.filter(t => t.success).length;
    const failed = subTasks.filter(t => !t.success).length;
    logger.info(`[MasterCron:bg] complete: ${succeeded}/${subTasks.length} in ${Date.now() - bgStart}ms`);
    if (failed > 0) {
      logger.warn('[MasterCron:bg] failures', {
        failures: subTasks.filter(t => !t.success).map(t => ({ name: t.name, error: t.error })),
      });
    }
  });

  return NextResponse.json({
    success: true,
    ranAt,
    totalDuration: Date.now() - startTime,
    subTasks: [],
    summary: {
      total: cronJobs.length,
      succeeded: 0,
      failed: 0,
    },
  }, { status: 202 });
}

// QStash sends POST, Vercel cron sends GET — support both
export const POST = GET;

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes — enough for all sub-tasks
