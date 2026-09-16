/**
 * Settlement Agent
 * Specialized agent for payment settlement and batch processing using x402
 */

import { BaseAgent } from '../core/BaseAgent';
import { AgentCapability, AgentTask, TaskResult, AgentMessage } from '@shared/types/agent';
import { X402Client, X402TransferResponse } from '@integrations/x402/X402Client';
import { ethers } from 'ethers';
import { logger } from '@shared/utils/logger';
import { agentSystemPrompt } from '../../lib/services/ai/model-constitution';

/** Extended client interface for duck-typing compatibility with varying implementations */
interface X402ClientExt {
  executeGaslessTransfer?: (params: Record<string, unknown>) => Promise<X402TransferResponse>;
  executeBatchTransfer?: (params: Record<string, unknown>) => Promise<X402TransferResponse>;
  batchTransfer?: (params: Record<string, unknown>) => Promise<X402TransferResponse>;
}

export interface SettlementRequest {
  requestId: string;
  portfolioId: string;
  beneficiary: string;
  amount: string;
  token: string;
  purpose: string;
  validAfter?: number;
  validBefore?: number;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  createdAt: number;
  processedAt?: number;
}

export interface BatchSettlement {
  batchId: string;
  requests: SettlementRequest[];
  totalAmount: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  transactionHash?: string;
  gaslessTransactionId?: string;
  createdAt: number;
  completedAt?: number;
}

export interface SettlementSchedule {
  scheduleId: string;
  frequency: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  minBatchSize: number;
  maxBatchSize: number;
  minAmount: string;
  active: boolean;
}

export interface SettlementReport {
  period: {
    start: number;
    end: number;
  };
  statistics: {
    totalSettlements: number;
    totalAmount: string;
    successRate: number;
    avgProcessingTime: number;
    gasSavings: string;
  };
  settlements: SettlementRequest[];
  batches: BatchSettlement[];
}

export class SettlementAgent extends BaseAgent {
  private x402Client: X402Client;
  private pendingSettlements: Map<string, SettlementRequest> = new Map();
  private completedSettlements: Map<string, SettlementRequest> = new Map();
  private batchHistory: Map<string, BatchSettlement> = new Map();
  private schedules: Map<string, SettlementSchedule> = new Map();
  private processingInterval?: NodeJS.Timeout;
  private static readonly MAX_COMPLETED = 1000;
  private static readonly MAX_BATCH_HISTORY = 500;

  /** Evict oldest entries to prevent unbounded memory growth */
  private capMaps(): void {
    if (this.completedSettlements.size > SettlementAgent.MAX_COMPLETED) {
      const keys = Array.from(this.completedSettlements.keys());
      for (let i = 0; i < keys.length - 800; i++) {
        this.completedSettlements.delete(keys[i]);
      }
    }
    if (this.batchHistory.size > SettlementAgent.MAX_BATCH_HISTORY) {
      const keys = Array.from(this.batchHistory.keys());
      for (let i = 0; i < keys.length - 400; i++) {
        this.batchHistory.delete(keys[i]);
      }
    }
  }

  constructor(
    agentId: string,
    private provider: ethers.Provider,
    private signer: ethers.Wallet | ethers.Signer,
    private paymentRouterAddress: string
  ) {
    super(agentId, 'settlement', [
      AgentCapability.PAYMENT_PROCESSING,
      AgentCapability.SETTLEMENT,
    ]);

    this.x402Client = new X402Client(provider);
  }

  /**
   * Initialize agent
   */
  protected async onInitialize(): Promise<void> {
    try {
      logger.info('SettlementAgent initialized', { agentId: this.agentId });
    } catch (error) {
      logger.error('Failed to initialize SettlementAgent', { error });
      throw error;
    }
  }
  
  /**
   * Handle incoming messages
   */
  protected onMessageReceived(_message: AgentMessage): void {
    // Handle messages from other agents
  }
  
  /**
   * Cleanup on shutdown
   */
  protected async onShutdown(): Promise<void> {
    try {
      // Stop automatic processing timer (defense in depth — shutdown() also calls stopAutomaticProcessing)
      this.stopAutomaticProcessing();
      logger.info('SettlementAgent shutdown complete', { agentId: this.agentId });
    } catch (error) {
      logger.error('Error during SettlementAgent shutdown', { error });
    }
  }

