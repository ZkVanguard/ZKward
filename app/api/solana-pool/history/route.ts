/**
 * NAV history for the Solana token pool — the dashboard chart's data source.
 * Same response shape as /api/platform/nav-history so the chart needs no
 * per-chain parsing. Public, read-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';
import { withOriginCache } from '@/lib/utils/origin-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WINDOW_DAYS: Record<string, number | null> = { '7d': 7, '30d': 30, '60d': 60, all: null };

async function handleGet(request: NextRequest): Promise<NextResponse> {
  const window = request.nextUrl.searchParams.get('window') ?? '30d';
  const days = window in WINDOW_DAYS ? WINDOW_DAYS[window] : 30;
  const bucket = request.nextUrl.searchParams.get('bucket') === 'day' ? 'day' : 'hour';
  const asOf = new Date().toISOString();

  if (!envFlag('SOLANA_POOL_ENABLED')) {
    return NextResponse.json({ asOf, window, count: 0, points: [] });
  }
  try {
    const { getNavHistory } = await import('@/lib/db/solana-pool');
    // A snapshot taken while the token price was unavailable has no USD NAV.
    const points = (await getNavHistory(days, bucket))
      .filter((r) => r.nav_usd !== null)
      .map((r) => ({ t: new Date(r.t).toISOString(), sharePrice: r.share_price, navUsd: r.nav_usd as number }));
    const peak = points.reduce<(typeof points)[number] | undefined>(
      (best, p) => (!best || p.sharePrice > best.sharePrice ? p : best),
      undefined,
    );
    return NextResponse.json(
      {
        asOf,
        window,
        count: points.length,
        first: points[0],
        last: points[points.length - 1],
        peak: peak && { t: peak.t, sharePrice: peak.sharePrice },
        points,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=86400' } },
    );
  } catch (e) {
    return NextResponse.json({ asOf, window, count: 0, points: [], error: errMsg(e) }, { status: 500 });
  }
}

export const GET = withOriginCache({ name: 'solana-history', freshSec: 60, params: ['window', 'bucket'] }, handleGet);
