/**
 * Platform NAV History API — public, cached.
 *
 * Powers the pool-value time-series chart on /dashboard/risk. Returns
 * one point per bucket (hourly default) so the chart stays readable
 * across a 60-day window (~1440 points max) while preserving detail
 * near the current tick.
 *
 * The `nav_history` table (community_pool_nav_history) is populated
 * every ~30 min by sui-community-pool + pool-nav-monitor. 2600+ rows
 * over the pool's lifetime — bucket-aggregate in SQL, not in JS.
 *
 * GET /api/platform/nav-history?window=30d&bucket=hour
 *   window: '1d' | '7d' | '30d' | '60d' | 'all'  (default: '30d')
 *   bucket: 'minute' | 'hour' | 'day'            (default: 'hour')
 *
 * Response is investor-facing so it flattens numeric strings and drops
 * internal columns (source, chain, member_count only in summary).
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';
import { query } from '@/lib/db/postgres';
import { envFlag } from '@/lib/utils/env-flag';
import { fetchNavHistoryFromSubgraph, type NavSnapshotRow } from '@/lib/graph/queries';
import { withOriginCache } from '@/lib/utils/origin-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const WINDOW_INTERVALS: Record<string, string> = {
  '1d': '1 day',
  '7d': '7 days',
  '30d': '30 days',
  '60d': '60 days',
  all: '10 years',
};

const BUCKET_OPTIONS = new Set(['minute', 'hour', 'day']);

// Maps the human-readable window string to a plain seconds count for
// the subgraph query (which takes epoch seconds, not a Postgres interval).
function intervalToSeconds(interval: string): number {
  if (interval.includes('year')) return 60 * 60 * 24 * 365 * 10;
  const match = /^(\d+)\s*day/.exec(interval);
  if (!match) return 60 * 60 * 24 * 30; // 30d default
  return Number(match[1]) * 60 * 60 * 24;
}

interface Point {
  t: string;              // ISO bucket start
  sharePrice: number;
  navUsd: number;
}

interface NavHistoryResponse {
  asOf: string;
  window: string;
  bucket: string;
  count: number;
  first?: Point;
  last?: Point;
  peak?: { t: string; sharePrice: number };
  points: Point[];
}

async function handleGet(request: NextRequest): Promise<NextResponse<NavHistoryResponse | { error: string }>> {
  const limited = readLimiter.check(request);
  if (limited) return limited as NextResponse<NavHistoryResponse | { error: string }>;

  const url = new URL(request.url);
  const windowRaw = (url.searchParams.get('window') || '30d').trim().toLowerCase();
  const bucketRaw = (url.searchParams.get('bucket') || 'hour').trim().toLowerCase();
  const interval = WINDOW_INTERVALS[windowRaw] || WINDOW_INTERVALS['30d'];
  const bucket = BUCKET_OPTIONS.has(bucketRaw) ? bucketRaw : 'hour';

  try {
    // Subgraph read-path (Aiven retirement Phase 2): when the flag is
    // on and the subgraph returns data, serve from there. Any failure
    // (subgraph unreachable, GraphQL errors, empty result on a fresh
    // deployment) transparently falls through to Aiven. Once every
    // endpoint is migrated and the subgraph has parity, we flip
    // AIVEN_DISABLE and delete the SQL path.
    let points: Point[] | null = null;
    if (envFlag('SUBGRAPH_READS_ENABLED')) {
      const windowSeconds = intervalToSeconds(interval);
      const sinceSeconds = Math.floor(Date.now() / 1000) - windowSeconds;
      const subgraphRows: NavSnapshotRow[] | null = await fetchNavHistoryFromSubgraph({
        sinceSeconds,
        bucket: bucket as 'minute' | 'hour' | 'day',
      });
      if (subgraphRows && subgraphRows.length > 0) {
        points = subgraphRows;
      } else {
        logger.warn('[nav-history] subgraph empty/failed — falling back to Aiven', {
          window: windowRaw, bucket,
        });
      }
    }

    if (!points) {
      // date_trunc + AVG bucketing at the DB layer — cheap because the
      // table is small (~2650 rows total) and the aggregation runs once.
      const rows = await query<{ t: Date; share_price: string; nav_usd: string }>(
        `SELECT
           date_trunc($1, timestamp) as t,
           AVG(share_price)::text as share_price,
           AVG(total_nav)::text as nav_usd
         FROM community_pool_nav_history
         WHERE timestamp > NOW() - $2::interval
         GROUP BY t
         ORDER BY t ASC`,
        [bucket, interval],
      );
      points = rows.map((r) => ({
        t: r.t.toISOString(),
        sharePrice: Number(r.share_price),
        navUsd: Number(r.nav_usd),
      }));
    }

    const peakRow = points.reduce<Point | undefined>((best, p) => {
      if (!best || p.sharePrice > best.sharePrice) return p;
      return best;
    }, undefined);

    return NextResponse.json({
      asOf: new Date().toISOString(),
      window: windowRaw,
      bucket,
      count: points.length,
      first: points[0],
      last: points[points.length - 1],
      peak: peakRow ? { t: peakRow.t, sharePrice: peakRow.sharePrice } : undefined,
      points,
    }, {
      // nav_history is written every ~30min by sui-community-pool +
      // pool-nav-monitor; 60s edge cache collapses chart reloads.
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=86400' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('[nav-history] error', { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const GET = withOriginCache({ name: 'platform-nav-history', freshSec: 60, params: ['window', 'bucket'] }, handleGet);
