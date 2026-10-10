/**
 * Portfolio Rebalance API
 * 
 * POST /api/agents/portfolio/rebalance
 * 
 * Returns a rebalance recommendation for the caller's wallet to execute
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { requireAuth } from '@/lib/security/auth-middleware';
import { mutationLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

/**
 * POST - Execute portfolio rebalancing
 */
export async function POST(request: NextRequest) {
  // Rate limiting
  const rateLimitResponse = mutationLimiter.check(request);
  if (rateLimitResponse) return rateLimitResponse;

  // Auth - require wallet auth and verify ownership
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const body = await request.json();
    const { 
      portfolioId, 
      walletAddress, 
      newAllocations, 
      autoApproved,
      actions 
    } = body;

    // Validation
    if (!portfolioId || !walletAddress) {
      return NextResponse.json(
        { success: false, error: 'portfolioId and walletAddress required' },
        { status: 400 }
      );
    }

    // Verify caller owns this wallet
    if (authResult.identity?.toLowerCase() !== walletAddress?.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'Wallet address mismatch' },
        { status: 403 }
      );
    }

    if (!newAllocations || !Array.isArray(newAllocations) || newAllocations.length === 0) {
      return NextResponse.json(
        { success: false, error: 'newAllocations array required' },
        { status: 400 }
      );
    }

    logger.info('[Rebalance] Starting portfolio rebalance', {
      portfolioId,
      walletAddress: walletAddress.slice(0, 10) + '...',
      autoApproved,
      actionCount: actions?.length || 0,
    });

    // PRODUCTION SAFETY: This API only generates recommendations
    // Actual transactions MUST be executed by the user signing in their wallet
    // Backend NEVER executes transactions affecting user funds

    logger.info('[Rebalance] Generated rebalance recommendation', {
      portfolioId,
      autoApproved,
      actionCount: actions?.length || 0,
    });

    // Return recommendation - user must execute via wallet
    return NextResponse.json({
      success: true,
      message: 'Rebalance recommendation generated - execute via wallet',
      // NO txHash - user must sign transaction themselves
      status: 'pending_user_signature',
      portfolioId,
      recommendedActions: actions || [],
      // User must call contract directly from frontend
      contractCall: {
        method: 'rebalancePortfolio',
        args: [portfolioId, newAllocations.map(a => a.asset), newAllocations.map(a => a.percentage)],
      },
      timestamp: Date.now(),
    });

  } catch (error) {
    return safeErrorResponse(error, 'Portfolio rebalance');
  }
}
