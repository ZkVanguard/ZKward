/**
 * Background Hedge Controller
 * 
 * Coordinates real-time AI decisions with background hedge execution.
 * Ensures hedges are executed at validated prices with proper risk controls.
 * 
 * Architecture:
 * 1. AIManager → Provides AI recommendations in real-time
 * 2. UnifiedPriceProvider → Provides validated real-time prices
 * 3. AutoHedgingService → Executes hedges with risk controls
 * 4. This controller → Coordinates all three for intelligent background hedging
 */

import { logger } from '@/lib/utils/logger';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { getUnifiedPriceProvider, getHedgeExecutionPrice, type HedgePriceContext } from '../market-data/unified-price-provider';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HedgeIntent {
  id: string;
  portfolioId: number;
  asset: string;
  side: 'LONG' | 'SHORT';
  notionalValue: number;
  leverage: number;
  reason: string;
  confidence: number;
  source: 'ai' | 'risk-alert' | 'manual' | 'rebalance';
  urgency: 'critical' | 'high' | 'medium' | 'low';
  createdAt: number;
  expiresAt: number;
  priceTarget?: number;
  maxSlippage?: number;
}

export interface HedgeValidation {
  isValid: boolean;
  priceContext: HedgePriceContext;
  adjustedSize?: number;
  adjustedLeverage?: number;
  warnings: string[];
  blockers: string[];
}

export interface HedgeExecution {
  intentId: string;
  success: boolean;
  orderId?: string;
  entryPrice: number;
  executedSize: number;
  txHash?: string;
  error?: string;
  executedAt: number;
}

export interface ControllerStatus {
  isRunning: boolean;
  pendingIntents: number;
  executedToday: number;
  lastExecution: number | null;
  priceProviderConnected: boolean;
  aiManagerConnected: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Processing intervals
  INTENT_PROCESS_INTERVAL: 5000,  // Check pending intents every 5s
  CLEANUP_INTERVAL: 60000,        // Clean expired intents every 60s
  
  // Validation thresholds
  MAX_PRICE_STALENESS_MS: 5000,   // Reject if price > 5s old
  MAX_SLIPPAGE_PERCENT: 1.0,      // Default max slippage
  MIN_CONFIDENCE: 0.6,            // Min AI confidence to execute
  
  // Risk limits
  MAX_DAILY_HEDGE_VALUE: 50000000, // $50M daily limit
  MAX_SINGLE_HEDGE_VALUE: 10000000, // $10M per hedge
  MAX_LEVERAGE: 10,               // Max leverage allowed
  
  // Intent expiry
  INTENT_TTL_MS: 300000,          // Intents expire after 5 minutes
  
  // Retry configuration
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BACKGROUND HEDGE CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

class BackgroundHedgeController extends EventEmitter {
  private isRunning = false;
  private pendingIntents: Map<string, HedgeIntent> = new Map();
  private executionHistory: HedgeExecution[] = [];
  private dailyHedgeValue = 0;
  private dailyResetTime = 0;
  
  private processTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    if (this.isRunning) return;

    logger.info('[BackgroundHedge] Starting controller...');
    
    // Initialize price provider
    const priceProvider = getUnifiedPriceProvider();
    await priceProvider.initialize();
    
    // Reset daily counters if needed
    this.checkDailyReset();
    
    // Start processing loop
    this.processTimer = setInterval(() => {
      this.processIntents().catch(err => {
        logger.error('[BackgroundHedge] Process error', { error: err });
      });
    }, CONFIG.INTENT_PROCESS_INTERVAL);
    
