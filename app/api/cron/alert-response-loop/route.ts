/**
 * Alert Response Loop — turns Discord alerts into auto-remediation.
 *
 * ## Why
 *
 * Discord is a passive tap on the shoulder. Real autonomy needs a
 * closed loop: 3 KILL alerts in 60 min → auto-shrink spot. Profit-lock
 * pinned at 0% risk for > 24h → auto-unwind all spot to USDC. Phantom
 * hedge rate > 1% for > 1h → halt trader + auto-hedge.
 *
 * ## Cadence
 *
 * Runs every 15 min via QStash (create schedule via `curl` against the
 * v2 API — see DEPLOY_RUNBOOK Appendix X). Cost: 1 DB read + 1 Discord post per tick
 * when no action; extra RPC only when a rule fires.
 *
 * ## Env gates
 *
 * All destructive responses are gated so the first days after deploy
 * are log-only. Operator watches Discord for what WOULD have fired
 * before flipping ALERT_RESPONSE_EXECUTE=1 to make it live.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { tryClaimCronRun, setCronState, setCronHalt, CronKeys } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { notifyDiscord, readAlertLog } from '@/lib/utils/discord-notify';
import { evaluateAutoResponse } from '@/lib/services/alerting/alert-response-loop';
import { envFlag, envFlagOnByDefault } from '@/lib/utils/env-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CRON_KEY = 'alert-response-loop';
const TICK_INTERVAL_MS = 60 * 1000; // debounce
const HEARTBEAT_KEY = `cron:lastRun:${CRON_KEY}`;

async function handle(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyCronRequest(request, 'AlertResponseLoop');
  if (auth !== true) return auth;

  const now = Date.now();
  // tryClaimCronRun returns { claimed, lastRunMs, reason? } — an object,
  // so `!claim` was always false. Debounce never triggered. Same bug as
  // agent-signal-tick; sui-community-pool uses the correct `claim.claimed`.
  const claim = await tryClaimCronRun(CRON_KEY, TICK_INTERVAL_MS, now);
  if (!claim.claimed) {
    return NextResponse.json({ skipped: true, reason: claim.reason ?? 'tick claim debounce' });
  }
  await setCronState(HEARTBEAT_KEY, now).catch(() => {});

  try {
    const alertLog = await readAlertLog();

    // Phantom rate — mirrors app/api/health/production/route.ts checkPhantomRate().
    // Prior implementation queried `status='phantom'` which the hedges CHECK
    // constraint never allows (only active/closed/liquidated/cancelled), so the
    // rate stayed 0 forever and Rule 3 never fired. Two signals now:
    //   1. Closed-hedge rate: closed w/ realized_pnl=0 / total closed last hour.
    //   2. In-flight opens: active > 20 min, updated_at ≈ created_at (0 reconciler
    //      touches) — closes the 15-min window the closed-rate can't see.
    let phantomRatePctLastHour = 0;
    let phantomTotalLastHour = 0;
    let inFlightPhantomOpenCount = 0;
    try {
      const { query } = await import('@/lib/db/postgres');
      const [closedRow, openRow] = await Promise.all([
        query<{ total: string; phantoms: string }>(
          // Mirror health/production checkPhantomRate: reconstructed_* orders
          // are real trades adopted by bluefin-db-reconcile with legit $0
          // realized_pnl. Not phantom fills.
          `SELECT COUNT(*)::text as total,
                  SUM(CASE WHEN COALESCE(realized_pnl, 0) = 0 THEN 1 ELSE 0 END)::text as phantoms
           FROM hedges
           WHERE chain='sui' AND status='closed' AND notional_value >= 1
             AND created_at > NOW() - INTERVAL '1 hour'
             AND (order_id IS NULL OR order_id NOT LIKE 'reconstructed_%')`
        ),
        query<{ open_phantoms: string }>(
          `SELECT COUNT(*)::text as open_phantoms
           FROM hedges
           WHERE chain='sui' AND status='active' AND notional_value >= 1
             AND created_at < NOW() - INTERVAL '20 minutes'
             AND EXTRACT(EPOCH FROM (updated_at - created_at)) < 30`
        ),
      ]);
      const total = Number(closedRow[0]?.total ?? 0);
      const phantoms = Number(closedRow[0]?.phantoms ?? 0);
      phantomRatePctLastHour = total > 0 ? (phantoms / total) * 100 : 0;
      phantomTotalLastHour = total;
      inFlightPhantomOpenCount = Number(openRow[0]?.open_phantoms ?? 0);
    } catch { /* best-effort */ }

    // Profit-lock zero-tier tracking — reads the timestamp we mark in cron_state
    // whenever profit-lock hits 0%. Absent = not there.
    let profitLockZeroSinceMs: number | undefined;
    try {
      const { getCronState } = await import('@/lib/db/cron-state');
      profitLockZeroSinceMs = (await getCronState<number>('profit-lock:zero-since').catch(() => null)) ?? undefined;
    } catch { /* best-effort */ }

    const responses = await evaluateAutoResponse({
      alertLog,
      now,
      profitLockZeroSinceMs,
      phantomRatePctLastHour,
      phantomTotalLastHour,
      inFlightPhantomOpenCount,
    });

    if (responses.length === 0) {
      return NextResponse.json({ success: true, responses: 0 });
    }

    const execute = envFlagOnByDefault('ALERT_RESPONSE_EXECUTE');
    logger.warn('[AlertResponseLoop] auto-response(s) fired', {
      execute, count: responses.length, responses,
    });

    for (const r of responses) {
      // Emit at WARN, not KILL — the auto-response's own emission was
      // getting appended to alert-log and self-triggering the 3-KILL/hr
      // rule (observed 2026-07-17: 8 KILL alerts in 60min were mostly
      // its own emissions). KILL stays reserved for genuine trigger
      // sources (real trade halts, phantom rate breach, etc).
      await notifyDiscord(
        `🤖 Auto-response: ${r.type} — ${r.reason} [${execute ? 'EXECUTING' : 'log-only'}]`,
        'WARN',
        r as unknown as Record<string, unknown>,
      ).catch(() => {});

      if (!execute) continue;

      // Execution paths — each behind its own env gate. Kept small so
      // rollout can enable one at a time.
      //
      // Silent-catch removed 2026-07-17: previously every setCronState
      // was `.catch(() => {})` which swallowed the exact failure that
      // means "halt did not actually apply". Same pattern as the
      // stale-hedge silent-fail (dust-lock hidden for 34 days). Now
      // logs + alerts on failure so operator sees when a halt didn't
      // persist.
      try {
        // 24h halt window matches the trader's own kill-switch HALT_DURATION_MS
        // and is long enough to bridge one full day of manual triage.
        const HALT_WINDOW_MS = 24 * 60 * 60 * 1000;
        const haltUntilMs = now + HALT_WINDOW_MS;
        if (r.type === 'HALT_TRADER' && envFlag('ALERT_RESPONSE_EXECUTE_HALT')) {
          try {
            // Trader reads this exact key via KEY_HALTED_UNTIL and halts while
            // untilMs > now (app/api/cron/polymarket-edge-trader/route.ts:705).
            // Prior wire wrote `polymarket-edge-trader:halt = now` — wrong key
            // AND wrong value shape (current time = 0 ms halt). Silent for the
            // entire v0.3.0 rollout window.
            await setCronState(CronKeys.polymarketEdgeHaltedUntil, haltUntilMs);
          } catch (haltErr) {
            logger.error('[AlertResponseLoop] HALT_TRADER cron_state write FAILED', {
              error: haltErr instanceof Error ? haltErr.message : String(haltErr),
            });
            await notifyDiscord(
              `❌ HALT_TRADER halt-write FAILED — trader may keep trading during breach`,
              'ERROR', { error: haltErr instanceof Error ? haltErr.message : String(haltErr) },
            ).catch(() => {});
          }
        }
        if (r.type === 'HALT_AUTOHEDGE' && envFlag('ALERT_RESPONSE_EXECUTE_HALT')) {
          try {
            // sui-community-pool reads via getCronHalt('sui-community-pool:autohedge')
            // which pulls cron:haltUntil:<id> + cron:haltReason:<id>. Prior wire
            // used raw setCronState on 'sui-community-pool:autohedge:halt' with
            // an object payload — different keyspace, never read.
            await setCronHalt('sui-community-pool:autohedge', haltUntilMs, r.reason);
          } catch (haltErr) {
            logger.error('[AlertResponseLoop] HALT_AUTOHEDGE cron_state write FAILED', {
              error: haltErr instanceof Error ? haltErr.message : String(haltErr),
            });
            await notifyDiscord(
              `❌ HALT_AUTOHEDGE halt-write FAILED — auto-hedge may keep firing`,
              'ERROR', { error: haltErr instanceof Error ? haltErr.message : String(haltErr) },
            ).catch(() => {});
          }
        }
        // SHRINK_SPOT / UNWIND_ALL_SPOT — write a target-risk-cap override
        // to cron_state; sui-community-pool reads this AFTER profit-lock and
        // uses the tighter cap (min of profit-lock and this). PortfolioDriver
        // then unwinds existing spot to hit it (requires PORTFOLIO_DRIVER_EXECUTE=1
        // in the sui-community-pool cron). TTL 6h so a stale override auto-clears.
        if (r.type === 'SHRINK_SPOT' || r.type === 'UNWIND_ALL_SPOT') {
          const capPct = r.type === 'SHRINK_SPOT' ? 20 : 0;
          try {
            await setCronState('alert-response:spot-target-risk-cap', {
              capPct,
              reason: r.reason,
              expiresAtMs: now + 6 * 60 * 60 * 1000,
            });
          } catch (capErr) {
            logger.error('[AlertResponseLoop] risk-cap override write FAILED', {
              type: r.type, capPct,
              error: capErr instanceof Error ? capErr.message : String(capErr),
            });
            await notifyDiscord(
              `❌ ${r.type} override write FAILED — spot unwind will not fire`,
              'ERROR', { error: capErr instanceof Error ? capErr.message : String(capErr) },
            ).catch(() => {});
          }
        }
      } catch (execErr) {
        logger.warn('[AlertResponseLoop] execute failed for response', {
          type: r.type, error: execErr instanceof Error ? execErr.message : String(execErr),
        });
      }
    }

    return NextResponse.json({
      success: true,
      execute,
      responses: responses.length,
      types: responses.map(r => r.type),
    });
  } catch (e) {
    logger.error('[AlertResponseLoop] failed', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
