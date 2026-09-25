/**
 * Reporting Agent — dispatcher.
 *
 * The heavy lifting for each report type lives in `./reporting/*` — this
 * class just holds the pending + completed report maps and routes each
 * task action to the right generator. Types re-exported from
 * `./reporting/types` for backward compat with external importers.
 */

import { BaseAgent } from '../core/BaseAgent';
import { AgentCapability, AgentTask, TaskResult, AgentMessage } from '@shared/types/agent';
import { logger } from '@shared/utils/logger';
import { ethers } from 'ethers';

import { generateRiskReport } from './reporting/risk-report';
import { generatePerformanceReport } from './reporting/performance-report';
import { generateSettlementReport } from './reporting/settlement-report';
import { generatePortfolioReport } from './reporting/portfolio-report';
import { generateAuditReport } from './reporting/audit-report';
import { generateComprehensiveReport } from './reporting/comprehensive-report';
import { exportReport } from './reporting/export';

import type { ReportRequest } from './reporting/types';

// Re-exports for external consumers that imported types from this file
// pre-refactor.
export type {
  ReportRequest,
  RiskReport,
  PerformanceReport,
  SettlementReport,
  PortfolioReport,
  AuditReport,
  ComprehensiveReport,
} from './reporting/types';

export class ReportingAgent extends BaseAgent {
  private reports: Map<string, ReportRequest> = new Map();
  private completedReports: Map<string, unknown> = new Map();
  private static readonly MAX_COMPLETED_REPORTS = 500;

  /** Evict oldest reports when cap is exceeded. */
  private capCompletedReports(): void {
    if (this.completedReports.size > ReportingAgent.MAX_COMPLETED_REPORTS) {
      const keys = Array.from(this.completedReports.keys());
      for (let i = 0; i < keys.length - 400; i++) {
        this.completedReports.delete(keys[i]);
      }
    }
  }

  private store(reportId: string, report: unknown): void {
    this.completedReports.set(reportId, report);
    this.capCompletedReports();
  }

  constructor(agentId: string, private provider: ethers.Provider) {
    super(agentId, 'reporting', [
      AgentCapability.DATA_ANALYSIS,
      AgentCapability.REPORTING,
    ]);
    // provider retained for future on-chain reads from a generator that
    // needs a signer; currently unused.
    void this.provider;
  }

  protected async onInitialize(): Promise<void> {
    logger.info('ReportingAgent initialized', { agentId: this.agentId });
  }

  protected onMessageReceived(_message: AgentMessage): void {
    // Handle messages from other agents
  }

  protected async onShutdown(): Promise<void> {
    logger.info('ReportingAgent shutdown complete', { agentId: this.agentId });
  }

  protected async onExecuteTask(task: AgentTask): Promise<TaskResult> {
    const taskAction = task.action || task.type || '';
    logger.info('Executing reporting task', { taskId: task.id, action: taskAction });

    try {
      switch (taskAction) {
        case 'generate_risk_report':
        case 'generate-risk-report': {
          const out = await generateRiskReport(task, this.agentId);
          this.store(out.reportId, out.report);
          return out.result;
        }

        case 'generate_performance_report':
        case 'generate-performance-report': {
          const out = await generatePerformanceReport(task, this.agentId);
          this.store(out.reportId, out.report);
          return out.result;
        }

        case 'generate_settlement_report':
        case 'generate-settlement-report': {
          const out = await generateSettlementReport(task, this.agentId);
          this.store(out.reportId, out.report);
          return out.result;
        }

        case 'generate_portfolio_report':
        case 'generate-portfolio-report': {
          const out = await generatePortfolioReport(task, this.agentId);
          this.store(out.reportId, out.report);
          return out.result;
        }

        case 'generate_audit_report':
        case 'generate-audit-report': {
          const out = await generateAuditReport(task, this.agentId);
          this.store(out.reportId, out.report);
          return out.result;
        }

        case 'generate_comprehensive_report':
        case 'generate-comprehensive-report':
        case 'generate_report':
        case 'generate-report': {
          const out = await generateComprehensiveReport(task, this.agentId);
          // Store the composite + each sub-report so a later exportReport
          // can find any of them by ID (matches pre-refactor behavior).
          this.store(out.reportId, out.report);
          for (const sub of out.subReports) this.store(sub.reportId, sub.report);
          return out.result;
        }

        case 'export_report':
        case 'export-report':
          return await exportReport(task, this.agentId, (id) => this.completedReports.get(id));

        case 'list_reports':
        case 'list-reports':
          return this.listReports();

        default:
          // Graceful fallback: unknown actions get comprehensive.
          logger.warn(`Unknown reporting action: ${taskAction}, using generate_comprehensive_report fallback`, { taskId: task.id });
          const out = await generateComprehensiveReport(task, this.agentId);
          this.store(out.reportId, out.report);
          for (const sub of out.subReports) this.store(sub.reportId, sub.report);
          return out.result;
      }
    } catch (error) {
      logger.error('Task execution failed', { taskId: task.id, error });
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime: 0,
        agentId: this.agentId,
      };
    }
  }

  private listReports(): TaskResult {
    const startTime = Date.now();
    const reportList = Array.from(this.completedReports.keys()).map((reportId) => ({
      reportId,
      type: reportId.split('-')[0],
      createdAt: parseInt(reportId.split('-').slice(-1)[0], 10),
    }));
    return {
      success: true,
      data: { reports: reportList, total: reportList.length },
      error: null,
      executionTime: Date.now() - startTime,
      agentId: this.agentId,
    };
  }

  getReport(reportId: string): unknown {
    return this.completedReports.get(reportId);
  }

  /** Kept for future pending-report tracking. Currently unused externally. */
  private getPendingReports(): Map<string, ReportRequest> {
    return this.reports;
  }
}
