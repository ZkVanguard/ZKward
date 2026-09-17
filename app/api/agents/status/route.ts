import { NextRequest, NextResponse } from 'next/server';
import { readLimiter } from '@/lib/security/rate-limiter';
import { getAgentOrchestrator } from '@/lib/services/agent-orchestrator';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { logger } from '@/lib/utils/logger';

export const runtime = 'nodejs';

export const maxDuration = 30;
/**
 * Agent Orchestrator Status API
 * Check real-time agent status and capabilities
 */
export async function GET(request: NextRequest) {
  const rateLimited = readLimiter.check(request);
  if (rateLimited) return rateLimited;

  try {
    const orchestrator = getAgentOrchestrator();
    const status = orchestrator.getStatus();

    return NextResponse.json({
      orchestrator: {
        initialized: status.initialized,
        signerAvailable: status.signerAvailable,
      },
      agents: {
        risk: {
          available: status.agents.risk,
          capabilities: ['portfolio_analysis', 'risk_assessment', 'var_calculation'],
        },
        hedging: {
          available: status.agents.hedging,
          capabilities: ['hedge_analysis', 'position_opening', 'moonlander_integration'],
        },
        reporting: {
          available: status.agents.reporting,
          capabilities: ['daily_reports', 'weekly_reports', 'custom_analytics'],
        },
        lead: {
          available: status.agents.lead,
          capabilities: ['task_coordination', 'agent_orchestration'],
        },
      },
      integrations: {
        x402: { enabled: true },
        moonlander: { enabled: true },
        cryptocomAI: { enabled: true },
        mcp: { enabled: true },
      },
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30',
      },
    });
  } catch (error) {
    logger.error('Status check failed:', error);
    return safeErrorResponse(error, 'Agent status check');
  }
}

/**
 * Initialize orchestrator manually
 */
export async function POST(request: NextRequest) {
  // Admin auth required to reinitialize orchestrator
  const { requireAdminAuth } = await import('@/lib/security/auth-middleware');
  const authCheck = requireAdminAuth(request);
  if (authCheck instanceof NextResponse) return authCheck;

  try {
    const body = await request.json();
    const { force = false } = body;

    const orchestrator = getAgentOrchestrator();
    
    if (force) {
      // Force re-initialization
      await orchestrator.initialize();
    }

    const status = orchestrator.getStatus();

    return NextResponse.json({
      success: true,
      message: 'Orchestrator initialized',
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Orchestrator initialization failed:', error);
    return safeErrorResponse(error, 'Orchestrator initialization');
  }
}
