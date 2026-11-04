/**
 * Cron: research-desk — one round of the research desk every 15 minutes.
 *
 * Fired from master's fanout every 5 minutes; the claim sets the pace. A round
 * is one model call, about 10 s on Muse Spark Open but sometimes a minute, so
 * the route acks with 202 and runs the round in after(). The result goes to
 * cron_state `research-desk:last-result`.
 * Moves no capital: it writes only `research_trials`.
 */
import { NextRequest, NextResponse, after } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg } from '@/lib/utils/error-handler';
import { setCronState, tryClaimCronRun } from '@/lib/db/cron-state';
import { runResearchRound } from '@/lib/services/ai/research-desk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// A little under 15 minutes, so a 5-minute fanout that lands early still claims.
const CLAIM_MS = 14 * 60_000;

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  const auth = await verifyCronRequest(request, 'research-desk');
  if (auth !== true) return auth;

  const { claimed } = await tryClaimCronRun('research-desk', CLAIM_MS, Date.now());
  if (!claimed) return NextResponse.json({ ok: true, claimed: false });

  after(async () => {
    const at = Date.now();
    try {
      const result = await runResearchRound();
      await setCronState('research-desk:last-result', { at, result }).catch(() => {});
      logger.info('[ResearchDesk] round complete', { ...result, elapsedMs: Date.now() - at });
    } catch (e) {
      await setCronState('research-desk:last-result', { at, error: errMsg(e).slice(0, 200) }).catch(() => {});
      logger.error('[ResearchDesk] round failed', { error: errMsg(e) });
    }
  });

  return NextResponse.json({ ok: true, acked: true }, { status: 202 });
}
