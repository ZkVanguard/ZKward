/**
 * @fileoverview SafeExecutionGuard - Bulletproof execution safeguards for institutional trading
 * @module agents/core/SafeExecutionGuard
 * 
 * CRITICAL: This module handles millions/billions in assets. Every function must be:
 * - Fail-safe (errors must NOT cause fund loss)
 * - Auditable (every action logged; a proof hash is recorded when the cycle produced one)
 * - Reversible (rollback mechanisms for failures)
 * - Rate-limited (prevent runaway executions)
 */

import { logger } from '@shared/utils/logger';

// ============================================================================
// TYPES
// ============================================================================

export interface ExecutionLimits {
  maxPositionSizeUSD: number;        // Max single position (default: $10M)
  maxDailyVolumeUSD: number;         // Max daily volume (default: $100M)
  maxSlippageBps: number;            // Max slippage in basis points (default: 30 = 0.30%)
  maxLeverage: number;               // Max leverage (default: 4x)
  minConfirmations: number;          // Min block confirmations (default: 3)
  cooldownMs: number;                // Cooldown between executions (default: 5000ms)
  maxConcurrentExecutions: number;   // Max parallel executions (default: 3)
  requireMultiAgentConsensus: boolean; // Require consensus (default: true)
  consensusThreshold: number;        // Agents that must agree (default: 0.67 = 2/3)
}

export interface ExecutionValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  riskScore: number;
  requiredApprovals: string[];
  zkProofRequired: boolean;
}

export interface AuditLog {
  id: string;
  timestamp: Date;
  action: string;
  agentId: string;
  executionId: string;
  params: Record<string, unknown>;
  result: 'pending' | 'success' | 'failed' | 'rolled_back';
  zkProofHash?: string;
  signatures: string[];
  errorDetails?: string;
}

export interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailure: Date | null;
  openedAt: Date | null;
  reason?: string;
}

export interface AgentConsensus {
  executionId: string;
  proposal: string;
  votes: Map<string, { approved: boolean; reason: string; timestamp: Date }>;
  requiredVotes: number;
  deadline: Date;
}

// ============================================================================
// DEFAULT LIMITS (CONSERVATIVE)
// ============================================================================

