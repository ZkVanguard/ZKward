/**
 * Cron Job: Proactive Health Monitor → Discord
 *
 * Hits /api/health/production every tick, compares overall status to the
 * previous tick's cached value, fires a Discord alert on any state
 * transition AND on sustained degradation. Without this, the operator
 * only discovers silent failures by polling the health endpoint manually.
 *
 * State transitions alerted:
 *   healthy   → degraded   WARN
 *   healthy   → down       KILL
 *   degraded  → down       KILL
 *   *         → healthy    INFO (recovery)
 *   degraded  →  degraded  re-alert every 60min while stuck (WARN)
 *   down      →  down      re-alert every 30min while stuck (KILL)
 *
 * Schedule: 10 min on QStash.
 * Security: QStash signature or CRON_SECRET via verifyCronRequest.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { getCronStateOr, setCronState } from '@/lib/db/cron-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CRON_KEY_LAST_RUN = 'cron:lastRun:health-monitor';
const CRON_KEY_LAST_STATUS = 'health-monitor:last-status';
const CRON_KEY_STUCK_SINCE = 'health-monitor:stuck-since';
const CRON_KEY_LAST_ALERT = 'health-monitor:last-alert-ms';

type OverallStatus = 'healthy' | 'degraded' | 'down';

interface HealthResponse {
  status: OverallStatus;
  components: Record<string, { status: 'ok' | 'warn' | 'down'; detail?: string; error?: string }>;
}

interface MonitorState {
  prevStatus: OverallStatus | null;
  newStatus: OverallStatus;
  transitioned: boolean;
  reAlerted: boolean;
  failingComponents: string[];
}

const PROD_URL = (process.env.PROD_URL || 'https://www.zkward.com').replace(/\/$/, '');
const RE_ALERT_DEGRADED_MS = 60 * 60 * 1000;   // every 60 min while degraded
const RE_ALERT_DOWN_MS = 30 * 60 * 1000;       // every 30 min while down

export async function GET(request: NextRequest) {
  const ranAt = new Date().toISOString();

  const auth = await verifyCronRequest(request, 'HealthMonitor');
  if (auth !== true) {
    return NextResponse.json({ success: false, ranAt, error: 'Unauthorized' }, { status: 401 });
  }
  // After auth: an unauthenticated hit must not make the job look alive.
  void setCronState(CRON_KEY_LAST_RUN, Date.now()).catch(() => {});

  try {
    // Fetch the health endpoint internally (no auth required — public probe).
    const res = await fetch(`${PROD_URL}/api/health/production`, {
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    const body = (await res.json()) as HealthResponse;
    const newStatus = body.status;

    const prevStatus = (await getCronStateOr<OverallStatus | null>(CRON_KEY_LAST_STATUS, null));
    const stuckSinceMs = await getCronStateOr<number>(CRON_KEY_STUCK_SINCE, 0);
    const lastAlertMs = await getCronStateOr<number>(CRON_KEY_LAST_ALERT, 0);
    const now = Date.now();

    const failingComponents = Object.entries(body.components || {})
      .filter(([, v]) => v.status !== 'ok')
      .map(([k, v]) => `${k}: ${v.detail || v.error || v.status}`);

    const state: MonitorState = {
      prevStatus,
      newStatus,
      transitioned: prevStatus !== newStatus,
      reAlerted: false,
      failingComponents,
    };

    // Decide alerting
    let alertLevel: 'INFO' | 'WARN' | 'KILL' | null = null;
    let alertMsg: string | null = null;
    let nextStuckSince = stuckSinceMs;
    let nextLastAlert = lastAlertMs;

    if (state.transitioned) {
      // State changed since last tick
      if (newStatus === 'healthy') {
        alertLevel = 'INFO';
        alertMsg = `Health RECOVERED → healthy (was ${prevStatus ?? 'unknown'}).`;
        nextStuckSince = 0;
        nextLastAlert = now;
      } else if (newStatus === 'degraded') {
        alertLevel = 'WARN';
        alertMsg = `Health degraded (was ${prevStatus ?? 'unknown'}). ${failingComponents.length} failing.`;
        nextStuckSince = now;
        nextLastAlert = now;
      } else if (newStatus === 'down') {
        alertLevel = 'KILL';
        alertMsg = `Health DOWN (was ${prevStatus ?? 'unknown'}). ${failingComponents.length} component(s) hard-failed.`;
        nextStuckSince = now;
        nextLastAlert = now;
      }
    } else if (newStatus !== 'healthy') {
      // No transition but still degraded/down — re-alert on interval
      const stuckMs = stuckSinceMs > 0 ? now - stuckSinceMs : 0;
      const sinceLastAlertMs = lastAlertMs > 0 ? now - lastAlertMs : Number.POSITIVE_INFINITY;
      const reAlertThreshold = newStatus === 'down' ? RE_ALERT_DOWN_MS : RE_ALERT_DEGRADED_MS;
      if (sinceLastAlertMs >= reAlertThreshold) {
        const stuckMinutes = (stuckMs / 60_000).toFixed(0);
        alertLevel = newStatus === 'down' ? 'KILL' : 'WARN';
        alertMsg = `Health ${newStatus.toUpperCase()} for ${stuckMinutes}min straight. ${failingComponents.length} failing.`;
        state.reAlerted = true;
        nextLastAlert = now;
      }
      if (stuckSinceMs === 0) nextStuckSince = now;
    } else {
      // Stayed healthy — clear stuck state
      nextStuckSince = 0;
    }

    if (alertLevel && alertMsg) {
      await notifyDiscord(alertMsg, alertLevel, {
        prevStatus,
        newStatus,
        failingComponents,
        prodUrl: PROD_URL,
      });
    }

    await Promise.all([
      setCronState(CRON_KEY_LAST_STATUS, newStatus).catch(() => {}),
      setCronState(CRON_KEY_STUCK_SINCE, nextStuckSince).catch(() => {}),
      setCronState(CRON_KEY_LAST_ALERT, nextLastAlert).catch(() => {}),
    ]);

    logger.info('[health-monitor] tick', {
      prevStatus, newStatus, transitioned: state.transitioned, reAlerted: state.reAlerted,
      failingComponentsCount: failingComponents.length, alertLevel,
    });

    return NextResponse.json({
      success: true, ranAt,
      prevStatus, newStatus,
      transitioned: state.transitioned, reAlerted: state.reAlerted,
      alertFired: alertLevel != null,
      failingComponents,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('[health-monitor] error', { error: msg });
    return NextResponse.json({ success: false, ranAt, error: msg }, { status: 500 });
  }
}

export const POST = GET;
