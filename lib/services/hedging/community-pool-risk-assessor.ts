/**
 * Community-pool risk assessment — Cronos EVM + SUI variants.
 *
 * Extracted from AutoHedgingService (2026-08-30). Both `assessCommunityPoolRisk`
 * and `assessSuiCommunityPoolRisk` were private methods that touched zero
 * `this` state — they just orchestrated calls to already-extracted services
 * (unified pool stats, market data, risk scoring, hedge-math). Pulling them
 * into their own module puts the two risk-assessment flows in one testable
 * place and drops ~510 LOC from AutoHedgingService.
 *
 * Behavior preserved verbatim. The AutoHedgingService class methods now
 * delegate here.
 */

import { logger } from '@/lib/utils/logger';
import { query } from '@/lib/db/postgres';
import { getAgentOrchestrator } from '../agent-orchestrator';
import { getMarketDataService } from '../market-data/RealMarketDataService';
import {
  COMMUNITY_POOL_PORTFOLIO_ID,
  COMMUNITY_POOL_ADDRESS,
  SUI_COMMUNITY_POOL_PORTFOLIO_ID,
} from '@/lib/constants';
import { getPoolStats as getUnifiedPoolStats } from '../CommunityPoolStatsService';
import {
  PredictionAggregatorService,
  type AggregatedPrediction,
} from '../market-data/PredictionAggregatorService';
import type { RiskAssessment } from './hedge-types';
import {
  calculateVolatility,
  calculateConcentrationRisk,
  generateHedgeRecommendations,
} from './hedge-risk-math';
import {
  computeCommunityPoolRiskScore,
  computeSuiPoolRiskScore,
} from './risk-scoring';

const INCEPTION_SHARE_PRICE = 1.0;

// ============================================================================
// SUI USDC community pool
// ============================================================================
export async function assessSuiCommunityPoolRisk(): Promise<RiskAssessment> {
  try {
    const { getSuiUsdcPoolService } = await import('@/lib/services/sui/SuiCommunityPoolService');
    const { getNavHistory } = await import('@/lib/db/community-pool');

    const network = (process.env.SUI_NETWORK || 'mainnet').trim().replace(/[\r\n]+/g, '') as
      | 'mainnet'
      | 'testnet';
    const suiService = getSuiUsdcPoolService(network);
    const poolStats = await suiService.getPoolStats();

    const marketNAV = poolStats.totalNAVUsd || poolStats.totalNAV;
    const marketSharePrice = poolStats.sharePriceUsd || poolStats.sharePrice;

    let peakSharePrice = INCEPTION_SHARE_PRICE;
    try {
      const navHistory = await getNavHistory(30, 'sui');
      if (navHistory && navHistory.length > 0) {
        const historicalPeak = Math.max(...navHistory.map((h) => h.share_price || 0));
        peakSharePrice = Math.max(peakSharePrice, historicalPeak, marketSharePrice);
      } else {
        peakSharePrice = Math.max(INCEPTION_SHARE_PRICE, marketSharePrice);
      }
    } catch {
      peakSharePrice = Math.max(INCEPTION_SHARE_PRICE, marketSharePrice);
    }
    const drawdownPercent =
      marketSharePrice < peakSharePrice
        ? ((peakSharePrice - marketSharePrice) / peakSharePrice) * 100
        : 0;

    const positions: Array<{
      symbol: string;
      value: number;
      change24h: number;
      balance: number;
      volatility?: number;
    }> = [];
    const marketDataService = getMarketDataService();
    const suiAssets = ['BTC', 'ETH', 'SUI', 'CRO'];
    const extendedPrices = await marketDataService.getExtendedPrices(suiAssets);

    for (const asset of suiAssets) {
      const priceData = extendedPrices.get(asset);
      if (priceData && priceData.price > 0) {
        const allocation = (poolStats as any).allocations?.[asset] || 25;
        const valueUSD = marketNAV * (allocation / 100);
        let volatility = 0.3;
        if (priceData.high24h > 0 && priceData.low24h > 0) {
          const range = priceData.high24h - priceData.low24h;
          const intradayVol = range / priceData.price;
          volatility = Math.max(0.01, Math.min(2.0, intradayVol * Math.sqrt(365)));
        }
        positions.push({
          symbol: asset,
          value: valueUSD,
          change24h: priceData.change24h || 0,
          balance: valueUSD / priceData.price,
          volatility,
        });
      }
    }

    const volatility = calculateVolatility(positions);
    const concentrationRisk = calculateConcentrationRisk(positions, marketNAV);

    const isBelowPar = marketSharePrice < INCEPTION_SHARE_PRICE;
    const sharePriceLossPercent = isBelowPar
      ? ((INCEPTION_SHARE_PRICE - marketSharePrice) / INCEPTION_SHARE_PRICE) * 100
      : 0;
    const { riskScore, contributions } = computeSuiPoolRiskScore({
      isBelowPar,
      sharePriceLossPercent,
      drawdownPercent,
      volatility,
      concentrationRisk,
      anyPosition24hNegative: positions.some((p) => p.change24h < -1),
    });
    logger.debug('[AutoHedging] sui-risk-score breakdown', { riskScore, contributions });

    let activeHedges: Array<{ asset: string; side: string; size: number; notionalValue: number }> = [];
    try {
      const hedgesResult = await query(
        `SELECT asset, side, size, notional_value FROM hedges WHERE portfolio_id = $1 AND status = 'active' AND chain = 'sui'`,
        [SUI_COMMUNITY_POOL_PORTFOLIO_ID],
      );
      activeHedges = hedgesResult.map((h) => ({
        asset: String(h.asset || ''),
        side: String(h.side || ''),
        size: parseFloat(String(h.size)) || 0,
        notionalValue: parseFloat(String(h.notional_value)) || 0,
      }));
    } catch (dbError) {
      logger.warn('[AutoHedging] Could not fetch SUI pool active hedges', { error: dbError });
    }

    const allocationPercentages: Record<string, number> = {};
    for (const p of positions) {
      allocationPercentages[p.symbol] = marketNAV > 0 ? (p.value / marketNAV) * 100 : 25;
    }

    const recommendations = generateHedgeRecommendations(
      positions,
      marketNAV,
      allocationPercentages,
      activeHedges,
      drawdownPercent,
      concentrationRisk,
    );

    logger.info('[AutoHedging] SUI CommunityPool risk assessment', {
      marketNAV: `$${marketNAV.toFixed(2)}`,
      sharePrice: marketSharePrice.toFixed(6),
      drawdownPercent: drawdownPercent.toFixed(2),
      volatility: volatility.toFixed(2),
      riskScore,
      activeHedges: activeHedges.length,
      recommendations: recommendations.length,
    });

    return {
      portfolioId: SUI_COMMUNITY_POOL_PORTFOLIO_ID,
      totalValue: marketNAV,
      drawdownPercent,
      volatility,
      riskScore,
      recommendations,
      timestamp: Date.now(),
    };
  } catch (error) {
    logger.error('[AutoHedging] SUI CommunityPool risk assessment failed', { error });
    return {
      portfolioId: SUI_COMMUNITY_POOL_PORTFOLIO_ID,
      totalValue: 0,
      drawdownPercent: 0,
      volatility: 0,
      riskScore: 5,
      recommendations: [],
      timestamp: Date.now(),
    };
  }
}

