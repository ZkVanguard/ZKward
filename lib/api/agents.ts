/**
 * Frontend fetch wrappers for the agent API routes.
 * For risk/hedge analysis, call fetchRiskAnalysis / fetchHedgeRecommendations
 * from lib/services/ai-decisions directly (cached).
 */

import { AgentTask as SharedAgentTask } from '../../shared/types/agent';
import { logger } from '@/lib/utils/logger';

// Re-export for backward compatibility
export type AgentTask = SharedAgentTask;

/**
 * Generate portfolio report
 */
export async function generatePortfolioReport(address: string, period: string) {
  const response = await fetch(`/api/agents/reporting/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, period })
  });
  return response.json();
}

/**
 * Get agent activity - combines real activity from localStorage with API
 */
export async function getAgentActivity(_address: string) {
  // Get real activity from localStorage (hedge settlements, etc.)
  const activities: Array<{
    id: string;
    agentName: string;
    agentType: string;
    action: string;
    description: string;
    status: 'completed' | 'in-progress' | 'queued';
    timestamp: Date;
    type: string;
    priority: number;
    createdAt: Date;
  }> = [];
  
  // Check localStorage for settlement history (real hedge operations)
  if (typeof window !== 'undefined') {
    try {
      const settlements = localStorage.getItem('settlement_history');
      if (settlements) {
        interface SettlementBatch {
          type: string;
          managerSignature?: string;
          timestamp: string;
          status?: string;
          batchId: string;
          hedgeDetails?: { type?: string; asset?: string };
          closedAt?: string;
          finalPnL?: number;
        }
        const settlementData = JSON.parse(settlements) as Record<string, SettlementBatch>;
        Object.values(settlementData).forEach((batch) => {
          if (batch.type === 'hedge' && batch.managerSignature) {
            const timestamp = new Date(batch.timestamp);
            const isClosed = batch.status === 'closed';
            
            // Add hedge creation activity
            activities.push({
              id: `hedge-${batch.batchId}`,
              agentName: 'Hedging Agent',
              agentType: 'hedging',
              action: 'Execute Hedge',
              description: `${batch.hedgeDetails?.type || 'SHORT'} ${batch.hedgeDetails?.asset || 'BTC-PERP'} position ${isClosed ? 'closed' : 'opened'}`,
              status: isClosed ? 'completed' : 'in-progress',
              timestamp,
              type: 'hedging',
              priority: 1,
              createdAt: timestamp,
            });
            
            // Add settlement activity if closed
            if (isClosed && batch.closedAt) {
              activities.push({
                id: `settle-${batch.batchId}`,
                agentName: 'Settlement Agent',
                agentType: 'settlement',
                action: 'Close Position',
                description: `Settled ${batch.hedgeDetails?.asset || 'BTC-PERP'} with P/L: ${batch.finalPnL?.toFixed(2) || '0'} USDC`,
                status: 'completed',
                timestamp: new Date(batch.closedAt),
                type: 'settlement',
                priority: 1,
                createdAt: new Date(batch.closedAt),
              });
            }
          }
        });
      }
    } catch (e) {
      logger.error('Error reading settlement history', e);
    }
  }
  
  // Sort by timestamp descending (most recent first)
  activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  
  // If no real activities, show idle state
  if (activities.length === 0) {
    return [{
      id: 'idle',
      agentName: 'System',
      agentType: 'system',
      action: 'Monitoring',
      description: 'AI agents standing by - use chat to analyze portfolio or create hedges',
      status: 'completed' as const,
      timestamp: new Date(),
      type: 'system',
      priority: 0,
      createdAt: new Date(),
    }];
  }
  
  return activities;
}

