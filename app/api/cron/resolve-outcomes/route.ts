/**
 * Signal-outcome resolver — closes the learning loop.
 *
 * ## Why
 *
 * `signal_interpretations` rows are written every time the model interprets
 * a Polymarket title into a directional (UP/DOWN) prediction with a
 * captured entry_price_usd and horizon_end. Without a resolver, `outcome_correct`
 * stays NULL forever — the postmortem pipeline can't compute hit rate, the
 * per-source calibrator can't weight sources by accuracy, and paper-trader
 * regret feedback runs on garbage.
 *
 * ## Cadence
 *
 * Two invocation paths — both call the same shared `runResolveOutcomesTick`:
 *   1. Direct HTTP hit from QStash (this route) on whatever schedule is set
 *   2. Piggyback in-process from polymarket-edge-trader every 5 min
 *
 * The 25-min internal claim debounce means only one of the two will do work
 * per interval; the other is a no-op.
 *
 * ## Contract
 *
 * - Directional (UP/DOWN) interpretations only. Binary (BINARY_YES/NO)
 *   still need Polymarket's resolution oracle; skip them here.
 *   entry_price_usd + horizon_end MUST be present — filter enforces this.
 * - Uses `getMultiSourceValidatedPrice` (min 2 agreeing sources, 2% dev cap).
 * - Idempotent: `outcome_correct IS NULL` filter prevents double-resolution.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { logger } from '@/lib/utils/logger';
import { runResolveOutcomesTick } from '@/lib/services/ai/resolve-outcomes-tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyCronRequest(request, 'ResolveOutcomes');
  if (auth !== true) return auth;

  try {
    const summary = await runResolveOutcomesTick(Date.now());
    if (!summary.claimed) {
      return NextResponse.json({ skipped: true, reason: summary.detail ?? 'debounce' });
    }
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[ResolveOutcomes] tick failed', { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
