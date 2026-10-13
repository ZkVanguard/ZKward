/**
 * GET /api/predictions/expected-move
 *
 * How far the prediction market prices each coin to move, read from its
 * daily strike ladder (StrikeLadderService). A size of move with the odds of
 * ending under each strike; never a direction.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readLimiter } from '@/lib/security/rate-limiter';
import { getExpectedMove, LADDER_ASSETS } from '@/lib/services/market-data/StrikeLadderService';
import type { ExpectedMove } from '@/lib/types/market-signals';
import { withOriginCache } from '@/lib/utils/origin-cache';
import { errMsg } from '@/lib/utils/error-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

async function handleGet(req: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(req);
  if (limited) return limited;

  const settled = await Promise.allSettled(LADDER_ASSETS.map((asset) => getExpectedMove(asset)));
  const moves: Record<string, ExpectedMove> = {};
  const errors: Record<string, string> = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') moves[LADDER_ASSETS[i]] = r.value;
    else errors[LADDER_ASSETS[i]] = errMsg(r.reason).slice(0, 120);
  });

  // No ladder readable is a failed read, not a board with nothing to say.
  if (Object.keys(moves).length === 0) {
    return NextResponse.json({ success: false, errors }, { status: 502 });
  }
  return NextResponse.json(
    { success: true, fetchedAt: new Date().toISOString(), moves, errors },
    // A ladder moves slowly: fresh for a minute at the edge, and served stale
    // while it refreshes so a quiet site never waits on the upstream read.
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=86400' } },
  );
}

export const GET = withOriginCache({ name: 'expected-move', freshSec: 60 }, handleGet);
