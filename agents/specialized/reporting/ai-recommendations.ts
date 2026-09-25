/**
 * AI-recommendations helper — used by generateComprehensiveReport to
 * produce prioritized recommendations from the risk + performance
 * sub-reports. Falls back to rule-based recommendations if the LLM is
 * unreachable or times out.
 */
import { logger } from '@shared/utils/logger';
import { agentSystemPrompt } from '../../../lib/services/ai/model-constitution';
import type { RiskReport, PerformanceReport, ComprehensiveReport } from './types';

export async function generateAIRecommendations(
  riskReport: RiskReport,
  perfReport: PerformanceReport,
): Promise<ComprehensiveReport['recommendations']> {
  const defaultRecommendations: ComprehensiveReport['recommendations'] = [
    {
      priority: 'MEDIUM',
      category: 'GENERAL',
      recommendation: 'Monitor portfolio regularly',
      rationale: 'Standard portfolio management best practice',
    },
  ];

  try {
    const { reason } = await import('@/lib/services/ai/reasoner');

    const topRiskAssets = riskReport.assetRisks
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
      .map((a) => `${a.asset} (${a.contribution.toFixed(1)}% risk, ${a.allocation.toFixed(1)}% allocation, ${(a.volatility * 100).toFixed(0)}% vol)`)
      .join(', ');

    const systemPrompt = agentSystemPrompt(
      `You are a DeFi portfolio strategist for an AI-managed prediction-market alpha vault on Sui mainnet. Provide actionable, data-driven recommendations grounded in the current per-asset signal state and live positions.`,
    );

    const aiPrompt = `Analyze this portfolio and provide 3 prioritized recommendations:

RISK METRICS:
- Total Risk Score: ${riskReport.summary.totalRisk}/100 (${riskReport.summary.riskLevel})
- 95% VaR: $${riskReport.summary.var95.toLocaleString()}
- 95% CVaR: $${riskReport.summary.cvar95.toLocaleString()}
- Sharpe Ratio: ${riskReport.summary.sharpeRatio}
- Portfolio Value: $${riskReport.summary.totalValue}

TOP RISK CONTRIBUTORS:
${topRiskAssets}

PERFORMANCE:
- Return: ${perfReport.summary.percentageReturn.toFixed(2)}%
- Max Drawdown: ${perfReport.summary.maxDrawdown.toFixed(2)}%
- Win Rate: ${perfReport.summary.winRate.toFixed(1)}%

Respond in this EXACT format (3 recommendations):
HIGH|CATEGORY|recommendation text|rationale
MEDIUM|CATEGORY|recommendation text|rationale
LOW|CATEGORY|recommendation text|rationale

Categories: RISK_MANAGEMENT, HEDGING, DIVERSIFICATION, REBALANCING, OPTIMIZATION`;

    // Hard cap LLM round-trip so tests + request paths can't hang if ASI is slow.
    const LLM_DEADLINE_MS = Number((process.env.REPORTING_AGENT_LLM_TIMEOUT_MS || '15000').trim()) || 15000;
    const aiResponse = await Promise.race([
      reason({ systemPrompt, userPrompt: aiPrompt, maxIterations: 1 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`llm timeout after ${LLM_DEADLINE_MS}ms`)), LLM_DEADLINE_MS),
      ),
    ]);
    if (!aiResponse.ok || !aiResponse.text) {
      throw new Error(aiResponse.error || 'reason() returned no text');
    }

    const recommendations: ComprehensiveReport['recommendations'] = [];
    const lines = aiResponse.text.split('\n').filter((l) => l.includes('|'));
    for (const line of lines.slice(0, 3)) {
      const parts = line.split('|').map((p) => p.trim());
      if (parts.length >= 4) {
        const priority = parts[0].toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW';
        if (['HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
          recommendations.push({
            priority,
            category: parts[1] || 'GENERAL',
            recommendation: parts[2] || 'Review portfolio',
            rationale: parts[3] || 'AI-generated insight',
          });
        }
      }
    }

    if (recommendations.length > 0) {
      logger.info('🤖 AI recommendations generated', {
        count: recommendations.length,
        elapsedMs: aiResponse.elapsedMs,
      });
      return recommendations;
    }

    logger.warn('Could not parse AI recommendations, using defaults');
    return defaultRecommendations;
  } catch (error) {
    logger.warn('AI recommendation generation failed, using rule-based fallback', { error });

    const recommendations: ComprehensiveReport['recommendations'] = [];
    if (riskReport.summary.riskLevel === 'CRITICAL') {
      recommendations.push({
        priority: 'HIGH',
        category: 'RISK_MANAGEMENT',
        recommendation: 'Reduce portfolio risk immediately',
        rationale: `Risk score ${riskReport.summary.totalRisk}/100 exceeds safe thresholds`,
      });
    }
    const topContributor = riskReport.assetRisks.sort((a, b) => b.contribution - a.contribution)[0];
    if (topContributor && topContributor.contribution > 50) {
      recommendations.push({
        priority: 'HIGH',
        category: 'DIVERSIFICATION',
        recommendation: `Reduce ${topContributor.asset} concentration`,
        rationale: `${topContributor.asset} contributes ${topContributor.contribution.toFixed(1)}% of total risk`,
      });
    }
    if (perfReport.summary.percentageReturn < 0) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'OPTIMIZATION',
        recommendation: 'Review underperforming positions',
        rationale: `Portfolio return is ${perfReport.summary.percentageReturn.toFixed(2)}%`,
      });
    }
    return recommendations.length > 0 ? recommendations : defaultRecommendations;
  }
}
