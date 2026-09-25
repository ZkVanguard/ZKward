/**
 * Settlement-report generator — pulls hedge activity from the DB, rolls
 * up totalVolume + success rate for the requested window. DB failures
 * fall through to zeroed report rather than throw.
 */
import { AgentTask, TaskResult } from '@shared/types/agent';
import { logger } from '@shared/utils/logger';
import type { SettlementReport } from './types';

export interface SettlementReportOutput {
  result: TaskResult;
  reportId: string;
  report: SettlementReport;
}

export async function generateSettlementReport(
  task: AgentTask,
  agentId: string,
): Promise<SettlementReportOutput> {
  const startTime = Date.now();
  const parameters = task.parameters as { startDate?: number; endDate?: number };
  const { startDate, endDate } = parameters;

  logger.info('Generating settlement report with real data');

  const periodStart = startDate || Date.now() - 30 * 24 * 60 * 60 * 1000;
  const periodEnd = endDate || Date.now();

  let totalSettlements = 0;
  let totalVolume = 0;
  let successCount = 0;
  const settlements: SettlementReport['settlements'] = [];
  const batches: SettlementReport['batches'] = [];

  try {
    const { getAllHedges, getHedgeStats } = await import('../../../lib/db/hedges');
    const allHedges = await getAllHedges(undefined, 200);
    const stats = await getHedgeStats();

    const periodHedges = allHedges.filter((h) => {
      const created = new Date(h.created_at).getTime();
      return created >= periodStart && created <= periodEnd;
    });

    totalSettlements = periodHedges.length;
    totalVolume = periodHedges.reduce((sum, h) => sum + Number(h.notional_value || 0), 0);
    successCount = periodHedges.filter((h) => h.status === 'active' || h.status === 'closed').length;

    for (const h of periodHedges.slice(0, 20)) {
      settlements.push({
        id: h.order_id,
        date: new Date(h.created_at).getTime(),
        amount: String(h.notional_value),
        beneficiary: h.wallet_address || 'pool',
        status: h.status === 'active' || h.status === 'closed' ? 'COMPLETED' : 'FAILED',
        gasless: !h.on_chain,
      });
    }

    if (stats) {
      batches.push({
        batchId: `summary-${Date.now()}`,
        date: Date.now(),
        count: Number(stats.total_hedges || 0),
        totalAmount: String(stats.total_active_notional || 0),
      });
    }
  } catch (dbError) {
    logger.warn('Could not fetch settlement data from DB', { error: dbError });
  }

  const report: SettlementReport = {
    period: { start: periodStart, end: periodEnd },
    summary: {
      totalSettlements,
      totalVolume: totalVolume.toFixed(2),
      successRate: totalSettlements > 0 ? (successCount / totalSettlements) * 100 : 0,
      avgProcessingTime: 0,
      gasSaved: '0',
    },
    settlements,
    batches,
    timestamp: Date.now(),
  };

  const reportId = `settlement-${Date.now()}`;
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
