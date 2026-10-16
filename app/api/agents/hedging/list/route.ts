/**
 * Get Hedges from PostgreSQL Database
 * API endpoint for fetching hedge positions
 * SECURITY: Rate-limited. Auth required to view hedges.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllHedges, getActiveHedges, getHedgeStats, getActiveHedgesByWallet, getAllHedgesByWallet } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import { requireAuth } from '@/lib/security/auth-middleware';
import { readLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { envFlag } from '@/lib/utils/env-flag';
import { fetchHedgesFromSubgraph } from '@/lib/graph/queries';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/hedging/list
 * Fetch hedge positions from database
 * 
 * Query params:
 * - portfolioId: Filter by portfolio (optional)
 * - walletAddress: Filter by wallet address (optional)
 * - status: 'active' | 'all' (default: 'all')
 * - limit: Number of results (default: 50)
 */
export async function GET(request: NextRequest) {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  // Require auth to view hedge data
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const searchParams = request.nextUrl.searchParams;
    const portfolioId = searchParams.get('portfolioId');
    // A wallet-signed caller sees its own hedges only; internal callers see any.
    const ownWallet = authResult.method === 'wallet' ? authResult.identity : null;
    const walletAddress = ownWallet ?? searchParams.get('walletAddress');
    const status = searchParams.get('status') || 'all';
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);

    logger.info('📊 Fetching hedges', { portfolioId, walletAddress, status, limit });

    let hedges;

    // Subgraph read-path (Aiven retirement Phase 3): serve pool-scoped
    // hedge listings from the subgraph when the flag is on AND the
    // request has no per-wallet filter (subgraph indexes on-chain
    // events keyed to the pool contract, not individual EOAs — wallet
    // filtering stays on the DB reconciler view).
    const canServeFromSubgraph =
      envFlag('SUBGRAPH_READS_ENABLED') && !walletAddress;

    if (canServeFromSubgraph) {
      const subgraphStatus = status === 'active' ? 'OPEN' : undefined;
      const subgraphHedges = await fetchHedgesFromSubgraph({
        status: subgraphStatus,
        first: limit,
      });
      if (subgraphHedges) {
        hedges = subgraphHedges;
      } else {
        logger.warn('[hedging/list] subgraph failed — falling back to Aiven', { status });
      }
    }

    if (!hedges) {
      if (walletAddress) {
        if (status === 'active') {
          hedges = await getActiveHedgesByWallet(walletAddress);
        } else {
          hedges = await getAllHedgesByWallet(walletAddress, limit);
        }
      } else if (status === 'active') {
        hedges = await getActiveHedges(portfolioId ? parseInt(portfolioId, 10) : undefined);
      } else {
        hedges = await getAllHedges(
          portfolioId ? parseInt(portfolioId, 10) : undefined,
          limit,
        );
      }
    }

    // Get stats if requested
    const includeStats = searchParams.get('includeStats') === 'true';
    const stats = includeStats ? await getHedgeStats() : null;

    logger.info('✅ Hedges retrieved', { count: hedges.length, walletAddress: walletAddress ? `${walletAddress.slice(0, 6)}...` : 'all' });

    return NextResponse.json({
      success: true,
      hedges,
      count: hedges.length,
      stats,
    }, {
      // DB rows updated by cron; 15s edge cache with 45s SWR collapses
      // dashboard tab polling.
      headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45' },
    });

  } catch (error) {
    return safeErrorResponse(error, 'hedging/list');
  }
}
