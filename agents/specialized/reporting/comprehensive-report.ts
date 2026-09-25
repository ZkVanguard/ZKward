/**
 * Comprehensive-report generator — orchestrates the 5 sub-reports and
 * assembles them into a single executive-summary payload with AI-driven
 * recommendations.
 */
import { AgentTask, TaskResult } from '@shared/types/agent';
import { logger } from '@shared/utils/logger';
import type {
  ComprehensiveReport, RiskReport, PerformanceReport,
  SettlementReport, PortfolioReport, AuditReport,
} from './types';
import { generateRiskReport } from './risk-report';
import { generatePerformanceReport } from './performance-report';
import { generateSettlementReport } from './settlement-report';
import { generatePortfolioReport } from './portfolio-report';
import { generateAuditReport } from './audit-report';
import { generateAIRecommendations } from './ai-recommendations';

export interface ComprehensiveReportOutput {
  result: TaskResult;
  reportId: string;
  report: ComprehensiveReport;
  /** Sub-reports the dispatcher may also want to persist to
   *  completedReports so exportReport(subReportId) works. */
  subReports: Array<{ reportId: string; report: RiskReport | PerformanceReport | SettlementReport | PortfolioReport | AuditReport }>;
}

export async function generateComprehensiveReport(
  task: AgentTask,
  agentId: string,
): Promise<ComprehensiveReportOutput> {
  const startTime = Date.now();
  const parameters = task.parameters as { startDate?: number; endDate?: number };
  const { startDate, endDate } = parameters;

  logger.info('Generating comprehensive report');

  const riskOut = await generateRiskReport({ ...task, action: 'generate_risk_report' }, agentId);
  const perfOut = await generatePerformanceReport({ ...task, action: 'generate_performance_report' }, agentId);
  const settlementOut = await generateSettlementReport({ ...task, action: 'generate_settlement_report' }, agentId);
  const portfolioOut = await generatePortfolioReport({ ...task, action: 'generate_portfolio_report' }, agentId);
  const auditOut = await generateAuditReport({ ...task, action: 'generate_audit_report' }, agentId);

  const report: ComprehensiveReport = {
    reportId: `comprehensive-${Date.now()}`,
    generatedAt: Date.now(),
    period: {
      start: startDate || Date.now() - 30 * 24 * 60 * 60 * 1000,
      end: endDate || Date.now(),
    },
    executiveSummary: {
      totalPortfolios: 1,
      totalValue: portfolioOut.report.overview?.totalValue || '0',
      overallReturn: perfOut.report.summary?.percentageReturn || 0,
      totalSettlements: settlementOut.report.summary?.totalSettlements || 0,
      systemHealth: 'GOOD',
    },
    riskReport: riskOut.report,
    performanceReport: perfOut.report,
    settlementReport: settlementOut.report,
    portfolioReports: [portfolioOut.report],
    auditReport: auditOut.report,
    recommendations: await generateAIRecommendations(riskOut.report, perfOut.report),
  };

  const reportId = report.reportId;
  return {
    reportId,
    report,
    subReports: [
      { reportId: riskOut.reportId, report: riskOut.report },
      { reportId: perfOut.reportId, report: perfOut.report },
      { reportId: settlementOut.reportId, report: settlementOut.report },
      { reportId: portfolioOut.reportId, report: portfolioOut.report },
      { reportId: auditOut.reportId, report: auditOut.report },
    ],
    result: {
      success: true,
      data: { reportId, report },
      error: null,
      executionTime: Date.now() - startTime,
      agentId,
    },
  };
}