    // Start cleanup loop
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredIntents();
    }, CONFIG.CLEANUP_INTERVAL);
    
    this.isRunning = true;
    logger.info('[BackgroundHedge] Controller started');
    this.emit('started');
  }

  stop(): void {
    if (!this.isRunning) return;

    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    this.isRunning = false;
    logger.info('[BackgroundHedge] Controller stopped');
    this.emit('stopped');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTENT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Queue a hedge intent for background execution
   */
  queueIntent(intent: Omit<HedgeIntent, 'id' | 'createdAt' | 'expiresAt'>): string {
    const id = `hedge-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    
    const fullIntent: HedgeIntent = {
      ...intent,
      id,
      createdAt: now,
      expiresAt: now + CONFIG.INTENT_TTL_MS,
    };
    
    // Validate basic constraints
    if (intent.notionalValue > CONFIG.MAX_SINGLE_HEDGE_VALUE) {
      logger.warn('[BackgroundHedge] Intent exceeds max single hedge value', {
        intentId: id,
        value: intent.notionalValue,
        max: CONFIG.MAX_SINGLE_HEDGE_VALUE,
      });
      // Still queue but will be rejected at execution
    }
    
    if (intent.leverage > CONFIG.MAX_LEVERAGE) {
      fullIntent.leverage = CONFIG.MAX_LEVERAGE;
      logger.info('[BackgroundHedge] Capped leverage', {
        intentId: id,
        requested: intent.leverage,
        capped: CONFIG.MAX_LEVERAGE,
      });
    }
    
    this.pendingIntents.set(id, fullIntent);
    
    logger.info('[BackgroundHedge] Intent queued', {
      intentId: id,
      asset: intent.asset,
      side: intent.side,
      value: intent.notionalValue,
      urgency: intent.urgency,
    });
    
    this.emit('intentQueued', fullIntent);
    
    return id;
  }

  /**
   * Cancel a pending intent
   */
  cancelIntent(intentId: string): boolean {
    if (this.pendingIntents.has(intentId)) {
      this.pendingIntents.delete(intentId);
      logger.info('[BackgroundHedge] Intent cancelled', { intentId });
      this.emit('intentCancelled', intentId);
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTENT PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  private async processIntents(): Promise<void> {
    if (this.pendingIntents.size === 0) return;

    // Check daily reset
    this.checkDailyReset();
    
    // Sort by urgency and creation time
    const sortedIntents = Array.from(this.pendingIntents.values())
      .filter(i => Date.now() < i.expiresAt)
      .sort((a, b) => {
        const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        const urgencyDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
        if (urgencyDiff !== 0) return urgencyDiff;
        return a.createdAt - b.createdAt;
      });

    // Process one at a time to avoid race conditions
    for (const intent of sortedIntents) {
      try {
        const validation = await this.validateIntent(intent);
        
        if (!validation.isValid) {
          logger.warn('[BackgroundHedge] Intent validation failed', {
            intentId: intent.id,
            blockers: validation.blockers,
            warnings: validation.warnings,
          });
          
          // Remove if blocked, keep if just warnings
          if (validation.blockers.length > 0) {
            this.pendingIntents.delete(intent.id);
            this.emit('intentFailed', { intent, reason: validation.blockers.join('; ') });
          }
          continue;
        }
        
        // Execute the hedge
        const execution = await this.executeIntent(intent, validation);
        
        // Record and remove from pending
        this.executionHistory.push(execution);
        // Cap execution history to prevent unbounded memory growth
        if (this.executionHistory.length > 1000) {
          this.executionHistory = this.executionHistory.slice(-500);
        }
        this.pendingIntents.delete(intent.id);
        
        if (execution.success) {
          this.dailyHedgeValue += intent.notionalValue;
          this.emit('hedgeExecuted', execution);
        } else {
          this.emit('intentFailed', { intent, reason: execution.error });
        }
        
      } catch (error) {
        logger.error('[BackgroundHedge] Intent processing error', {
          intentId: intent.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async validateIntent(intent: HedgeIntent): Promise<HedgeValidation> {
    const warnings: string[] = [];
    const blockers: string[] = [];
    
    // Get validated price
    const priceContext = await getHedgeExecutionPrice(intent.asset, intent.side);
    
    // Check price validity
    if (!priceContext.validation.isValid) {
      blockers.push('Invalid price data');
    }
    
    // Check price freshness
    if (priceContext.validation.staleness > CONFIG.MAX_PRICE_STALENESS_MS) {
      blockers.push(`Price too stale (${(priceContext.validation.staleness / 1000).toFixed(1)}s old)`);
    }
    
    // Check slippage
    const maxSlippage = intent.maxSlippage ?? CONFIG.MAX_SLIPPAGE_PERCENT;
    if (priceContext.slippageEstimate > maxSlippage) {
      warnings.push(`High slippage: ${priceContext.slippageEstimate.toFixed(2)}%`);
    }
    
    // Check confidence (for AI intents)
    if (intent.source === 'ai' && intent.confidence < CONFIG.MIN_CONFIDENCE) {
      blockers.push(`Low confidence: ${(intent.confidence * 100).toFixed(0)}%`);
    }
    
    // Check daily limits
    if (this.dailyHedgeValue + intent.notionalValue > CONFIG.MAX_DAILY_HEDGE_VALUE) {
      blockers.push('Daily hedge limit reached');
    }
    
    // Check single hedge limit
    if (intent.notionalValue > CONFIG.MAX_SINGLE_HEDGE_VALUE) {
      blockers.push(`Exceeds max single hedge value ($${(CONFIG.MAX_SINGLE_HEDGE_VALUE / 1000000).toFixed(0)}M)`);
    }
    
    // Check price target (if specified)
    if (intent.priceTarget) {
      const priceDiff = Math.abs(priceContext.effectivePrice - intent.priceTarget) / intent.priceTarget * 100;
      if (priceDiff > 2) {
        warnings.push(`Price differs from target by ${priceDiff.toFixed(1)}%`);
      }
    }
    
    // Add any price validation warnings
    warnings.push(...priceContext.validation.warnings);
    
    return {
      isValid: blockers.length === 0,
      priceContext,
      warnings,
      blockers,
    };
  }

  private async executeIntent(intent: HedgeIntent, validation: HedgeValidation): Promise<HedgeExecution> {
    const startTime = Date.now();
    
    try {
      logger.info('[BackgroundHedge] Executing hedge intent', {
        intentId: intent.id,
        asset: intent.asset,
        side: intent.side,
        price: validation.priceContext.effectivePrice,
      });
      
      // Call the hedge execution API
      const appUrl = process.env.VERCEL 
        ? 'https://zkward.com' 
        : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const response = await fetch(`${appUrl}/api/agents/hedging/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          portfolioId: intent.portfolioId,
          asset: intent.asset,
          side: intent.side,
          notionalValue: intent.notionalValue,
          leverage: intent.leverage,
          reason: `[BACKGROUND] ${intent.reason}`,
          autoApprovalEnabled: true,
          autoApprovalThreshold: CONFIG.MAX_SINGLE_HEDGE_VALUE,
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        logger.info('[BackgroundHedge] Hedge executed successfully', {
          intentId: intent.id,
          orderId: result.orderId,
          entryPrice: result.entryPrice,
          txHash: result.txHash,
        });
        
        return {
          intentId: intent.id,
          success: true,
          orderId: result.orderId,
          entryPrice: parseFloat(result.entryPrice || validation.priceContext.effectivePrice.toString()),
          executedSize: intent.notionalValue / (validation.priceContext.effectivePrice || 1),
          txHash: result.txHash,
          executedAt: Date.now(),
        };
      } else {
        throw new Error(result.error || 'Hedge execution failed');
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[BackgroundHedge] Hedge execution failed', {
        intentId: intent.id,
        error: errorMsg,
        duration: Date.now() - startTime,
      });
      
      return {
        intentId: intent.id,
        success: false,
        entryPrice: validation.priceContext.effectivePrice,
        executedSize: 0,
        error: errorMsg,
        executedAt: Date.now(),
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  private checkDailyReset(): void {
    const _now = Date.now();
    const today = new Date().setHours(0, 0, 0, 0);
    
    if (today > this.dailyResetTime) {
      this.dailyHedgeValue = 0;
      this.dailyResetTime = today;
      logger.info('[BackgroundHedge] Daily counters reset');
    }
  }

  private cleanupExpiredIntents(): void {
    const now = Date.now();
    let expired = 0;
    
    for (const [id, intent] of this.pendingIntents) {
      if (now > intent.expiresAt) {
        this.pendingIntents.delete(id);
        expired++;
        this.emit('intentExpired', intent);
      }
    }
    
    if (expired > 0) {
      logger.info('[BackgroundHedge] Cleaned up expired intents', { count: expired });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════════════════════════

  getStatus(): ControllerStatus {
    const priceProvider = getUnifiedPriceProvider();
    const status = priceProvider.getStatus();
    
    const today = new Date().setHours(0, 0, 0, 0);
    const executedToday = this.executionHistory.filter(e => 
      new Date(e.executedAt).setHours(0, 0, 0, 0) === today
    ).length;
    
    const lastExecution = this.executionHistory.length > 0
      ? this.executionHistory[this.executionHistory.length - 1].executedAt
      : null;
    
    return {
      isRunning: this.isRunning,
      pendingIntents: this.pendingIntents.size,
      executedToday,
      lastExecution,
      priceProviderConnected: status.priceCount > 0,
      aiManagerConnected: true, // Will be connected via AIDecisionsContext
    };
  }

  getPendingIntents(): HedgeIntent[] {
    return Array.from(this.pendingIntents.values());
  }

  getExecutionHistory(limit = 50): HedgeExecution[] {
    return this.executionHistory.slice(-limit);
  }

  getDailyStats(): { hedgeValue: number; limit: number; remaining: number } {
    return {
      hedgeValue: this.dailyHedgeValue,
      limit: CONFIG.MAX_DAILY_HEDGE_VALUE,
      remaining: CONFIG.MAX_DAILY_HEDGE_VALUE - this.dailyHedgeValue,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

let instance: BackgroundHedgeController | null = null;

export function getBackgroundHedgeController(): BackgroundHedgeController {
  if (!instance) {
    instance = new BackgroundHedgeController();
  }
  return instance;
}

export { BackgroundHedgeController };
