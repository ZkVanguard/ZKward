/**
 * Cron: paper-fast-tick — high-cadence paper trader loop.
 *
 * Runs the two paper traders (raw + gated) at whatever cadence the
 * scheduler is configured for — typically 60s via a dedicated
 * job_schedules row on jobs.zkward.com. That's separate from the master
 * 5-min tick that fans out to production crons, so speeding up paper
 * data collection doesn't drag on-chain reconcilers or fee sweeps.
 *
 * Why a separate route: the polymarket-edge-trader route piggybacked
 * paper traders at its own 5-min cadence because QStash's 10-schedule
 * cap forced consolidation. QStash was retired 2026-09-19 in favor of
 * self-hosted jobs.zkward.com (no schedule cap), so we can finally give
 * paper trading its own tick without stealing from the live trader.
 *
 * Non-fatal: paper tick failures never block anything real.
 *
 * Ack-and-run (2026-09-29): 202 in milliseconds, the four stages run in
 * after() behind a 50s claim. Awaiting them in-request put p99 (~29s) at the
 * scheduler's delivery timeout, so ~98 deliveries/day retried and re-ran
 * live trading logic. The effective-config echo stays in the response
 * (job_messages keeps it); per-tick results go to cron_state
 * `paper-fast-tick:last-results`.
 *
 * Security: verifyCronRequest — jobs.zkward.com HMAC or CRON_SECRET.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg } from '@/lib/utils/error-handler';
import { setCronState, tryClaimCronRun } from '@/lib/db/cron-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CLAIM_ID = 'paper-fast-tick-claim';
const CLAIM_MS = 50_000;

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  const auth = await verifyCronRequest(request, 'paper-fast-tick');
  if (auth !== true) return auth;

  const cfg = await effectiveConfig();
  const { claimed } = await tryClaimCronRun(CLAIM_ID, CLAIM_MS, Date.now());
  if (!claimed) return NextResponse.json({ ok: true, claimed: false, cfg });

  after(async () => {
    const t0 = Date.now();
    const results = await runStages();
    const elapsedMs = Date.now() - t0;
    await setCronState('cron:lastRun:paper-fast-tick', Date.now()).catch(() => {});
    await setCronState('paper-fast-tick:last-results', { at: t0, elapsedMs, results }).catch(
      () => {},
    );
    logger.info('[PaperFastTick] tick complete', { elapsedMs, results });
  });

  return NextResponse.json({ ok: true, acked: true, cfg }, { status: 202 });
}

async function runStages(): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  try {
    const { PaperTrader } = await import('@/lib/services/paper-trader/PaperTrader');
    const r = await PaperTrader.runTick();
    results.paper = `${r.action}${r.reason ? ` — ${r.reason.slice(0, 80)}` : ''}`;
  } catch (e) {
    results.paper = `error: ${errMsg(e).slice(0, 80)}`;
    logger.warn('[PaperFastTick] paper tick failed (non-fatal)', { error: errMsg(e) });
  }

  try {
    const { PaperGatedTrader } = await import('@/lib/services/paper-trader/PaperGatedTrader');
    const r = await PaperGatedTrader.runTick();
    results.paperGated = `${r.action}${r.reason ? ` — ${r.reason.slice(0, 80)}` : ''}`;
  } catch (e) {
    results.paperGated = `error: ${errMsg(e).slice(0, 80)}`;
    logger.warn('[PaperFastTick] paper-gated tick failed (non-fatal)', { error: errMsg(e) });
  }

  // Oracle trader (portfolio -5): bets fresh AI interpretations at their
  // NATIVE horizon — the counterfactual on stored entry/exit pairs ran
  // 73.9% WR / +1.55%/trade net (n=46). This book measures it forward.
  try {
    const { OracleTrader } = await import('@/lib/services/paper-trader/OracleTrader');
    const s = await OracleTrader.runTick(Date.now());
    results.oracle = `opened ${s.opened}, closed ${s.closed}, active ${s.active}`;
  } catch (e) {
    results.oracle = `error: ${errMsg(e).slice(0, 80)}`;
    logger.warn('[PaperFastTick] oracle tick failed (non-fatal)', { error: errMsg(e) });
  }

  // Signal ledger (root-audit Pillar 2): snapshot every source's call at
  // fixed horizons + resolve expired windows. Rides this tick because the
  // aggregator scan is still warm (20s TTL) from the trader runs above.
  // Non-fatal — ledger failure never blocks paper ticks.
  try {
    const { runSignalLedgerTick } = await import('@/lib/services/market-data/signal-ledger');
    const s = await runSignalLedgerTick(Date.now());
    results.ledger = `resolved ${s.resolved}${s.voided ? ` (+${s.voided} void)` : ''}${s.snapshotted ? `, recorded ${s.recorded}` : ''}${s.pruned ? `, pruned ${s.pruned}` : ''}`;
  } catch (e) {
    results.ledger = `error: ${errMsg(e).slice(0, 80)}`;
    logger.warn('[PaperFastTick] signal-ledger tick failed (non-fatal)', { error: errMsg(e) });
  }

  return results;
}

// Effective-config echo (Fix O audit, 2026-09-27). This response body is
// persisted verbatim in the jobs service's job_messages table, so the knob
// values ACTUALLY live on this deployment are queryable from the DB — no
// Vercel dashboard access needed. Vercel env silently overriding code
// defaults is the standing suspect for gates not matching code.
async function effectiveConfig(): Promise<Record<string, unknown>> {
  try {
    const c = await import('@/lib/services/paper-trader/config');
    return {
      sha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) || 'local',
      minConf: c.PAPER_MIN_CONFIDENCE,
      minCons: c.PAPER_MIN_CONSENSUS,
      minSrc: c.PAPER_MIN_SOURCES,
      stake: c.PAPER_STAKE_PCT,
      maxStake: c.PAPER_MAX_STAKE_PCT,
      flipAgeSec: c.PAPER_MIN_FLIP_AGE_SEC,
      holdCeil: c.PAPER_MAX_HOLD_CEILING_MIN,
      tightenAge: c.PAPER_TIGHTEN_AGE_MIN,
      tightenFrac: c.PAPER_TIGHTEN_NOTIONAL_FRAC,
      armFrac: c.PAPER_TRAILING_ARM_NOTIONAL_FRAC,
      stopEnv: (process.env.PAPER_TRADER_STOP_LOSS_PCT || 'default').trim(),
      seeds: c.PAPER_ASSET_SIDE_BLACKLIST_SEEDS.size,
      chopHalt: c.PAPER_HALT_ENTRIES_IN_CHOP,
      chopStakeMult: c.PAPER_CHOP_STAKE_MULT,
      probeStakeMult: c.PAPER_PROBE_STAKE_MULT,
      skipStrong: c.PAPER_SKIP_STRONG_SIGNALS,
      disableHalts: c.PAPER_DISABLE_HALTS,
      // Names (never values) of PAPER_TRADER_* env overrides active on this
      // deployment — a non-empty list means env is diverging from code
      // defaults, the root cause of every "the fix changed nothing" episode.
      overrides: Object.keys(process.env).filter((k) => k.startsWith('PAPER_TRADER_')).sort(),
    };
  } catch {
    return {}; // echo is best-effort
  }
}