// ============================================================================
// Best-effort agent orchestrator pass — logged and swallowed.
// ============================================================================
async function runCommunityPoolAgentAnalysis(input: {
  positions: unknown[];
  allocationPercentages: Record<string, number>;
  marketNAV: number;
  drawdownPercent: number;
  volatility: number;
}): Promise<void> {
  try {
    const orchestrator = getAgentOrchestrator();
    const [riskAnalysis, hedgeAnalysis] = await Promise.all([
      orchestrator.assessRisk({
        address: COMMUNITY_POOL_ADDRESS,
        portfolioData: {
          portfolioId: COMMUNITY_POOL_PORTFOLIO_ID,
          type: 'community_pool',
          positions: input.positions,
          allocations: input.allocationPercentages,
          totalValue: input.marketNAV,
          drawdownPercent: input.drawdownPercent,
          volatility: input.volatility,
        },
      }),
      orchestrator.generateHedgeRecommendations({
        portfolioId: String(COMMUNITY_POOL_PORTFOLIO_ID),
        assetSymbol: (input.positions[0] as { symbol?: string })?.symbol || 'BTC',
        notionalValue: input.marketNAV,
      }),
    ]);

    logger.info('[AutoHedging] CommunityPool AI agents analysis complete', {
      riskAgentSuccess: riskAnalysis.success,
      hedgeAgentSuccess: hedgeAnalysis.success,
      riskAgentTime: `${riskAnalysis.executionTime}ms`,
      hedgeAgentTime: `${hedgeAnalysis.executionTime}ms`,
    });

    if (hedgeAnalysis.success && hedgeAnalysis.data) {
      const agentHedgeData = hedgeAnalysis.data as {
        recommendations?: Array<{ asset: string; action: string; confidence: number }>;
      };
      if (agentHedgeData.recommendations?.length) {
        logger.info('[AutoHedging] HedgingAgent provided recommendations for pool', {
          count: agentHedgeData.recommendations.length,
        });
      }
    }
  } catch (agentError) {
    logger.warn('[AutoHedging] Agent orchestrator analysis failed (continuing with manual assessment)', {
      error: agentError instanceof Error ? agentError.message : String(agentError),
    });
  }
}
