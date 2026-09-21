/**
 * Heartbeat monitor — cron that watches other crons.
 *
 * Reads every `cron:lastRun:*` key in cron_state and computes staleness
 * against a per-cron expected-cadence table. Any cron whose last-run
 * exceeds `expected × STALE_MULTIPLIER` fires a Discord KILL alert, so
 * we don't discover a dispatcher outage 24 hours later (as happened
 * 2026-09-19 → 2026-09-20: 11 core crons died at the same second when
 * jobs.zkward.com stopped dispatching, and we noticed via manual DB
 * query).
 *
 * Schedule this route from jobs.zkward.com every 5 min — same as every
 * other cron. jobs.zkward.com is the single cron platform; no external
 * SaaS (no QStash, no GitHub Actions). Trade-off accepted: if the jobs
 * service itself dies, this can't alert. `scripts/ping-crons.ts` is
 * the operator-run fallback for that case. Discord alert has a 30-min
 * re-alert throttle so a sustained stale-cron state doesn't flood.
 *
 * Security: CRON_SECRET Bearer or jobs.zkward.com HMAC.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { query } from '@/lib/db/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KEY_LAST_RUN = 'cron:lastRun:heartbeat-monitor';
const KEY_LAST_ALERT = 'heartbeat-monitor:last-alert-ms';

// Per-cron expected cadence in minutes. Anything > cadence × STALE_MULTIPLIER
// fires an alert. Add new crons here as they're added.
// Set to 0 to skip (known-dormant, don't alert).
const EXPECTED_CADENCE_MIN: Record<string, number> = {
  'agent-signal-tick':        2,
  'polymarket-edge-trader':   5,
  'bluefin-health':           5,
  'paper-trader':             5,   // piggybacks on polymarket-edge-trader
  'liquidation-guard':       10,
  'pool-nav-monitor':        15,
  'bluefin-db-reconcile':    15,
  'alert-response-loop':     15,
  'heartbeat-monitor':        5,   // watches itself
  'sui-community-pool':      30,
  'sui-hedge-reconcile':     60,
  'sui-collect-fees':      1440,   // daily
  'poly-discover':           60,   // best-guess; adjust when schedule confirmed
  // Known-dormant — don't alert:
  'hedge-monitor':            0,
  'health-monitor':           0,
  'lead-cycle':               0,
  'resolve-outcomes':         0,
};

const STALE_MULTIPLIER = 3;       // > 3× cadence = stale
const RE_ALERT_MS = 30 * 60_000;  // 30 min between repeat alerts

interface StaleCron {
  cron: string;
  expectedMin: number;
  lastRunAt: string;
  minsSinceLast: number;
}

async function collectStale(): Promise<StaleCron[]> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value::text AS value FROM cron_state WHERE key LIKE 'cron:lastRun:%'`,
  );
  const now = Date.now();
  const out: StaleCron[] = [];
  for (const row of rows) {
    const cron = row.key.replace('cron:lastRun:', '');
    const expected = EXPECTED_CADENCE_MIN[cron];
    if (!expected || expected <= 0) continue;    // unknown or dormant — skip
    const lastRunMs = Number(row.value);
    if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) continue;
    const minsSinceLast = (now - lastRunMs) / 60_000;
    if (minsSinceLast > expected * STALE_MULTIPLIER) {
      out.push({
        cron,
        expectedMin: expected,
        lastRunAt: new Date(lastRunMs).toISOString(),
        minsSinceLast: Math.round(minsSinceLast * 10) / 10,
      });
    }
  }
  return out;
}

export async function GET(request: NextRequest) {
  const authResult = await verifyCronRequest(request, 'heartbeat-monitor');
  if (authResult !== true) return authResult;

  const now = Date.now();
  try {
    await setCronState(KEY_LAST_RUN, now).catch(() => {});

    const stale = await collectStale();

    if (stale.length === 0) {
      logger.debug('[HeartbeatMonitor] all crons healthy');
      return NextResponse.json({ ok: true, stale: [] });
    }

    // Throttle repeat alerts.
    const lastAlert = (await getCronState<number>(KEY_LAST_ALERT)) ?? 0;
    const shouldAlert = now - lastAlert > RE_ALERT_MS;

    const lines = stale
      .sort((a, b) => b.minsSinceLast - a.minsSinceLast)
      .map(
        (s) =>
          `• \`${s.cron}\` — last ran ${s.minsSinceLast} min ago (expected every ${s.expectedMin} min)`,
      );
    const summary = `${stale.length} cron${stale.length === 1 ? '' : 's'} stale`;

    if (shouldAlert) {
      const message = [
        `🚨 **Cron heartbeat alert** — ${summary}`,
        '',
        ...lines,
        '',
        '_Likely cause: jobs.zkward.com dispatcher down, or Vercel deploy failing. Run `bun run scripts/ping-crons.ts` to test routes directly._',
      ].join('\n');
      await notifyDiscord(message, 'KILL', { source: 'heartbeat-monitor' });
      await setCronState(KEY_LAST_ALERT, now).catch(() => {});
      logger.warn('[HeartbeatMonitor] alert fired', { staleCount: stale.length });
    } else {
      logger.info('[HeartbeatMonitor] stale crons detected (alert throttled)', {
        staleCount: stale.length,
        nextAlertInMs: RE_ALERT_MS - (now - lastAlert),
      });
    }

    return NextResponse.json({ ok: true, stale, alerted: shouldAlert });
  } catch (e) {
    logger.error('[HeartbeatMonitor] failed', { error: e instanceof Error ? e.message : e });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// POST accepted so both jobs.zkward.com and the GitHub Actions workflow
// (which POSTs by default) can drive this route.
export const POST = GET;
