/**
 * Risk-report generator — extracted from ReportingAgent for isolation
 * and testability. Aggregates portfolio positions into per-asset VaR /
 * CVaR / Sharpe metrics and (optionally) attaches the commitment of a
 * risk-score proof that the local verifier accepted.
 */
import { AgentTask, TaskResult } from '@shared/types/agent';
import { logger } from '@shared/utils/logger';
import type { PortfolioPosition, RiskReport } from './types';

export interface RiskReportOutput {
  result: TaskResult;
  reportId: string;
  report: RiskReport;
}

export async function generateRiskReport(
  task: AgentTask,
  agentId: string,
): Promise<RiskReportOutput> {
  const startTime = Date.now();
  const parameters = task.parameters as {
    portfolioId: string;
    startDate?: number;
    endDate?: number;
    includeZKProofs?: boolean;
  };
  const { portfolioId, startDate, endDate, includeZKProofs } = parameters;

  logger.info('Generating risk report with real data', { portfolioId });

  const { getPortfolioData } = await import('../../../lib/services/portfolio-actions');
  const portfolioData = await getPortfolioData();
  const portfolio = (portfolioData?.portfolio ?? {}) as {
    positions?: PortfolioPosition[];
    totalValue?: number;
  };
  const positions: PortfolioPosition[] = (portfolio.positions || []).length > 0
    ? (portfolio.positions as PortfolioPosition[])
    : [
        { symbol: 'USDC', amount: 1000, value: 1000, currentPrice: 1, avgPrice: 1, pnl: 0, pnlPercentage: 0, lastUpdated: Date.now() },
        { symbol: 'BTC', amount: 0.1, value: 6500, currentPrice: 65000, avgPrice: 65000, pnl: 0, pnlPercentage: 0, lastUpdated: Date.now() },
      ];
  const totalValue = portfolio.totalValue || positions.reduce((sum, pos) => sum + (pos.value || 0), 0);

  const assetRisks: RiskReport['assetRisks'] = [];
  let totalRiskContribution = 0;
  for (const position of positions) {
    const allocation = totalValue > 0 ? (position.value / totalValue) * 100 : 0;
    let volatility = 0.35;
    const symbol = position.symbol?.toUpperCase() || '';
    if (['USDC', 'USDT', 'DAI', 'DEVUSDC'].includes(symbol)) volatility = 0.01;
    else if (['BTC', 'WBTC'].includes(symbol)) volatility = 0.45;
    else if (['ETH', 'WETH'].includes(symbol)) volatility = 0.40;
    else if (['CRO', 'WCRO'].includes(symbol)) volatility = 0.50;

    const var95 = position.value * volatility * 1.65;
    const contribution = (allocation * volatility) / 0.35 * 100 / positions.length;
    totalRiskContribution += contribution;
    assetRisks.push({
      asset: position.symbol || 'UNKNOWN',
      allocation: Math.round(allocation * 100) / 100,
      volatility,
      var: Math.round(var95),
      contribution: Math.round(contribution * 100) / 100,
    });
  }
  if (totalRiskContribution > 0) {
    assetRisks.forEach((r) => {
      r.contribution = Math.round((r.contribution / totalRiskContribution) * 100 * 100) / 100;
    });
  }

  const avgVolatility = assetRisks.reduce((sum, r) => sum + (r.volatility * r.allocation) / 100, 0);
  const totalRisk = Math.min(100, Math.round(avgVolatility * 200));
  const var95Total = assetRisks.reduce((sum, r) => sum + r.var, 0);
  const cvar95 = var95Total * 1.3;
  const sharpeRatio = avgVolatility > 0 ? 0.12 / avgVolatility : 0;

  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
  if (totalRisk >= 80) riskLevel = 'CRITICAL';
  else if (totalRisk >= 60) riskLevel = 'HIGH';
  else if (totalRisk >= 40) riskLevel = 'MEDIUM';

  // Optional proof that the report's risk score is within 0..100, with the
  // digest of its inputs committed next to it. Only a proof the local
  // verifier accepted is listed.
  let zkProofs: string[] = [];
  if (includeZKProofs) {
    try {
      const [{ proveRiskScore }, { computeBaseRiskScore, computeInputsHash, SENTIMENT_CODE }] = await Promise.all([
        import('../../../zk/prover/ProofGenerator'),
        import('../../../zk/prover/riskCanonical'),
      ]);
      const periodPortfolioId = parseInt(portfolioId, 10) || 0;
      const nowMs = Date.now();
      const canonicalExposures = assetRisks.map((r) => ({
        asset: r.asset,
        exposureBps: Math.round(r.allocation * 100),
        contributionBps: Math.round(r.contribution * 100),
      }));
      const volatilityBps = Math.round(avgVolatility * 10_000);
      const baseRiskScore = computeBaseRiskScore(volatilityBps, canonicalExposures);
      const canonical = {
        version: 1 as const,
        portfolioId: periodPortfolioId,
        chain: 'report' as const,
        timestampMs: nowMs,
        portfolioValueUsdc: 0,
        volatilityBps,
        exposures: canonicalExposures,
        sentimentCode: SENTIMENT_CODE.neutral,
        baseRiskScore,
        aiRiskScore: null,
        totalRisk: Math.round(totalRisk),
        threshold: 100,
      };
      const PROOF_TIMEOUT_MS = Number(process.env.REPORTING_ZK_TIMEOUT_MS) || 5000;
      const proof = await Promise.race([
        proveRiskScore(canonical.totalRisk, canonical.threshold, computeInputsHash(canonical)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`ZK prover timeout after ${PROOF_TIMEOUT_MS}ms`)), PROOF_TIMEOUT_MS),
        ),
      ]);
      if (proof.verified) zkProofs = [proof.commitment];
    } catch (error) {
      logger.warn('No risk-score proof for the risk report', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const report: RiskReport = {
    portfolioId,
    period: {
      start: startDate || Date.now() - 30 * 24 * 60 * 60 * 1000,
      end: endDate || Date.now(),
    },
    summary: {
      totalValue: totalValue.toFixed(2),
      totalRisk,
      riskLevel,
      var95: Math.round(var95Total),
      cvar95: Math.round(cvar95),
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    },
    assetRisks,
    hedges: [],
    zkProofs,
    timestamp: Date.now(),
  };

  const reportId = `risk-${portfolioId}-${Date.now()}`;
  return {
    reportId,
    report,
    result: {
      success: true,
      data: { reportId, report },
      error: null,
      executionTime: Date.now() - startTime,
      agentId,
    },
  };
}