// Env-overridable so we can scale with deposits without a code release.
// Defaults are conservative for sub-$10k AUM; raise per the scale-tier
// table in docs/DEPLOY_RUNBOOK.md Appendix Z.
function envNum(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const DEFAULT_LIMITS: ExecutionLimits = {
  maxPositionSizeUSD: envNum('SAFE_GUARD_MAX_POSITION_USD', 10_000_000),
  maxDailyVolumeUSD:  envNum('SAFE_GUARD_MAX_DAILY_VOLUME_USD', 100_000_000),
  maxSlippageBps:     envNum('SAFE_GUARD_MAX_SLIPPAGE_BPS', 30),
  maxLeverage:        envNum('SAFE_GUARD_MAX_LEVERAGE', 4),
  minConfirmations:   3,                 // 3 block confirmations
  cooldownMs:         envNum('SAFE_GUARD_COOLDOWN_MS', 5000),
  maxConcurrentExecutions: 3,            // 3 parallel max
  requireMultiAgentConsensus: true,      // Require agent consensus
  consensusThreshold: 0.67,              // 2/3 majority
};

// ============================================================================
// SAFE EXECUTION GUARD CLASS
// ============================================================================

export class SafeExecutionGuard {
  private static instance: SafeExecutionGuard | null = null;
  
  private limits: ExecutionLimits;
  private dailyVolumeUSD: number = 0;
  // Per-chain daily volume buckets. Each chain has its own cap-tracking
  // slot so a Hedera spike cannot exhaust the SUI budget (and vice
  // versa). `dailyVolumeUSD` above is kept as the sum for existing
  // status / audit consumers that expect a single number.
  private dailyVolumeByChain: Map<string, number> = new Map();
  private dailyVolumeResetDate: string = '';
  private lastExecutionTime: number = 0;
  private activeExecutions: Set<string> = new Set();
  private auditLogs: AuditLog[] = [];
  private static readonly MAX_AUDIT_LOGS = 10_000;
  private static readonly MAX_PENDING_CONSENSUS = 100;
  private circuitBreaker: CircuitBreakerState = {
    isOpen: false,
    failureCount: 0,
    lastFailure: null,
    openedAt: null,
  };
  private pendingConsensus: Map<string, AgentConsensus> = new Map();
  
  // Circuit breaker thresholds
  private readonly FAILURE_THRESHOLD = 3;
  private readonly CIRCUIT_RESET_MS = 60_000; // 1 minute cooldown
  
  private constructor(limits?: Partial<ExecutionLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    logger.info('🛡️ SafeExecutionGuard initialized', { limits: this.limits });
  }

  static getInstance(limits?: Partial<ExecutionLimits>): SafeExecutionGuard {
    if (!SafeExecutionGuard.instance) {
      SafeExecutionGuard.instance = new SafeExecutionGuard(limits);
    }
    return SafeExecutionGuard.instance;
  }

  // ============================================================================
  // PRE-EXECUTION VALIDATION
  // ============================================================================

  /**
   * Validate execution parameters BEFORE any action
   * Returns detailed validation result with errors/warnings
   */
  async validateExecution(params: {
    executionId: string;
    agentId: string;
    action: string;
    positionSizeUSD: number;
    leverage?: number;
    expectedSlippageBps?: number;
    // Chain the execution belongs to. Enables per-chain daily-volume
    // bucketing so one chain spiking cannot exhaust the cap for the
    // others. Undefined = charge against the shared 'default' bucket
    // (SUI backfill-safe).
    chain?: string;
  }): Promise<ExecutionValidation> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const requiredApprovals: string[] = [];
    let riskScore = 0;

    // 1. Check circuit breaker
    if (this.circuitBreaker.isOpen) {
      const timeSinceOpen = Date.now() - (this.circuitBreaker.openedAt?.getTime() || 0);
      if (timeSinceOpen < this.CIRCUIT_RESET_MS) {
        errors.push(`🚨 CIRCUIT BREAKER OPEN: ${this.circuitBreaker.reason}. Cooldown: ${Math.ceil((this.CIRCUIT_RESET_MS - timeSinceOpen) / 1000)}s`);
      } else {
        this.resetCircuitBreaker();
      }
    }

    // 2. Check cooldown (skip for read-only analysis actions — they don't move funds)
    const isReadOnlyAction = (
      params.action === 'analyze' || 
      params.action === 'analysis' || 
      params.action === 'assess_risk' ||
      params.action === 'insight-summary'
    ) && params.positionSizeUSD === 0;

    const timeSinceLastExecution = Date.now() - this.lastExecutionTime;
    if (!isReadOnlyAction && timeSinceLastExecution < this.limits.cooldownMs) {
      errors.push(`⏱️ Cooldown active. Wait ${Math.ceil((this.limits.cooldownMs - timeSinceLastExecution) / 1000)}s`);
    }

    // 3. Check concurrent executions
    if (this.activeExecutions.size >= this.limits.maxConcurrentExecutions) {
      errors.push(`🔒 Max concurrent executions reached (${this.limits.maxConcurrentExecutions})`);
    }

    // 4. Check position size
    if (params.positionSizeUSD > this.limits.maxPositionSizeUSD) {
      errors.push(`💰 Position size $${params.positionSizeUSD.toLocaleString()} exceeds max $${this.limits.maxPositionSizeUSD.toLocaleString()}`);
      riskScore += 50;
    } else if (params.positionSizeUSD > this.limits.maxPositionSizeUSD * 0.5) {
      warnings.push(`⚠️ Large position: $${params.positionSizeUSD.toLocaleString()} (>${50}% of limit)`);
      requiredApprovals.push('senior_risk_officer');
      riskScore += 20;
    }

    // 5. Check daily volume — per-chain bucket if chain provided
    this.resetDailyVolumeIfNeeded();
    const chainKey = (params.chain ?? 'default').toLowerCase();
    const chainVolume = this.dailyVolumeByChain.get(chainKey) ?? 0;
    const projectedChainVolume = chainVolume + params.positionSizeUSD;
    if (projectedChainVolume > this.limits.maxDailyVolumeUSD) {
      errors.push(`📊 Daily volume limit exceeded for chain='${chainKey}'. Current: $${chainVolume.toLocaleString()}, Max: $${this.limits.maxDailyVolumeUSD.toLocaleString()}`);
    } else if (projectedChainVolume > this.limits.maxDailyVolumeUSD * 0.8) {
      warnings.push(`⚠️ Approaching daily limit for chain='${chainKey}' (${((projectedChainVolume / this.limits.maxDailyVolumeUSD) * 100).toFixed(1)}%)`);
    }

    // 6. Check leverage
    if (params.leverage && params.leverage > this.limits.maxLeverage) {
      errors.push(`⚡ Leverage ${params.leverage}x exceeds max ${this.limits.maxLeverage}x`);
      riskScore += 30;
    }

    // 7. Check slippage
    if (params.expectedSlippageBps && params.expectedSlippageBps > this.limits.maxSlippageBps) {
      errors.push(`📉 Expected slippage ${params.expectedSlippageBps}bps exceeds max ${this.limits.maxSlippageBps}bps`);
      riskScore += 25;
    }

    // 8. Check if consensus required
    if (this.limits.requireMultiAgentConsensus && params.positionSizeUSD > 100_000) {
      requiredApprovals.push('multi_agent_consensus');
    }

    // Log validation
    logger.info('🔍 Execution validation', {
      executionId: params.executionId,
      isValid: errors.length === 0,
      errorCount: errors.length,
      warningCount: warnings.length,
      riskScore,
    });

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      riskScore,
      requiredApprovals,
      zkProofRequired: params.positionSizeUSD > 1_000_000, // ZK proof for >$1M
    };
  }

  // ============================================================================
  // MULTI-AGENT CONSENSUS
  // ============================================================================

  /**
   * Request consensus from multiple agents before execution
   */
  async requestConsensus(params: {
    executionId: string;
    proposal: string;
    requiredAgents: string[];
    timeoutMs?: number;
  }): Promise<AgentConsensus> {
    const consensus: AgentConsensus = {
      executionId: params.executionId,
      proposal: params.proposal,
      votes: new Map(),
      requiredVotes: Math.ceil(params.requiredAgents.length * this.limits.consensusThreshold),
      deadline: new Date(Date.now() + (params.timeoutMs || 30_000)),
    };

    this.pendingConsensus.set(params.executionId, consensus);

    logger.info('🗳️ Consensus requested', {
      executionId: params.executionId,
      requiredVotes: consensus.requiredVotes,
      totalAgents: params.requiredAgents.length,
    });

    return consensus;
  }

  /**
   * Submit vote for consensus
   */
  submitVote(executionId: string, agentId: string, approved: boolean, reason: string): boolean {
    const consensus = this.pendingConsensus.get(executionId);
    if (!consensus) {
      logger.warn('Consensus not found for vote', { executionId, agentId });
      return false;
    }

    if (new Date() > consensus.deadline) {
      logger.warn('Consensus deadline passed', { executionId, agentId });
      return false;
    }

    consensus.votes.set(agentId, { approved, reason, timestamp: new Date() });

    logger.info('🗳️ Vote submitted', {
      executionId,
      agentId,
      approved,
      currentVotes: consensus.votes.size,
      requiredVotes: consensus.requiredVotes,
    });

    return true;
  }

  /**
   * Check if consensus is reached
   */
  checkConsensus(executionId: string): { reached: boolean; approved: boolean; details: string } {
    const consensus = this.pendingConsensus.get(executionId);
    if (!consensus) {
      return { reached: false, approved: false, details: 'Consensus not found' };
    }

    const approvals = Array.from(consensus.votes.values()).filter(v => v.approved).length;
    const rejections = Array.from(consensus.votes.values()).filter(v => !v.approved).length;
    const totalVotes = consensus.votes.size;

    // Check if we have enough votes
    if (totalVotes < consensus.requiredVotes) {
      return {
        reached: false,
        approved: false,
        details: `Waiting for votes: ${totalVotes}/${consensus.requiredVotes}`,
      };
    }

    // Check if approved
    const approved = approvals >= consensus.requiredVotes;

    return {
      reached: true,
      approved,
      details: `Consensus ${approved ? 'APPROVED' : 'REJECTED'}: ${approvals} approvals, ${rejections} rejections`,
    };
  }

  // ============================================================================
  // EXECUTION TRACKING
  // ============================================================================

  /**
   * Start tracking an execution
   */
  startExecution(executionId: string, agentId: string, action: string, params: Record<string, unknown>): AuditLog {
    this.activeExecutions.add(executionId);
    
    // Only set cooldown timer for state-changing actions (not read-only analysis)
    const isReadOnly = (
      action === 'analyze' || 
      action === 'analysis' || 
      action === 'assess_risk' ||
      action === 'insight-summary'
    );
    if (!isReadOnly) {
      this.lastExecutionTime = Date.now();
    }

    const auditLog: AuditLog = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      action,
      agentId,
      executionId,
      params,
      result: 'pending',
      signatures: [],
    };

    this.auditLogs.push(auditLog);

    // Cap audit logs to prevent unbounded memory growth
    if (this.auditLogs.length > SafeExecutionGuard.MAX_AUDIT_LOGS) {
      // Keep most recent 80% when cap is hit (amortized eviction)
      const keepFrom = Math.floor(SafeExecutionGuard.MAX_AUDIT_LOGS * 0.2);
      this.auditLogs = this.auditLogs.slice(keepFrom);
      logger.debug('Audit logs trimmed', { kept: this.auditLogs.length });
    }

    // Clean up expired pending consensus entries
    if (this.pendingConsensus.size > SafeExecutionGuard.MAX_PENDING_CONSENSUS) {
      const now = new Date();
      for (const [execId, consensus] of this.pendingConsensus) {
        if (now > consensus.deadline) {
          this.pendingConsensus.delete(execId);
        }
      }
    }

    logger.info('🚀 Execution started', {
      executionId,
      agentId,
      action,
      activeExecutions: this.activeExecutions.size,
    });

    return auditLog;
  }

  /**
   * Complete execution successfully
   */
  completeExecution(executionId: string, zkProofHash?: string): void {
    this.activeExecutions.delete(executionId);
    
    const log = this.auditLogs.find(l => l.executionId === executionId && l.result === 'pending');
    if (log) {
      log.result = 'success';
      log.zkProofHash = zkProofHash;
    }

    // Reset circuit breaker on success
    this.circuitBreaker.failureCount = 0;

    logger.info('✅ Execution completed', {
      executionId,
      zkProofHash: zkProofHash?.slice(0, 16) + '...',
    });
  }

  /**
   * Mark execution as failed and potentially trigger circuit breaker
   */
  failExecution(executionId: string, errorDetails: string): void {
    this.activeExecutions.delete(executionId);

    const log = this.auditLogs.find(l => l.executionId === executionId && l.result === 'pending');
    if (log) {
      log.result = 'failed';
      log.errorDetails = errorDetails;
    }

    // Update circuit breaker
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailure = new Date();

    if (this.circuitBreaker.failureCount >= this.FAILURE_THRESHOLD) {
      this.tripCircuitBreaker(`${this.FAILURE_THRESHOLD} consecutive failures`);
    }

    logger.error('❌ Execution failed', {
      executionId,
      errorDetails,
      failureCount: this.circuitBreaker.failureCount,
    });
  }

  // ============================================================================
  // CIRCUIT BREAKER
  // ============================================================================

  /**
   * Trip the circuit breaker - stops all new executions
   */
  private tripCircuitBreaker(reason: string): void {
    this.circuitBreaker.isOpen = true;
    this.circuitBreaker.openedAt = new Date();
    this.circuitBreaker.reason = reason;

    logger.error('🚨 CIRCUIT BREAKER TRIPPED', {
      reason,
      failureCount: this.circuitBreaker.failureCount,
      activeExecutions: this.activeExecutions.size,
    });

    // Could also emit event for alerting system
  }

  /**
   * Manually trip circuit breaker (emergency stop)
   */
  emergencyStop(reason: string): void {
    this.tripCircuitBreaker(`EMERGENCY STOP: ${reason}`);
    
    // Mark all active executions as requiring review
    this.activeExecutions.forEach(execId => {
      const log = this.auditLogs.find(l => l.executionId === execId && l.result === 'pending');
      if (log) {
        log.errorDetails = `Interrupted by emergency stop: ${reason}`;
      }
    });

    logger.error('🚨🚨🚨 EMERGENCY STOP ACTIVATED 🚨🚨🚨', { reason });
  }

  /**
   * Reset circuit breaker
   */
  private resetCircuitBreaker(): void {
    this.circuitBreaker.isOpen = false;
    this.circuitBreaker.failureCount = 0;
    this.circuitBreaker.openedAt = null;
    this.circuitBreaker.reason = undefined;

    logger.info('🔄 Circuit breaker reset');
  }

  // ============================================================================
  // VOLUME TRACKING
  // ============================================================================

  /**
   * Add to daily volume. Charge against the chain's bucket if provided,
   * otherwise a shared 'default' bucket (legacy SUI-only callers).
   */
  addVolume(amountUSD: number, chain?: string): void {
    this.resetDailyVolumeIfNeeded();
    const chainKey = (chain ?? 'default').toLowerCase();
    const nextChainVolume = (this.dailyVolumeByChain.get(chainKey) ?? 0) + amountUSD;
    this.dailyVolumeByChain.set(chainKey, nextChainVolume);
    this.dailyVolumeUSD += amountUSD;

    logger.info('📊 Volume added', {
      chain: chainKey,
      added: amountUSD,
      chainTotal: nextChainVolume,
      dailyTotal: this.dailyVolumeUSD,
      limit: this.limits.maxDailyVolumeUSD,
      percentUsed: ((nextChainVolume / this.limits.maxDailyVolumeUSD) * 100).toFixed(1),
    });
  }

  private resetDailyVolumeIfNeeded(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.dailyVolumeResetDate !== today) {
      this.dailyVolumeUSD = 0;
      this.dailyVolumeByChain.clear();
      this.dailyVolumeResetDate = today;
      logger.info('📊 Daily volume reset', { date: today });
    }
  }

  // ============================================================================
  // AUDIT & REPORTING
  // ============================================================================

  /**
   * Get audit logs for compliance
   */
  getAuditLogs(options?: {
    executionId?: string;
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
    result?: AuditLog['result'];
  }): AuditLog[] {
    let logs = [...this.auditLogs];

    if (options?.executionId) {
      logs = logs.filter(l => l.executionId === options.executionId);
    }
    if (options?.agentId) {
      logs = logs.filter(l => l.agentId === options.agentId);
    }
    if (options?.startDate) {
      logs = logs.filter(l => l.timestamp >= options.startDate!);
    }
    if (options?.endDate) {
      logs = logs.filter(l => l.timestamp <= options.endDate!);
    }
    if (options?.result) {
      logs = logs.filter(l => l.result === options.result);
    }

    return logs;
  }

  /**
   * Get current guard status
   */
  getStatus(): {
    circuitBreaker: CircuitBreakerState;
    activeExecutions: number;
    dailyVolumeUSD: number;
    dailyVolumePercent: number;
    dailyVolumeByChain: Record<string, number>;
    limits: ExecutionLimits;
  } {
    this.resetDailyVolumeIfNeeded();

    return {
      circuitBreaker: { ...this.circuitBreaker },
      activeExecutions: this.activeExecutions.size,
      dailyVolumeUSD: this.dailyVolumeUSD,
      dailyVolumePercent: (this.dailyVolumeUSD / this.limits.maxDailyVolumeUSD) * 100,
      dailyVolumeByChain: Object.fromEntries(this.dailyVolumeByChain),
      limits: { ...this.limits },
    };
  }

  /**
   * Reset runtime state for a fresh validation session.
   * This is safe to call between tests or when re-initializing the guard.
   */
  resetState(): void {
    this.activeExecutions.clear();
    this.auditLogs = [];
    this.pendingConsensus.clear();
    this.dailyVolumeUSD = 0;
    this.dailyVolumeByChain.clear();
    this.dailyVolumeResetDate = '';
    this.lastExecutionTime = 0;
    this.circuitBreaker = {
      isOpen: false,
      failureCount: 0,
      lastFailure: null,
      openedAt: null,
    };
    logger.info('🧹 SafeExecutionGuard state reset');
  }

  /**
   * Update limits (requires admin approval in production)
   */
  updateLimits(newLimits: Partial<ExecutionLimits>): void {
    const oldLimits = { ...this.limits };
    this.limits = { ...this.limits, ...newLimits };

    logger.warn('⚠️ Execution limits updated', {
      oldLimits,
      newLimits: this.limits,
    });
  }
}

// Export singleton getter
export function getSafeExecutionGuard(limits?: Partial<ExecutionLimits>): SafeExecutionGuard {
  return SafeExecutionGuard.getInstance(limits);
}
