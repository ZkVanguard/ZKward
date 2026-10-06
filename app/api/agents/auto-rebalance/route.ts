/**
 * Auto-Rebalancing API Route
 *
 * Endpoints:
 * - POST /api/agents/auto-rebalance?action=start
 * - POST /api/agents/auto-rebalance?action=stop
 * - POST /api/agents/auto-rebalance?action=enable
 * - POST /api/agents/auto-rebalance?action=disable
 * - POST /api/agents/auto-rebalance?action=trigger_assessment
 * - GET  /api/agents/auto-rebalance?action=status
 * - GET  /api/agents/auto-rebalance?action=assessment&portfolioId=3
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  autoRebalanceService,
  type AutoRebalanceConfig,
  type RebalanceFrequency,
} from '@/lib/services/AutoRebalanceService';
import { logger } from '@/lib/utils/logger';
import { requireAuth } from '@/lib/security/auth-middleware';
import { walletScopeDenial, type Auth } from './wallet-scope';
import { mutationLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
import {
  saveAutoRebalanceConfig,
  getAutoRebalanceConfig,
  deleteAutoRebalanceConfig,
  type AutoRebalanceConfig as StorageAutoRebalanceConfig,
} from '@/lib/storage/auto-rebalance-storage';
export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

async function walletScopeError(auth: Auth, action: string | null, portfolioId: unknown, walletAddress: unknown): Promise<NextResponse | null> {
  const denial = await walletScopeDenial(auth, action, portfolioId, walletAddress, async (id) => (await getAutoRebalanceConfig(id))?.walletAddress ?? null);
  return denial ? NextResponse.json({ success: false, error: denial }, { status: 403 }) : null;
}

/**
 * POST - Control auto-rebalancing service
 */
