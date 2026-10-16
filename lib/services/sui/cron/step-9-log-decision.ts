/**
 * Step 9: Log AI decision to transaction history.
 *
 * Extracted verbatim from app/api/cron/sui-community-pool/route.ts (was
 * lines 759-796 pre-extraction). Persists an AI_DECISION row into the
 * pool_transactions table so the audit trail can surface the *why*
 * behind each allocation (used by /api/debug/sui-pool-status and by the
 * reporting agent).
 *
 * Best-effort — logs a warn and continues if the DB write fails.
 */
import { randomBytes } from 'crypto';
import { logger } from '@/lib/utils/logger';
import { addPoolTransactionToDb } from '@/lib/db/community-pool';
import type { AllocationDecision } from '@/agents/specialized/SuiPoolAgent';
import type { SuiUsdcPoolStats } from '@/lib/types/sui-pool-types';

export interface Step9Input {
  navUsd: number;
  sharePriceUsd: number;
  poolStats: SuiUsdcPoolStats;
  pricesUSD: Record<string, number>;
  aiResult: AllocationDecision;
  enhancedContext: {
    marketSentiment?: string;
    urgency?: string;
    predictionSignals?: Array<{ market: string; signal: string; probability: number }>;
    riskAlerts?: string[];
    correlationInsight?: string;
    recommendations?: string[];
  };
  rebalanceSwaps: unknown;
  /** Swaps that actually executed this run; the row says REBALANCE only when one did. */
  swapsExecuted: number;
}

export async function runStep9LogDecision(input: Step9Input): Promise<void> {
  const { navUsd, sharePriceUsd, poolStats, pricesUSD, aiResult, enhancedContext, rebalanceSwaps, swapsExecuted } = input;
  try {
    const decisionId = `sui_ai_${Date.now()}_${randomBytes(4).toString('hex')}`;
    await addPoolTransactionToDb({
      id: decisionId,
      type: 'AI_DECISION',
      chain: 'sui',
      details: {
        chain: 'sui',
        agent: 'SuiPoolAgent',
        enhanced: Object.keys(enhancedContext).length > 0,
        // What ran, not what the agent proposed: a paused pool once logged 170 REBALANCE rows a day with no swap.
        action: swapsExecuted > 0 ? 'REBALANCE' : 'HOLD',
        executed: swapsExecuted > 0,
        proposed: aiResult.shouldRebalance ? 'REBALANCE' : 'HOLD',
        allocations: aiResult.allocations,
        confidence: aiResult.confidence,
        reasoning: aiResult.reasoning,
        swappableAssets: aiResult.swappableAssets,
        hedgedAssets: aiResult.hedgedAssets,
        riskScore: aiResult.riskScore,
        prices: pricesUSD,
        rebalanceQuotes: rebalanceSwaps,
        poolNAV_USDC: navUsd,
        poolSharePrice: sharePriceUsd,
        memberCount: poolStats.memberCount,
        ...(enhancedContext.marketSentiment && { marketSentiment: enhancedContext.marketSentiment }),
        ...(enhancedContext.urgency && { urgency: enhancedContext.urgency }),
        ...(enhancedContext.predictionSignals && { predictionSignals: enhancedContext.predictionSignals }),
        ...(enhancedContext.riskAlerts?.length && { riskAlerts: enhancedContext.riskAlerts }),
        ...(enhancedContext.correlationInsight && { correlationInsight: enhancedContext.correlationInsight }),
        // Persist the recommendations list so /api/debug/sui-pool-status
        // can surface tilt explanations like "Synthetic STRONG UP on BTC"
        // and "Drift-fusion alignment UP 100% across 4 assets" — without
        // this, the audit trail loses the *why* behind each allocation.
        ...(enhancedContext.recommendations?.length && { recommendations: enhancedContext.recommendations }),
      },
    });
  } catch (txErr) {
    logger.warn('[SUI Cron] Transaction log failed (non-critical)', { error: txErr });
  }
}
