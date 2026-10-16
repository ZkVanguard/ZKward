/**
 * GET /api/predictions/ladder-scorecard
 *
 * The daily ladder's forecasts against what happened (ladder-scorecard.ts):
 * every settled forecast, grouped by the chance it gave, with how often each
 * group ended above.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readLimiter } from '@/lib/security/rate-limiter';
import { getLadderScorecard } from '@/lib/services/market-data/ladder-scorecard';
import { errMsg } from '@/lib/utils/error-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(req);
  if (limited) return limited;
  try {
    const scorecard = await getLadderScorecard();
    // Results arrive once a day: a few minutes at the edge is plenty.
    return NextResponse.json(
      { success: true, scorecard },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' } },
    );
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e).slice(0, 120) }, { status: 502 });
  }
}
