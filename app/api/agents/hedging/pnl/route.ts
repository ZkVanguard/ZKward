/**
 * Get Real-time Hedge PnL
 * API endpoint for fetching current profit/loss on active hedges using real market data
 * SECURITY: GET requires auth + rate limit. POST (manual trigger) requires admin auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hedgePnLTracker } from '@/lib/services/hedging/HedgePnLTracker';
import { getActiveHedges, getHedgeByOrderId, getActiveHedgesByWallet } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import { requireAuth, requireAdminAuth } from '@/lib/security/auth-middleware';
import { readLimiter, heavyLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/hedging/pnl
 * Get real-time PnL for active hedges
 * 
 * Query params:
 * - orderId: Get PnL for specific hedge (optional)
 * - portfolioId: Filter by portfolio (optional)
 * - walletAddress: Filter by wallet address (optional)
 * - summary: Get portfolio summary (optional)
 */
export async function GET(request: NextRequest) {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const searchParams = request.nextUrl.searchParams;
    const orderId = searchParams.get('orderId');
    const portfolioId = searchParams.get('portfolioId');
    // A wallet-signed caller sees its own hedges only; internal callers see any.
    const ownWallet = authResult.method === 'wallet' ? authResult.identity : null;
    const walletAddress = ownWallet ?? searchParams.get('walletAddress');
    const summary = searchParams.get('summary') === 'true';

    logger.info('📊 Fetching hedge PnL', { orderId, portfolioId, walletAddress, summary });

    // Single hedge PnL
    if (orderId) {
      const hedge = await getHedgeByOrderId(orderId);
      
      if (!hedge || (ownWallet && hedge.wallet_address?.toLowerCase() !== ownWallet.toLowerCase())) {
        return NextResponse.json(
          { success: false, error: 'Hedge not found' },
          { status: 404 }
        );
      }

      if (hedge.status !== 'active') {
        return NextResponse.json({
          success: true,
          hedge: {
            orderId: hedge.order_id,
            status: hedge.status,
            realizedPnL: hedge.realized_pnl,
            message: 'Hedge is not active',
          },
        });
      }

      const pnl = await hedgePnLTracker.getHedgePnL(hedge);

      return NextResponse.json({
        success: true,
        pnl,
      });
    }

    // Portfolio summary
    if (summary) {
      const summaryData = await hedgePnLTracker.getPortfolioPnLSummary(
        portfolioId ? parseInt(portfolioId, 10) : undefined,
        walletAddress || undefined
      );

      return NextResponse.json({
        success: true,
        summary: summaryData,
      });
    }

    // All active hedges with PnL (limited to 50 to avoid N+1 explosion)
    let hedges;
    if (walletAddress) {
      hedges = await getActiveHedgesByWallet(walletAddress);
    } else {
      hedges = await getActiveHedges(portfolioId ? parseInt(portfolioId, 10) : undefined);
    }
    
    // Cap at 50 hedges to prevent excessive API calls
    const limitedHedges = hedges.slice(0, 50);
    const pnlUpdates = await Promise.all(
      limitedHedges.map(hedge => hedgePnLTracker.getHedgePnL(hedge))
    );

    return NextResponse.json({
      success: true,
      hedges: pnlUpdates,
      count: pnlUpdates.length,
      total: hedges.length,
      truncated: hedges.length > 50,
    });

  } catch (error) {
    return safeErrorResponse(error, 'hedging/pnl GET');
  }
}

/**
 * POST /api/agents/hedging/pnl
 * Manually trigger PnL update for all active hedges
 * SECURITY: Admin-only — triggers global update for all hedges
 */
export async function POST(request: NextRequest) {
  const limited = heavyLimiter.check(request);
  if (limited) return limited;

  // SECURITY: Admin-only — this updates ALL hedges globally
  const adminCheck = requireAdminAuth(request);
  if (adminCheck !== true) return adminCheck;

  try {
    logger.info('🔄 Manual PnL update triggered');

    const updates = await hedgePnLTracker.updateAllHedges();

    return NextResponse.json({
      success: true,
      message: `Updated PnL for ${updates.length} hedges`,
      updates,
    });

  } catch (error) {
    return safeErrorResponse(error, 'hedging/pnl POST');
  }
}