export async function POST(request: NextRequest) {
  // Rate limiting
  const limited = mutationLimiter.check(request);
  if (limited) return limited;

  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action');
    const body = await request.json().catch(() => ({}));

    // Authentication required for all auto-rebalance mutations
    const authResult = await requireAuth(request, body as Record<string, unknown>);
    if (authResult instanceof NextResponse) return authResult;

    const { portfolioId, walletAddress, config } = body;

    const scopeError = await walletScopeError(authResult, action, portfolioId, walletAddress);
    if (scopeError) return scopeError;

    switch (action) {
      case 'start':
        // Start the auto-rebalancing service
        await autoRebalanceService.start();
        return NextResponse.json({
          success: true,
          message: 'Auto-rebalancing service started',
          status: autoRebalanceService.getStatus(),
        });

      case 'stop':
        // Stop the auto-rebalancing service
        autoRebalanceService.stop();
        return NextResponse.json({
          success: true,
          message: 'Auto-rebalancing service stopped',
        });

      case 'enable':
        // Enable auto-rebalancing for a specific portfolio
        if (!portfolioId || !walletAddress) {
          return NextResponse.json(
            { success: false, error: 'portfolioId and walletAddress required' },
            { status: 400 }
          );
        }

        const rebalanceConfig: AutoRebalanceConfig = {
          portfolioId: parseInt(portfolioId, 10),
          walletAddress,
          enabled: true,
          threshold: config?.threshold || 2, // Default: 2% drift (lowered for active rebalancing)
          frequency: (config?.frequency || 'DAILY') as RebalanceFrequency,
          autoApprovalEnabled: config?.autoApprovalEnabled !== false, // Default: enabled
          autoApprovalThreshold: config?.autoApprovalThreshold || 200000000, // Default: $200M
          targetAllocations: config?.targetAllocations,
          lossProtection: config?.lossProtection, // Support loss/drawdown protection config
        };

        // Save to persistent storage (for Vercel Cron)
        await saveAutoRebalanceConfig({
          ...rebalanceConfig,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        // Also enable in in-memory service (for local dev)
        autoRebalanceService.enableForPortfolio(rebalanceConfig);

        // Make sure service is running
        await autoRebalanceService.start();

        return NextResponse.json({
          success: true,
          message: `Auto-rebalancing enabled for portfolio ${portfolioId}`,
          config: rebalanceConfig,
          status: autoRebalanceService.getStatus(),
        });

      case 'disable':
        // Disable auto-rebalancing for a specific portfolio
        if (!portfolioId) {
          return NextResponse.json(
            { success: false, error: 'portfolioId required' },
            { status: 400 }
          );
        }

        // Remove from persistent storage
        await deleteAutoRebalanceConfig(parseInt(portfolioId, 10));

        // Also disable in in-memory service
        autoRebalanceService.disableForPortfolio(parseInt(portfolioId, 10));

        return NextResponse.json({
          success: true,
          message: `Auto-rebalancing disabled for portfolio ${portfolioId}`,
        });

      case 'trigger_assessment':
        // Manually trigger rebalancing assessment for a portfolio
        if (!portfolioId || !walletAddress) {
          return NextResponse.json(
            { success: false, error: 'portfolioId and walletAddress required' },
            { status: 400 }
          );
        }

        const assessment = await autoRebalanceService.triggerAssessment(
          parseInt(portfolioId, 10),
          walletAddress
        );

        return NextResponse.json({
          success: true,
          assessment,
        });

      default:
        return NextResponse.json(
          {
            success: false,
            error: 'Invalid action. Use: start, stop, enable, disable, or trigger_assessment',
          },
          { status: 400 }
        );
    }
  } catch (error) {
    logger.error('[API] Auto-rebalance error', {
      error: error instanceof Error ? error.message : error,
    });

    return safeErrorResponse(error, 'Auto-rebalance action');
  }
}

/**
 * GET - Get status and assessments
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action');
    const portfolioId = searchParams.get('portfolioId');

    switch (action) {
      case 'status':
        // Get service status
        const status = autoRebalanceService.getStatus();
        return NextResponse.json({
          success: true,
          status,
        });

      case 'assessment':
        // Get last assessment for a portfolio
        if (!portfolioId) {
          return NextResponse.json(
            { success: false, error: 'portfolioId required' },
            { status: 400 }
          );
        }

        const assessment = autoRebalanceService.getLastAssessment(parseInt(portfolioId, 10));

        if (!assessment) {
          return NextResponse.json(
            {
              success: false,
              error: 'No assessment available for this portfolio',
            },
            { status: 404 }
          );
        }

        return NextResponse.json({
          success: true,
          assessment,
        });

      default:
        return NextResponse.json(
          { success: false, error: 'Invalid action. Use: status or assessment' },
          { status: 400 }
        );
    }
  } catch (error) {
    logger.error('[API] Auto-rebalance GET error', {
      error: error instanceof Error ? error.message : error,
    });

    return safeErrorResponse(error, 'Auto-rebalance status');
  }
}

/**
 * PATCH - Update existing auto-rebalance config (e.g., enable drawdown protection)
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const authResult = await requireAuth(request, body as Record<string, unknown>);
    if (authResult instanceof NextResponse) return authResult;

    const { portfolioId, walletAddress, lossProtection } = body;

    if (!portfolioId) {
      return NextResponse.json({ success: false, error: 'portfolioId required' }, { status: 400 });
    }

    const scopeError = await walletScopeError(authResult, 'patch', portfolioId, walletAddress);
    if (scopeError) return scopeError;

    // Get existing config or create new one
    let existingConfig = await getAutoRebalanceConfig(parseInt(portfolioId, 10));

    if (!existingConfig && walletAddress) {
      // Create new config with defaults
      existingConfig = {
        portfolioId: parseInt(portfolioId, 10),
        walletAddress,
        enabled: true,
        threshold: 2,
        frequency: 'DAILY' as RebalanceFrequency,
        autoApprovalEnabled: true,
        autoApprovalThreshold: 200000000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    if (!existingConfig) {
      return NextResponse.json(
        { success: false, error: 'Config not found. Provide walletAddress to create new config.' },
        { status: 404 }
      );
    }

    // Update with new loss protection config
    const updatedConfig: StorageAutoRebalanceConfig = {
      ...existingConfig,
      lossProtection: lossProtection ?? existingConfig.lossProtection,
      updatedAt: Date.now(),
    };

    // Save to persistent storage
    await saveAutoRebalanceConfig(updatedConfig);

    // Also update in-memory service
    autoRebalanceService.enableForPortfolio(updatedConfig);

    logger.info('[API] Updated auto-rebalance config', {
      portfolioId,
      lossProtection: updatedConfig.lossProtection,
    });

    return NextResponse.json({
      success: true,
      message: `Auto-rebalance config updated for portfolio ${portfolioId}`,
      config: updatedConfig,
    });
  } catch (error) {
    logger.error('[API] Auto-rebalance PATCH error', {
      error: error instanceof Error ? error.message : error,
    });

    return safeErrorResponse(error, 'Auto-rebalance config update');
  }
}
