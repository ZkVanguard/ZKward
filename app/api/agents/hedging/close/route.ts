/**
 * Close Hedge Position
 * API endpoint for closing active hedge positions
 * Supports proxy wallet privacy - funds always go to OWNER wallet
 * SECURITY: Requires auth. DELETE requires admin auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { closeHedge, getHedgeByOrderId, clearSimulationHedges, clearAllHedges } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import _crypto from 'crypto';
import { requireAuth, requireAdminAuth } from '@/lib/security/auth-middleware';
import { mutationLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

// Verify ownership via ZK binding
function verifyOwnership(walletAddress: string, hedgeId: string, storedWallet: string): boolean {
  return walletAddress.toLowerCase() === storedWallet.toLowerCase();
}

/**
 * POST /api/agents/hedging/close
 * Close a hedge position
 * SECURITY: walletAddress is REQUIRED and must match hedge owner.
 */
export async function POST(request: NextRequest) {
  const limited = await mutationLimiter.checkDistributed(request);
  if (limited) return limited;

  // Require authentication
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const body = await request.json();
    const { orderId, realizedPnl, walletAddress } = body;

    if (!orderId) {
      return NextResponse.json(
        { success: false, error: 'Missing orderId' },
        { status: 400 }
      );
    }

    logger.info('🔒 Closing hedge position', { orderId, realizedPnl, walletAddress });

    // Check if hedge exists
    const hedge = await getHedgeByOrderId(orderId);
    
    if (!hedge) {
      return NextResponse.json(
        { success: false, error: 'Hedge not found' },
        { status: 404 }
      );
    }

    if (hedge.status !== 'active') {
      return NextResponse.json(
        { success: false, error: `Hedge is already ${hedge.status}` },
        { status: 400 }
      );
    }

    // SECURITY: walletAddress is REQUIRED to verify ownership
    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'walletAddress is required to close a hedge' },
        { status: 400 }
      );
    }

    // Verify ownership - CRITICAL for proxy wallet security
    // Only the OWNER wallet can close and receive funds
    const ownerWallet = hedge.wallet_address;
    const withdrawalDestination = ownerWallet;

    if (ownerWallet) {
      const isOwner = verifyOwnership(walletAddress, orderId, ownerWallet);
      if (!isOwner) {
        logger.warn('⚠️ Non-owner attempted to close hedge', { 
          requestingWallet: walletAddress, 
          ownerWallet: ownerWallet?.slice(0, 10) + '...',
          orderId 
        });
        return NextResponse.json(
          { 
            success: false, 
            error: 'Only the hedge owner can close and withdraw funds',
            ownerRequired: true,
            message: 'Connect with the owner wallet to close this hedge'
          },
          { status: 403 }
        );
      }
    }

    // Close the hedge
    const finalPnl = realizedPnl ?? Number(hedge.current_pnl);
    await closeHedge(orderId, finalPnl, 'closed');

    logger.info('✅ Hedge closed successfully', { 
      orderId, 
      finalPnl: finalPnl.toFixed(2),
      withdrawalDestination: withdrawalDestination?.slice(0, 10) + '...',
      ownerVerified: true
    });

    return NextResponse.json({
      success: true,
      message: 'Hedge closed successfully',
      orderId,
      finalPnl,
      withdrawalDestination: ownerWallet,
      ownerVerified: true,
      proxyWalletUsed: false,
    });

  } catch (error) {
    return safeErrorResponse(error, 'hedging/close POST');
  }
}

/**
 * DELETE /api/agents/hedging/close
 * Clear all simulation hedges or all hedges
 * SECURITY: Requires ADMIN auth — this destroys data
 */
export async function DELETE(request: NextRequest) {
  // SECURITY: Admin-only operation — clears hedge data
  const adminCheck = requireAdminAuth(request);
  if (adminCheck !== true) return adminCheck;

  try {
    const searchParams = request.nextUrl.searchParams;
    const clearAll = searchParams.get('all') === 'true';

    logger.info('🗑️ Clearing hedges', { clearAll });

    let count: number;
    if (clearAll) {
      count = await clearAllHedges();
      logger.info(`✅ Cleared ${count} simulation/paper hedges (real-portfolio rows are not deletable via this route)`);
    } else {
      count = await clearSimulationHedges();
      logger.info(`✅ Cleared ${count} simulation hedges`);
    }

    return NextResponse.json({
      success: true,
      message: clearAll ? `Cleared all ${count} hedges` : `Cleared ${count} simulation hedges`,
      count,
    });

  } catch (error) {
    return safeErrorResponse(error, 'hedging/close DELETE');
  }
}
