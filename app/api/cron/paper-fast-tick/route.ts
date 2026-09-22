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
 * Security: verifyCronRequest — jobs.zkward.com HMAC or CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg } from '@/lib/utils/error-handler';
import { setCronState } from '@/lib/db/cron-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  const auth = await verifyCronRequest(request, 'paper-fast-tick');
  if (auth !== true) return auth;

  const t0 = Date.now();
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

  void setCronState('cron:lastRun:paper-fast-tick', Date.now()).catch(() => {});

  const elapsedMs = Date.now() - t0;
  return NextResponse.json({ ok: true, elapsedMs, results });
}