  /**
   * Execute task
   */
  protected async onExecuteTask(task: AgentTask): Promise<TaskResult> {
    // Support both 'action' and 'type' fields for compatibility with LeadAgent
    const taskAction = task.action || task.type || '';
    logger.info('Executing settlement task', { taskId: task.id, action: taskAction });

    try {
      switch (taskAction) {
        case 'create_settlement':
        case 'create-settlement':
          return await this.createSettlement(task);
        
        case 'process_settlement':
        case 'process-settlement':
        case 'settle_payments':
        case 'settle-payments':
          return await this.processSettlement(task);
        
        case 'batch_settlements':
        case 'batch-settlements':
          return await this.batchSettlements(task);
        
        case 'cancel_settlement':
        case 'cancel-settlement':
          return await this.cancelSettlement(task);
        
        case 'create_schedule':
        case 'create-schedule':
          return await this.createSchedule(task);
        
        case 'generate_report':
        case 'generate-report':
          return await this.generateReport(task);
        
        case 'check_status':
        case 'check-status':
          return await this.checkSettlementStatus(task);
        
        default:
          // Graceful fallback: process settlement for unknown settlement-related actions
          logger.warn(`Unknown settlement action: ${taskAction}, using process_settlement fallback`, { taskId: task.id });
          return await this.processSettlement(task);
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

  /**
   * Create settlement request
   */
  private async createSettlement(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = (task.parameters || task.payload || {}) as { portfolioId: string; beneficiary: string; amount: string; token: string; purpose: string; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'; validAfter?: number; validBefore?: number };
    const { portfolioId, beneficiary, amount, token, purpose, priority, validAfter, validBefore } = parameters;

    try {
      const crypto = await import('crypto');
      const settlement: SettlementRequest = {
        requestId: `settlement-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
        portfolioId,
        beneficiary,
        amount,
        token,
        purpose,
        priority: priority || 'MEDIUM',
        validAfter,
        validBefore,
        status: 'PENDING',
        createdAt: Date.now(),
      };

      this.pendingSettlements.set(settlement.requestId, settlement);

      logger.info('Settlement request created', {
        requestId: settlement.requestId,
        amount,
        beneficiary,
      });

      // Auto-process if urgent
      if (settlement.priority === 'URGENT') {
        await this.processSettlement({
          id: `process-${settlement.requestId}`,
          action: 'process_settlement',
          parameters: { requestId: settlement.requestId },
          priority: 5,
          createdAt: new Date(),
        });
      }

      return {
        success: true,
        data: settlement,
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to create settlement', { error });
      throw error;
    }
  }

  /**
   * Process individual settlement
   */
  private async processSettlement(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = (task.parameters || task.payload || {}) as Record<string, unknown>;
    const requestId = (parameters.requestId as string) || '';
    let resolvedRequestId = requestId;

    try {
      // If no requestId provided, try to process the first pending settlement
      let settlement;
      if (!requestId) {
        const pendingEntry = Array.from(this.pendingSettlements.entries()).find(
          ([, s]) => s.status === 'PENDING'
        );
        if (pendingEntry) {
          [resolvedRequestId, settlement] = pendingEntry;
        }
      } else {
        settlement = this.pendingSettlements.get(requestId);
      }

      if (!settlement) {
        if (requestId) {
          // Explicit requestId was given but not found
          throw new Error(`Settlement ${requestId} not found`);
        }
        // No requestId and no pending settlements — return success with empty result
        return {
          success: true,
          data: { message: 'No pending settlements to process' },
          error: null,
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      if (settlement.status !== 'PENDING') {
        throw new Error(`Settlement ${resolvedRequestId} already ${settlement.status}`);
      }

      logger.info('Processing settlement via x402 (GASLESS)', { requestId: resolvedRequestId });
      settlement.status = 'PROCESSING';

      // Execute TRUE gasless transfer via x402 Facilitator
      // NO GAS COSTS - x402 handles everything!
      const extClient = this.x402Client as unknown as X402ClientExt;
      let result: { txHash: string; [key: string]: unknown };
      if (typeof extClient.executeGaslessTransfer === 'function') {
        result = await extClient.executeGaslessTransfer({
          token: settlement.token,
          from: await this.signer.getAddress(),
          to: settlement.beneficiary,
          amount: settlement.amount,
        }) as unknown as { txHash: string; [key: string]: unknown };
      } else if (typeof extClient.batchTransfer === 'function') {
        result = await extClient.batchTransfer({
          token: settlement.token,
          from: await this.signer.getAddress(),
          to: settlement.beneficiary,
          amount: settlement.amount,
        }) as unknown as { txHash: string; [key: string]: unknown };
      } else {
        throw new Error('No compatible x402 transfer method available (executeGaslessTransfer or batchTransfer)');
      }

      settlement.status = 'COMPLETED';
      settlement.processedAt = Date.now();

      // Move to completed
      this.pendingSettlements.delete(resolvedRequestId);
      this.completedSettlements.set(resolvedRequestId, settlement);
      this.capMaps();

      logger.info('Settlement processed successfully', {
        requestId: resolvedRequestId,
        transactionId: result.txHash,
      });

      return {
        success: true,
        data: {
          requestId: resolvedRequestId,
          transactionId: result.txHash,
          status: 'COMPLETED',
          processingTime: Math.max(1, Date.now() - startTime),
        },
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to process settlement', { requestId: resolvedRequestId, error });
      
      const failedSettlement = this.pendingSettlements.get(resolvedRequestId);
      if (failedSettlement) {
        failedSettlement.status = 'FAILED';
      }
      
      throw error;
    }
  }

  /**
   * Batch multiple settlements
   */
  private async batchSettlements(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = (task.parameters || task.payload || {}) as { requestIds?: string[]; maxBatchSize?: number };
    const { requestIds, maxBatchSize } = parameters;

    try {
      // Get pending settlements
      const settlementsToProcess: SettlementRequest[] = [];
      
      if (requestIds) {
        // Specific settlements
        for (const id of requestIds) {
          const settlement = this.pendingSettlements.get(id);
          if (settlement && settlement.status === 'PENDING') {
            settlementsToProcess.push(settlement);
          }
        }
      } else {
        // All pending settlements
        for (const settlement of this.pendingSettlements.values()) {
          if (settlement.status === 'PENDING') {
            settlementsToProcess.push(settlement);
          }
        }
      }

      if (settlementsToProcess.length === 0) {
        return {
          success: true,
          data: { message: 'No settlements to process' },
          error: null,
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      // Sort by priority
      settlementsToProcess.sort((a, b) => {
        const priorityWeight = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
        return priorityWeight[b.priority] - priorityWeight[a.priority];
      });

      // Limit batch size
      const batchSize = maxBatchSize || 50;
      const batch = settlementsToProcess.slice(0, batchSize);

      logger.info('Processing batch settlements', { count: batch.length });

      // Group by token for efficient batching
      const tokenGroups = new Map<string, SettlementRequest[]>();
      for (const settlement of batch) {
        const group = tokenGroups.get(settlement.token) || [];
        group.push(settlement);
        tokenGroups.set(settlement.token, group);
      }

      // Process each token group as a batch via x402 (GASLESS)
      const results = [];
      for (const [token, settlements] of tokenGroups.entries()) {
        const batchRequest = {
          token,
          from: await this.signer.getAddress(),
          recipients: settlements.map(s => s.beneficiary),
          amounts: settlements.map(s => s.amount),
        };

        try {
          // Execute TRUE gasless batch via x402 - NO GAS COSTS!
          const batchExtClient = this.x402Client as unknown as X402ClientExt;
          const batchResult = typeof batchExtClient.executeBatchTransfer === 'function'
            ? await batchExtClient.executeBatchTransfer(batchRequest)
            : await (batchExtClient.batchTransfer ?? batchExtClient.executeBatchTransfer)!(batchRequest);
          
          // Update settlement statuses
          for (const settlement of settlements) {
            settlement.status = 'COMPLETED';
            settlement.processedAt = Date.now();
            this.pendingSettlements.delete(settlement.requestId);
            this.completedSettlements.set(settlement.requestId, settlement);
          }
          this.capMaps();

          results.push({
            token,
            count: settlements.length,
            transactionId: batchResult.txHash,
            status: 'COMPLETED',
          });
        } catch (error) {
          logger.error('Batch processing failed for token', { token, error });
          
          // Mark as failed
          for (const settlement of settlements) {
            settlement.status = 'FAILED';
          }
          
          results.push({
            token,
            count: settlements.length,
            status: 'FAILED',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // Create batch record
      const batchRecord: BatchSettlement = {
        batchId: `batch-${Date.now()}`,
        requests: batch,
        totalAmount: batch.reduce((sum, s) => { const v = parseFloat(s.amount); return sum + (isNaN(v) ? 0 : v); }, 0).toString(),
        status: results.every(r => r.status === 'COMPLETED') ? 'COMPLETED' : 'FAILED',
        createdAt: startTime,
        completedAt: Date.now(),
      };

      this.batchHistory.set(batchRecord.batchId, batchRecord);
      this.capMaps();

      logger.info('Batch settlements completed', {
        batchId: batchRecord.batchId,
        totalSettlements: batch.length,
        successCount: results.filter(r => r.status === 'COMPLETED').length,
      });

      return {
        success: true,
        data: {
          batchId: batchRecord.batchId,
          totalProcessed: batch.length,
          results,
          executionTime: Date.now() - startTime,
        },
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to batch settlements', { error });
      throw error;
    }
  }

  /**
   * Cancel settlement
   */
  private async cancelSettlement(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = (task.parameters || task.payload || {}) as Record<string, unknown>;
    const requestId = (parameters.requestId as string) || '';

    try {
      if (!requestId) {
        return {
          success: false,
          data: null,
          error: 'No requestId provided for cancellation',
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      const settlement = this.pendingSettlements.get(requestId);
      if (!settlement) {
        throw new Error(`Settlement ${requestId} not found`);
      }

      if (settlement.status !== 'PENDING') {
        throw new Error(`Cannot cancel settlement with status ${settlement.status}`);
      }

      this.pendingSettlements.delete(requestId);
      logger.info('Settlement cancelled', { requestId });

      return {
        success: true,
        data: { requestId, status: 'CANCELLED' },
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to cancel settlement', { requestId, error });
      throw error;
    }
  }

  /**
   * Create settlement schedule
   */
  private async createSchedule(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = (task.parameters || task.payload || {}) as { frequency?: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY'; minBatchSize?: number; maxBatchSize?: number; minAmount?: string };
    const { frequency, minBatchSize, maxBatchSize, minAmount } = parameters;

    try {
      const schedule: SettlementSchedule = {
        scheduleId: `schedule-${Date.now()}`,
        frequency: frequency || 'DAILY',
        minBatchSize: minBatchSize || 5,
        maxBatchSize: maxBatchSize || 50,
        minAmount: minAmount || '0',
        active: true,
      };

      this.schedules.set(schedule.scheduleId, schedule);

      logger.info('Settlement schedule created', { scheduleId: schedule.scheduleId });

      return {
        success: true,
        data: schedule,
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to create schedule', { error });
      throw error;
    }
  }

  /**
   * Generate settlement report
   */
  private async generateReport(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = (task.parameters || task.payload || {}) as { startDate?: number; endDate?: number };
    const { startDate, endDate } = parameters;

    try {
      const start = startDate || Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
      const end = endDate || Date.now();

      // Filter settlements by date range
      const settlements = Array.from(this.completedSettlements.values())
        .filter(s => s.createdAt >= start && s.createdAt <= end);

      // Filter batches by date range
      const batches = Array.from(this.batchHistory.values())
        .filter(b => b.createdAt >= start && b.createdAt <= end);

      // Calculate statistics
      const totalAmount = settlements.reduce((sum, s) => { const v = parseFloat(s.amount); return sum + (isNaN(v) ? 0 : v); }, 0);
      const successCount = settlements.filter(s => s.status === 'COMPLETED').length;
      const totalProcessingTime = settlements.reduce((sum, s) => 
        s.processedAt ? sum + (s.processedAt - s.createdAt) : sum, 0
      );

      // Estimate gas savings from batching
      const individualtxCost = 50000; // gas units
      const batchTxCost = 100000; // gas units for batch
      const savedGas = settlements.length * individualtxCost - batches.length * batchTxCost;

      const report: SettlementReport = {
        period: { start, end },
        statistics: {
          totalSettlements: settlements.length,
          totalAmount: totalAmount.toString(),
          successRate: settlements.length > 0 ? (successCount / settlements.length) * 100 : 0,
          avgProcessingTime: settlements.length > 0 ? totalProcessingTime / settlements.length : 0,
          gasSavings: savedGas.toString(),
        },
        settlements,
        batches,
      };

      logger.info('Settlement report generated', {
        period: report.period,
        totalSettlements: report.statistics.totalSettlements,
      });

      return {
        success: true,
        data: report,
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to generate report', { error });
      throw error;
    }
  }

  /**
   * Check settlement status
   */
  private async checkSettlementStatus(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = (task.parameters || task.payload || {}) as Record<string, unknown>;
    const requestId = (parameters.requestId as string) || '';

    try {
      if (!requestId) {
        return {
          success: false,
          data: null,
          error: 'No requestId provided for status check',
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      let settlement = this.pendingSettlements.get(requestId);
      if (!settlement) {
        settlement = this.completedSettlements.get(requestId);
      }

      if (!settlement) {
        throw new Error(`Settlement ${requestId} not found`);
      }

      return {
        success: true,
        data: settlement,
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to check settlement status', { requestId, error });
      throw error;
    }
  }

  /**
   * Independently evaluate a proposed execution and return a vote.
   * Called by LeadAgent during multi-agent consensus — the SettlementAgent
   * checks whether the execution is feasible from a settlement perspective
   * (risk level, position size, gas conditions).
   */
  async voteOnExecution(proposal: {
    executionId: string;
    action: string;
    estimatedPositionSize: number;
    riskAnalysis?: { totalRisk: number; volatility: number };
    chain?: string;
  }): Promise<{ approved: boolean; reason: string }> {
    try {
      const totalRisk = proposal.riskAnalysis?.totalRisk ?? 50;
      const positionSize = proposal.estimatedPositionSize;
      const chain = proposal.chain || 'cronos';

      // Settlement feasibility checks:
      //  - Risk ≥ 80 → too risky for automated settlement
      //  - Position > $10M → exceeds automated threshold
      //  - Check pending settlement queue isn't jammed
      //  - Non-Cronos chains: x402 settlement is Cronos-only, flag for manual review if large
      const isAnalysisOnly = proposal.action === 'analyze' || proposal.action === 'analysis';
      const riskOk = totalRisk < 80;
      const sizeOk = positionSize <= 10_000_000;
      const queueOk = this.pendingSettlements.size < 50;
      // x402 settlement only works on Cronos — non-Cronos chains with large positions need manual review
      const chainOk = chain === 'cronos' || isAnalysisOnly || positionSize <= 100_000;

      const approved = isAnalysisOnly || (riskOk && sizeOk && queueOk && chainOk);

      let reason: string;
      if (!chainOk) {
        reason = `Chain ${chain} not supported for automated x402 settlement (size: $${positionSize.toLocaleString()}) — needs manual review`;
      } else if (approved) {
        reason = `Settlement feasible on ${chain} (risk: ${totalRisk.toFixed(1)}, size: $${positionSize.toLocaleString()}, queue: ${this.pendingSettlements.size})`;
      } else {
        reason = `Settlement risk too high on ${chain} (risk: ${totalRisk.toFixed(1)}, size: $${positionSize.toLocaleString()}, queue: ${this.pendingSettlements.size})`;
      }

      logger.info('🗳️ SettlementAgent independent vote', {
        executionId: proposal.executionId,
        approved,
        chain,
        totalRisk,
        positionSize,
        pendingQueue: this.pendingSettlements.size,
        reason,
        agentId: this.agentId,
      });

      return { approved, reason };
    } catch (error) {
      logger.error('SettlementAgent vote failed — defaulting to cautious reject', { error, agentId: this.agentId });
      return { approved: false, reason: `Vote evaluation error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Start automatic processing based on schedules
   */
  startAutomaticProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }

    // Check every minute
    this.processingInterval = setInterval(async () => {
      try {
        for (const schedule of this.schedules.values()) {
          if (!schedule.active) continue;

          const pendingCount = this.pendingSettlements.size;
          
          // Check if we should process
          if (pendingCount >= schedule.minBatchSize) {
            this.enqueueTask({
              id: `auto-batch-${Date.now()}`,
              action: 'batch_settlements',
              parameters: { maxBatchSize: schedule.maxBatchSize },
              priority: 2,
              createdAt: new Date(),
            });
          }
        }
      } catch (error) {
        logger.error('Automatic processing error', { error });
      }
    }, 60000); // Every minute

    logger.info('Automatic settlement processing started');
  }

  /**
   * Stop automatic processing
   */
  stopAutomaticProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
      logger.info('Automatic settlement processing stopped');
    }
  }

  /**
   * Get AI-powered batch optimization recommendations
   */
  async getAIBatchOptimization(): Promise<{
    recommendation: string;
    optimalBatchSize: number;
    priorityOrder: string[];
    estimatedGasSavings: string;
  }> {
    const pendingList = Array.from(this.pendingSettlements.values());
    const completedList = Array.from(this.completedSettlements.values()).slice(-50);
    
    const defaultResult = {
      recommendation: 'Process settlements in priority order',
      optimalBatchSize: Math.min(pendingList.length, 20),
      priorityOrder: ['URGENT', 'HIGH', 'MEDIUM', 'LOW'],
      estimatedGasSavings: '100%', // x402 is gasless
    };

    if (pendingList.length === 0) {
      return { ...defaultResult, recommendation: 'No pending settlements' };
    }

    try {
      const { llmProvider } = await import('@/lib/ai/llm-provider');
      
      // Analyze pending settlements
      const urgentCount = pendingList.filter(s => s.priority === 'URGENT').length;
      const highCount = pendingList.filter(s => s.priority === 'HIGH').length;
      const totalAmount = pendingList.reduce((sum, s) => sum + parseFloat(s.amount), 0);
      const tokenTypes = [...new Set(pendingList.map(s => s.token))];
      
      // Analyze historical performance
      const avgProcessingTime = completedList.length > 0
        ? completedList.reduce((sum, s) => sum + ((s.processedAt || s.createdAt) - s.createdAt), 0) / completedList.length
        : 0;

      const systemPrompt = agentSystemPrompt(`You are a payment optimization specialist for x402 gasless settlements on Cronos zkEVM.`);

      const aiPrompt = `Optimize this settlement batch:

PENDING SETTLEMENTS:
- Total: ${pendingList.length}
- Urgent: ${urgentCount}, High: ${highCount}
- Total Amount: $${totalAmount.toLocaleString()}
- Token Types: ${tokenTypes.join(', ')}

HISTORICAL:
- Avg Processing Time: ${avgProcessingTime}ms
- Recent Completions: ${completedList.length}

Provide optimization in this EXACT format:
BATCH_SIZE: [number 1-50]
RECOMMENDATION: [one sentence optimization strategy]

Consider: x402 is 100% gasless, so optimize for speed and reliability, not gas.`;

      const aiResponse = await llmProvider.generateDirectResponse(aiPrompt, systemPrompt);
      
      // Parse response
      const batchMatch = aiResponse.content.match(/BATCH_SIZE:\s*(\d+)/i);
      const recMatch = aiResponse.content.match(/RECOMMENDATION:\s*(.+)/i);
      
      const optimalBatchSize = batchMatch ? Math.min(parseInt(batchMatch[1], 10), 50) : defaultResult.optimalBatchSize;
      const recommendation = recMatch ? `🤖 ${recMatch[1].trim()}` : defaultResult.recommendation;
      
      logger.info('🤖 AI settlement optimization generated', { 
        optimalBatchSize,
        model: aiResponse.model,
      });

      return {
        recommendation,
        optimalBatchSize,
        priorityOrder: urgentCount > 0 ? ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] : ['HIGH', 'MEDIUM', 'LOW', 'URGENT'],
        estimatedGasSavings: '100%', // x402 is gasless!
      };
    } catch (error) {
      logger.warn('AI batch optimization failed, using defaults', { error });
      return defaultResult;
    }
  }

  /**
   * Get pending settlements count
   */
  getPendingCount(): number {
    return this.pendingSettlements.size;
  }

  /**
   * Get completed settlements count
   */
  getCompletedCount(): number {
    return this.completedSettlements.size;
  }

  /**
   * Shutdown agent
   */
  async shutdown(): Promise<void> {
    this.stopAutomaticProcessing();
    await super.shutdown();
  }
}
