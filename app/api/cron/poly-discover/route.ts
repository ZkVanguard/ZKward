/**
 * Cron: poly-discover
 *
 * Discovery + momentum + relevance + theme tick for Polymarket crypto
 * markets. All actual work lives in
 * `lib/services/market-data/poly-discover-tick.ts` so the same logic
 * can be inlined at the tail of the sui-community-pool cron without
 * burning a separate QStash schedule (Vercel free-tier cap is 10 and
 * we're at it).
 *
 * This route stays for:
 *   * Manual triggers (operator hits the URL with the CRON_SECRET).
 *   * Future re-promotion to a standalone schedule when quota allows.
 *
 * State stored: see poly-discover-tick.ts.
 *
 * Auth: QStash signature or CRON_SECRET fallback via verifyCronRequest.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { setCronState } from '@/lib/db/cron-state';
import { runPolyDiscoverTick, type PolyDiscoverTickResult } from '@/lib/services/market-data/poly-discover-tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CRON_KEY_LAST_RUN = 'cron:lastRun:poly-discover';

type CronResponse = PolyDiscoverTickResult | {
  success: false;
  ranAt: string;
  attempted: false;
  reason: string;
};

export async function GET(request: NextRequest): Promise<NextResponse<CronResponse>> {
  const ranAt = new Date().toISOString();

  const auth = await verifyCronRequest(request, 'PolyDiscover');
  if (auth !== true) {
    return NextResponse.json(
      { success: false, ranAt, attempted: false, reason: 'Unauthorized' },
      { status: 401 },
    );
  }
  void setCronState(CRON_KEY_LAST_RUN, Date.now()).catch(() => {});

  const result = await runPolyDiscoverTick();
  return NextResponse.json(result);
}

export const POST = GET;
