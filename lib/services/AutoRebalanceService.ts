/**
 * Auto-Rebalancing Service
 *
 * Monitors portfolios and automatically rebalances when allocations drift beyond threshold
 *
 * Features:
 * - Periodic monitoring of portfolio allocations
 * - Drift detection and threshold-based triggering
 * - Agent-driven rebalancing execution
 * - Risk-aware rebalancing logic
 *
 * Usage:
 * ```ts
 * const service = AutoRebalanceService.getInstance();
 * await service.start();
 * service.enableForPortfolio({
 *   portfolioId: 3,
 *   walletAddress: '0x...',
 *   enabled: true,
 *   threshold: 5, // Rebalance when allocation drifts by 5%
 *   frequency: 'DAILY',
 *   autoApprovalEnabled: true,
 *   autoApprovalThreshold: 50000, // Auto-approve rebalances under $50K
 * });
 * ```
 */

import { logger } from '../utils/logger'; // Configuration
const CONFIG = {
  CHECK_INTERVAL_MS: 60 * 60 * 1000, // Check every hour
  DEFAULT_THRESHOLD: 5, // 5% drift threshold
  DEFAULT_FREQUENCY: 'DAILY' as RebalanceFrequency,
  MAX_PORTFOLIOS: 100,
  COOLDOWN_PERIOD_MS: 24 * 60 * 60 * 1000, // 24 hours minimum between rebalances
};

export type RebalanceFrequency = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface LossProtectionConfig {
  enabled: boolean;
  mode?: 'entry' | 'drawdown' | 'both';
  lossThresholdPercent: number;
  drawdownThresholdPercent?: number;
  action: 'hedge' | 'sell_to_stable';
  hedgeRatio: number;
  maxHedgeLeverage: number;
  cooldownHours?: number;
}

export interface AutoRebalanceConfig {
  portfolioId: number;
  walletAddress: string;
  enabled: boolean;
  threshold: number; // Percentage drift (1-20%)
  frequency: RebalanceFrequency;
  autoApprovalEnabled: boolean;
  autoApprovalThreshold: number; // USD value
  targetAllocations?: Record<string, number>; // Asset -> percentage
  lossProtection?: LossProtectionConfig; // Loss/drawdown protection settings
}

export interface AllocationDrift {
  asset: string;
  target: number;
  current: number;
  drift: number;
  driftPercent: number;
  shouldRebalance: boolean;
}

export interface RebalanceAssessment {
  portfolioId: number;
  totalValue: number;
  requiresRebalance: boolean;
  drifts: AllocationDrift[];
  proposedActions: {
    asset: string;
    action: 'BUY' | 'SELL';
    amount: number;
    reason: string;
  }[];
  estimatedCost: number;
  timestamp: number;
}

class AutoRebalanceService {
  private static instance: AutoRebalanceService;
  private isRunning = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private rebalanceConfigs: Map<number, AutoRebalanceConfig> = new Map();
  private lastRebalances: Map<number, number> = new Map(); // portfolioId -> timestamp
  private lastAssessments: Map<number, RebalanceAssessment> = new Map();

  private constructor() {}

  static getInstance(): AutoRebalanceService {
    if (!AutoRebalanceService.instance) {
      AutoRebalanceService.instance = new AutoRebalanceService();
    }
    return AutoRebalanceService.instance;
  }

  /**
   * Start the auto-rebalancing service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info('[AutoRebalance] Already running');
      return;
    }

    this.isRunning = true;
    logger.info('[AutoRebalance] Starting service...');

    // Initial check
    await this.checkAllPortfolios();

    // Start monitoring loop
    this.checkInterval = setInterval(async () => {
      try {
        await this.checkAllPortfolios();
      } catch (error) {
        logger.error('[AutoRebalance] Check error', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }, CONFIG.CHECK_INTERVAL_MS);

    logger.info('[AutoRebalance] Service started', {
      checkInterval: `${CONFIG.CHECK_INTERVAL_MS / 1000}s`,
      activePortfolios: this.rebalanceConfigs.size,
    });
  }

  /**
   * Stop the auto-rebalancing service
   */
  stop(): void {
    if (!this.isRunning) return;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.isRunning = false;
    logger.info('[AutoRebalance] Service stopped');
  }

  /**
   * Enable auto-rebalancing for a portfolio
   */
  enableForPortfolio(config: AutoRebalanceConfig): void {
    if (this.rebalanceConfigs.size >= CONFIG.MAX_PORTFOLIOS) {
      throw new Error('Maximum number of portfolios reached');
    }

    this.rebalanceConfigs.set(config.portfolioId, config);
    logger.info('[AutoRebalance] Enabled for portfolio', {
      portfolioId: config.portfolioId,
      threshold: `${config.threshold}%`,
      frequency: config.frequency,
    });
  }

  /**
   * Disable auto-rebalancing for a portfolio
   */
  disableForPortfolio(portfolioId: number): void {
    this.rebalanceConfigs.delete(portfolioId);
    this.lastRebalances.delete(portfolioId);
    this.lastAssessments.delete(portfolioId);
    logger.info('[AutoRebalance] Disabled for portfolio', { portfolioId });
  }

  /**
   * Check all enabled portfolios
   */
  private async checkAllPortfolios(): Promise<void> {
    logger.info('[AutoRebalance] Checking portfolios', {
      count: this.rebalanceConfigs.size,
    });

    for (const [portfolioId, config] of this.rebalanceConfigs) {
      if (!config.enabled) continue;

      try {
        // Check cooldown period
        const lastRebalance = this.lastRebalances.get(portfolioId) || 0;
        const timeSinceLastRebalance = Date.now() - lastRebalance;

        if (timeSinceLastRebalance < CONFIG.COOLDOWN_PERIOD_MS) {
          logger.debug('[AutoRebalance] Portfolio in cooldown', {
            portfolioId,
            remainingMs: CONFIG.COOLDOWN_PERIOD_MS - timeSinceLastRebalance,
          });
          continue;
        }

        // Assess portfolio
        const assessment = await this.assessPortfolio(portfolioId, config);
        this.lastAssessments.set(portfolioId, assessment);

        // Execute rebalance if needed
        if (assessment.requiresRebalance) {
          await this.executeRebalance(portfolioId, config, assessment);
        }
      } catch (error) {
        logger.error('[AutoRebalance] Portfolio check failed', {
          portfolioId,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  /**
   * Assess portfolio for rebalancing needs
   */
  async assessPortfolio(
    portfolioId: number,
    config: AutoRebalanceConfig
  ): Promise<RebalanceAssessment> {
    logger.debug('[AutoRebalance] Assessing portfolio', { portfolioId });

    try {
      // Fetch current portfolio state
      const portfolio = await this.fetchPortfolioData(portfolioId, config.walletAddress);

      if (!portfolio) {
        throw new Error('Portfolio not found');
      }

      // Calculate allocation drifts
      const drifts: AllocationDrift[] = [];
      const targetAllocations =
        config.targetAllocations || this.getDefaultTargetAllocations(portfolio);

      for (const [asset, targetPercent] of Object.entries(targetAllocations)) {
        const currentValue = portfolio.assets[asset] || 0;
        const currentPercent = (currentValue / portfolio.totalValue) * 100;
        const drift = currentPercent - targetPercent;
        const driftPercent = Math.abs(drift);

        drifts.push({
          asset,
          target: targetPercent,
          current: currentPercent,
          drift,
          driftPercent,
          shouldRebalance: driftPercent > config.threshold,
        });
      }

      // Check if rebalance is needed
      const requiresRebalance = drifts.some((d) => d.shouldRebalance);

      // Generate proposed actions
      const proposedActions = requiresRebalance
        ? this.generateRebalanceActions(drifts, portfolio.totalValue)
        : [];

      // Estimate cost (gas + slippage)
      const estimatedCost = this.estimateRebalanceCost(proposedActions);

      const assessment: RebalanceAssessment = {
        portfolioId,
        totalValue: portfolio.totalValue,
        requiresRebalance,
        drifts,
        proposedActions,
        estimatedCost,
        timestamp: Date.now(),
      };

      if (requiresRebalance) {
        logger.info('[AutoRebalance] Rebalance needed', {
          portfolioId,
          totalValue: portfolio.totalValue,
          maxDrift: Math.max(...drifts.map((d) => d.driftPercent)).toFixed(2) + '%',
          actions: proposedActions.length,
        });
      }

      return assessment;
    } catch (error) {
      logger.error('[AutoRebalance] Assessment failed', {
        portfolioId,
        error: error instanceof Error ? error.message : error,
      });

      // Return safe default
      return {
        portfolioId,
        totalValue: 0,
        requiresRebalance: false,
        drifts: [],
        proposedActions: [],
        estimatedCost: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Execute rebalance for a portfolio
   */
  private async executeRebalance(
    portfolioId: number,
    config: AutoRebalanceConfig,
    assessment: RebalanceAssessment
  ): Promise<void> {
    logger.info('[AutoRebalance] Executing rebalance', {
      portfolioId,
      totalValue: assessment.totalValue,
      actions: assessment.proposedActions.length,
    });

    try {
      // Check auto-approval threshold
      const requiresApproval =
        !config.autoApprovalEnabled || assessment.totalValue > config.autoApprovalThreshold;

      if (requiresApproval) {
        logger.info('[AutoRebalance] Rebalance requires manual approval', {
          portfolioId,
          totalValue: assessment.totalValue,
          threshold: config.autoApprovalThreshold,
        });

        // TODO: Send notification to user
        // await this.sendRebalanceNotification(portfolioId, assessment);
        return;
      }

      const newAllocations = assessment.drifts.map((d) => Math.round(d.target));

      // Call rebalancing API
      const response = await fetch('/api/agents/portfolio/rebalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId,
          walletAddress: config.walletAddress,
          newAllocations,
          autoApproved: true,
          actions: assessment.proposedActions,
        }),
      });

      const result = await response.json();

      if (result.success) {
        this.lastRebalances.set(portfolioId, Date.now());
        logger.info('[AutoRebalance] Rebalance executed successfully', {
          portfolioId,
          txHash: result.txHash,
        });
      } else {
        throw new Error(result.error || 'Rebalance failed');
      }
    } catch (error) {
      logger.error('[AutoRebalance] Rebalance execution failed', {
        portfolioId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Fetch portfolio data from blockchain/API
   */
  private async fetchPortfolioData(
    portfolioId: number,
    walletAddress: string
  ): Promise<{ totalValue: number; assets: Record<string, number> } | null> {
    try {
      const response = await fetch(`/api/portfolios/${portfolioId}?wallet=${walletAddress}`);
      const data = await response.json();

      if (!data.success) {
        return null;
      }

      // Convert assets array to object
      const assets: Record<string, number> = {};
      for (const asset of data.portfolio.assets || []) {
        assets[asset.symbol] = asset.value;
      }

      return {
        totalValue: data.portfolio.totalValue,
        assets,
      };
    } catch (error) {
      logger.error('[AutoRebalance] Failed to fetch portfolio', {
        portfolioId,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Get default target allocations if not specified
   */
  private getDefaultTargetAllocations(portfolio: {
    assets: Record<string, number>;
  }): Record<string, number> {
    // Equal-weight allocation as default
    const assetCount = Object.keys(portfolio.assets).length;
    const equalWeight = 100 / assetCount;

    const allocations: Record<string, number> = {};
    for (const asset of Object.keys(portfolio.assets)) {
      allocations[asset] = equalWeight;
    }

    return allocations;
  }

  /**
   * Generate rebalance actions from drifts
   */
  private generateRebalanceActions(
    drifts: AllocationDrift[],
    totalValue: number
  ): Array<{ asset: string; action: 'BUY' | 'SELL'; amount: number; reason: string }> {
    const actions: Array<{
      asset: string;
      action: 'BUY' | 'SELL';
      amount: number;
      reason: string;
    }> = [];

    for (const drift of drifts) {
      if (!drift.shouldRebalance) continue;

      const targetValue = (drift.target / 100) * totalValue;
      const currentValue = (drift.current / 100) * totalValue;
      const difference = targetValue - currentValue;

      if (Math.abs(difference) < 10) continue; // Skip small adjustments (<$10)

      actions.push({
        asset: drift.asset,
        action: difference > 0 ? 'BUY' : 'SELL',
        amount: Math.abs(difference),
        reason: `Drift ${drift.driftPercent.toFixed(2)}% (target: ${drift.target}%, current: ${drift.current.toFixed(2)}%)`,
      });
    }

    return actions;
  }

  /**
   * Estimate rebalancing cost
   */
  private estimateRebalanceCost(
    actions: Array<{ asset: string; action: string; amount: number }>
  ): number {
    // Rough estimate: $0.50 gas per swap + 0.1% slippage
    const gasPerSwap = 0.5;
    const slippageBps = 10; // 0.1%

    let totalCost = actions.length * gasPerSwap;

    for (const action of actions) {
      totalCost += (action.amount * slippageBps) / 10000;
    }

    return totalCost;
  }

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    activePortfolios: number;
    lastCheck: number;
    uptime: number;
  } {
    return {
      running: this.isRunning,
      activePortfolios: this.rebalanceConfigs.size,
      lastCheck: this.checkInterval ? Date.now() : 0,
      uptime: this.isRunning ? Date.now() : 0,
    };
  }

  /**
   * Get last assessment for a portfolio
   */
  getLastAssessment(portfolioId: number): RebalanceAssessment | null {
    return this.lastAssessments.get(portfolioId) || null;
  }

  /**
   * Manual trigger for rebalance assessment
   */
  async triggerAssessment(
    portfolioId: number,
    _walletAddress: string
  ): Promise<RebalanceAssessment> {
    const config = this.rebalanceConfigs.get(portfolioId);

    if (!config) {
      throw new Error(`Portfolio ${portfolioId} not configured for auto-rebalancing`);
    }

    return this.assessPortfolio(portfolioId, config);
  }
}

// Export singleton instance
export const autoRebalanceService = AutoRebalanceService.getInstance();
