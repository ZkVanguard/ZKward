/**
 * Hedging Agent
 * Specialized agent for automated hedging strategies using perpetual futures
 *
 * Enhanced with AIMarketIntelligence for comprehensive market context:
 * - Multi-timeframe streak analysis
 * - Cross-market correlation
 * - Risk cascade detection
 * - Liquidity analysis
 * - Implied price movement forecasting
 */

import { BaseAgent } from '../core/BaseAgent';
import { AgentCapability, AgentTask, TaskResult, AgentMessage } from '@shared/types/agent';
import {
  MoonlanderClient,
  OrderResult,
  PerpetualPosition,
  LiquidationRisk,
} from '@integrations/moonlander/MoonlanderClient';
import { MCPClient } from '@integrations/mcp/MCPClient';
import {
  HedgeExecutorClient,
  HedgeExecutorConfig,
  OnChainHedgeResult,
} from '@integrations/hedge-executor/HedgeExecutorClient';
import { DelphiMarketService } from '../../lib/services/market-data/DelphiMarketService';
import {
  PredictionAggregatorService,
  type AggregatedPrediction,
} from '../../lib/services/market-data/PredictionAggregatorService';
import {
  AIMarketIntelligence,
  type AIMarketContext,
} from '../../lib/services/AIMarketIntelligence';
import { logger } from '@shared/utils/logger';
import {
  logReturns, pearsonCorrelation, lag1Autocorrelation, annualizedVolatility,
  deriveCorrelationFromMarketProxy, optimalHedgeRatio,
} from './hedging-math';
import { agentSystemPrompt } from '../../lib/services/ai/model-constitution';
import { ethers } from 'ethers';
import type {
  FiveMinBTCSignal,
  FiveMinSignalHistory,
  SignalEvent,
} from '../../lib/services/market-data/Polymarket5MinService';

// Re-export types from the dedicated types module
export { type HedgeStrategy, type HedgeAnalysis } from '@/lib/types/hedge-strategy-types';
import type { HedgeStrategy, HedgeAnalysis } from '@/lib/types/hedge-strategy-types';

/** Extended client interface for duck-typing compatibility with varying implementations */
interface MoonlanderClientExt {
  openHedge?: (params: {
    market: string;
    side: 'LONG' | 'SHORT';
    notionalValue: string;
    leverage?: number;
    stopLoss?: string;
    takeProfit?: string;
  }) => Promise<OrderResult>;
  createOrder?: (params: Record<string, unknown>) => Promise<OrderResult>;
  getPosition?: (market: string) => Promise<PerpetualPosition | null>;
  getPositions?: () => Promise<PerpetualPosition[]>;
  calculateLiquidationRisk?: () => Promise<LiquidationRisk[]>;
}

export class HedgingAgent extends BaseAgent {
  private moonlanderClient: MoonlanderClient;
  private mcpClient: MCPClient;
  private hedgeExecutorClient?: HedgeExecutorClient;
  private useOnChainExecution: boolean = false;
  private activeStrategies: Map<string, HedgeStrategy> = new Map();
  private onChainHedges: Map<string, OnChainHedgeResult> = new Map();
  private monitoringInterval?: NodeJS.Timeout;

  // ── Proactive 5-min signal (pushed by ticker) ──────────
  private cachedFiveMinSignal: FiveMinBTCSignal | null = null;
  private cachedFiveMinHistory: FiveMinSignalHistory | null = null;
  private fiveMinUnsubscribers: (() => void)[] = [];

  constructor(
    agentId: string,
    private provider: ethers.Provider,
    private signer: ethers.Wallet | ethers.Signer,
    hedgeExecutorConfig?: HedgeExecutorConfig
  ) {
    super(agentId, 'hedging', [
      AgentCapability.RISK_ANALYSIS,
      AgentCapability.PORTFOLIO_MANAGEMENT,
      AgentCapability.MARKET_INTEGRATION,
    ]);

    this.moonlanderClient = new MoonlanderClient(provider, signer);
    this.mcpClient = new MCPClient();

    // Enable on-chain execution if config provided
    if (hedgeExecutorConfig) {
      this.hedgeExecutorClient = new HedgeExecutorClient(hedgeExecutorConfig);
      this.useOnChainExecution = true;
      logger.info('HedgingAgent: On-chain execution enabled via HedgeExecutor', {
        contract: hedgeExecutorConfig.contractAddress,
      });
    }
  }

  /**
   * Enable/disable on-chain execution at runtime
   */
  setOnChainExecution(enabled: boolean) {
    if (enabled && !this.hedgeExecutorClient) {
      throw new Error('HedgeExecutorClient not configured');
    }
    this.useOnChainExecution = enabled;
    logger.info(`On-chain execution ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Initialize agent
   */
  protected async onInitialize(): Promise<void> {
    try {
      // Initialize integrations
      await this.moonlanderClient.initialize();
      await this.mcpClient.connect();

      // Subscribe to the proactive 5-min signal ticker — never late
      try {
        const { Polymarket5MinService } =
          await import('../../lib/services/market-data/Polymarket5MinService');
        this.fiveMinUnsubscribers.push(
          Polymarket5MinService.on('signal:update', (evt: SignalEvent) => {
            this.cachedFiveMinSignal = evt.signal;
            this.cachedFiveMinHistory = evt.history;
          }),
          Polymarket5MinService.on('signal:strong-alert', (evt: SignalEvent) => {
            logger.info('HedgingAgent: STRONG 5-min signal received — urgent hedge may be needed', {
              direction: evt.signal.direction,
              probability: evt.signal.probability,
              recommendation: evt.signal.recommendation,
              agentId: this.agentId,
            });
          })
        );
        // Seed with current signal
        this.cachedFiveMinSignal = await Polymarket5MinService.getLatest5MinSignal();
        this.cachedFiveMinHistory = Polymarket5MinService.getSignalHistory();
        logger.info('HedgingAgent subscribed to 5-min signal ticker', { agentId: this.agentId });
      } catch {
        logger.debug('HedgingAgent: 5-min signal ticker unavailable at init');
      }

      logger.info('HedgingAgent initialized', { agentId: this.agentId });
    } catch (error) {
      logger.error('Failed to initialize HedgingAgent', { error });
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
   * Get price from centralized snapshot (if fresh) or fall back to MCP.
   * This avoids redundant API calls when CentralizedHedgeManager has
   * already fetched all prices for the current cycle.
   */
  private async getPriceFromSnapshotOrMCP(
    assetSymbol: string
  ): Promise<{ price: number; priceChange24h: number; volume24h: number }> {
    // Try centralized snapshot via orchestrator
    try {
      const { getAgentOrchestrator } = await import('../../lib/services/agent-orchestrator');
      const snapshot = getAgentOrchestrator().getSharedSnapshot();
      if (snapshot) {
        const sym = assetSymbol.toUpperCase().replace('-PERP', '').replace('-USD-PERP', '');
        const data = snapshot.prices.get(sym);
        if (data) {
          logger.debug('[HedgingAgent] Using centralized snapshot price', {
            asset: sym,
            price: data.price,
          });
          return {
            price: data.price,
            priceChange24h: data.change24h,
            volume24h: data.volume24h,
          };
        }
      }
    } catch {
      // Orchestrator not available — fall through to MCP
    }

    // Fallback: independent MCP fetch
    const mcpData = await this.mcpClient.getPrice(assetSymbol);
    return {
      price: mcpData.price,
      priceChange24h: mcpData.priceChange24h ?? 0,
      volume24h: mcpData.volume24h ?? 0,
    };
  }

  /**
   * Cleanup on shutdown
   */
  protected async onShutdown(): Promise<void> {
    try {
      // Unsubscribe from 5-min signal ticker
      for (const unsub of this.fiveMinUnsubscribers) unsub();
      this.fiveMinUnsubscribers = [];
      this.cachedFiveMinSignal = null;
      this.cachedFiveMinHistory = null;
      await this.mcpClient.disconnect();
      logger.info('HedgingAgent shutdown complete', { agentId: this.agentId });
    } catch (error) {
      logger.error('Error during HedgingAgent shutdown', { error });
    }
  }

  /**
   * Execute task
   */
  protected async onExecuteTask(task: AgentTask): Promise<TaskResult> {
    // Support both 'action' and 'type' fields for compatibility with LeadAgent
    const taskAction = task.action || task.type || '';
    logger.info('Executing hedging task', { taskId: task.id, action: taskAction });

    try {
      switch (taskAction) {
        case 'analyze_hedge':
        case 'analyze-hedge':
          return await this.analyzeHedgeOpportunity(task);

        case 'open_hedge':
        case 'open-hedge':
          return await this.openHedgePosition(task);

        case 'close_hedge':
        case 'close-hedge':
          return await this.closeHedgePosition(task);

        case 'rebalance_hedge':
        case 'rebalance-hedge':
          return await this.rebalanceHedge(task);

        case 'create_strategy':
        case 'create-strategy':
        case 'create_hedge':
        case 'create-hedge':
          return await this.createHedgeStrategy(task);

        case 'monitor_positions':
        case 'monitor-positions':
          return await this.monitorPositions(task);

        default:
          // Return error for unknown actions
          logger.warn(`Unknown hedging action: ${taskAction}`, { taskId: task.id });
          return {
            success: false,
            data: null,
            error: `Unknown action: ${taskAction}`,
            executionTime: 0,
            agentId: this.agentId,
          };
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
   * Fetch the full aggregated prediction for an asset (Polymarket 5-min +
   * broad + Kalshi + Manifold + Delphi + AI interpretations + themes +
   * funding + alignment — all fused via PredictionAggregatorService).
   * Cached for 20s inside the aggregator, so per-call cost is a memory
   * lookup on hot paths. Returns null on any failure so callers can fall
   * back to legacy Delphi/5-min paths (fail-open).
   */
  private async getAggregatorSignal(asset: string): Promise<AggregatedPrediction | null> {
    try {
      const preds = await PredictionAggregatorService.getPerAssetPredictions([asset]);
      return preds[asset.toUpperCase()] ?? null;
    } catch (e) {
      logger.debug('HedgingAgent: aggregator fetch failed (fall-back to Delphi)', {
        asset, error: e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80),
      });
      return null;
    }
  }

  /**
   * Analyze hedging opportunity with Delphi prediction markets
   */
  private async analyzeHedgeOpportunity(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const { portfolioId, assetSymbol, notionalValue } = task.parameters as {
      portfolioId: string;
      assetSymbol: string;
      notionalValue: number;
    };

    if (!portfolioId || !assetSymbol || !notionalValue) {
      throw new Error('Missing required parameters: portfolioId, assetSymbol, or notionalValue');
    }

    try {
      // Get current market data — try centralized snapshot first, then MCP fallback
      const priceData = await this.getPriceFromSnapshotOrMCP(assetSymbol);
      if (!priceData) {
        throw new Error(`Could not retrieve price data for ${assetSymbol}`);
      }
      const volatility = await this.calculateVolatility(assetSymbol);

      // 🎯 Consult the full prediction aggregator (Polymarket 5-min +
      //    broad + Kalshi + Manifold + Delphi + AI interpretations +
      //    themes + Bluefin funding + cross-asset alignment — 12-20
      //    sources per asset). Was previously only reading Delphi +
      //    Polymarket 5-min directly, so HedgingAgent's LLM-reasoned
      //    recommendation overrode the aggregator-seeded directive with
      //    a partial-data opinion. Aggregator has a 20s cache so this
      //    is cheap even on hot paths (agent cycle + SUI cron tick).
      const aggPred = await this.getAggregatorSignal(assetSymbol);

      // 🔮 Delphi kept as fallback + AI-context input (reason string).
      const delphiInsights = await DelphiMarketService.getAssetInsights(assetSymbol);
      const highRiskPredictions = delphiInsights.predictions.filter(
        (p) => p.impact === 'HIGH' && p.probability > 60 && p.recommendation === 'HEDGE'
      );

      // ⚡ Proactive 5-min signal — always fresh via ticker subscription (no fetch delay)
      let fiveMinSignal: FiveMinBTCSignal | null = this.cachedFiveMinSignal;
      let fiveMinSignalHistory: FiveMinSignalHistory | null = this.cachedFiveMinHistory;

      // Freshness check: only use if less than 20 s old
      if (fiveMinSignal && Date.now() - fiveMinSignal.fetchedAt > 20_000) {
        logger.debug('HedgingAgent: 5-min signal too stale, discarding', {
          ageMs: Date.now() - fiveMinSignal.fetchedAt,
        });
        fiveMinSignal = null;
        fiveMinSignalHistory = null;
      }
      if (fiveMinSignal) {
        logger.info('5-min BTC signal available for hedge analysis (via ticker)', {
          direction: fiveMinSignal.direction,
          probability: fiveMinSignal.probability,
          confidence: fiveMinSignal.confidence,
          recommendation: fiveMinSignal.recommendation,
          streak: fiveMinSignalHistory?.streak,
          ageMs: Date.now() - fiveMinSignal.fetchedAt,
        });
      }

      // Determine hedge market (e.g., BTC-USD-PERP for BTC exposure)
      const hedgeMarket = `${assetSymbol}-USD-PERP`;
      let marketInfo;
      try {
        marketInfo = await this.moonlanderClient.getMarketInfo(hedgeMarket);
      } catch (e) {
        logger.warn('Market info unavailable, continuing with analysis', { hedgeMarket, error: e });
      }

      // Calculate optimal hedge ratio using delta-hedging approach
      // 🔮 NEW: Adjust hedge ratio based on Delphi predictions
      let hedgeRatio = await this.calculateOptimalHedgeRatio(
        assetSymbol,
        notionalValue,
        volatility
      );

      // 🎯 Boost hedge ratio when the AGGREGATOR emits a STRONG_HEDGE_*
      //    or HEDGE_* recommendation. Confidence × consensus scales the
      //    boost so a 80%-conf 80%-cons signal moves the ratio more
      //    than a 55/55 marginal one. Falls back to Delphi-only path
      //    when aggregator is unavailable (preserves prior behavior).
      let ratioBoosted = false;
      if (aggPred && (aggPred.recommendation.includes('STRONG_HEDGE') || aggPred.recommendation.startsWith('HEDGE_'))) {
        const strength = (aggPred.confidence / 100) * (aggPred.consensus / 100);
        const aggMultiplier = 1 + strength * (aggPred.recommendation.startsWith('STRONG_') ? 0.5 : 0.3);
        const original = hedgeRatio;
        hedgeRatio = Math.min(hedgeRatio * aggMultiplier, 1.0);
        ratioBoosted = true;
        logger.info('Hedge ratio adjusted from aggregator', {
          asset: assetSymbol,
          original, adjusted: hedgeRatio, aggMultiplier,
          rec: aggPred.recommendation,
          confidence: Math.round(aggPred.confidence),
          consensus: Math.round(aggPred.consensus),
          sources: aggPred.sources.length,
        });
      }

      // Delphi fallback — only applied when aggregator didn't already lift.
      if (!ratioBoosted && highRiskPredictions.length > 0) {
        const maxPredictionProb = Math.max(...highRiskPredictions.map((p) => p.probability));
        const delphiMultiplier = 1 + (maxPredictionProb - 50) / 100; // 60% prob -> 1.1x, 80% prob -> 1.3x
        hedgeRatio = Math.min(hedgeRatio * delphiMultiplier, 1.0); // Cap at 100% hedge
        logger.info('Hedge ratio adjusted based on Delphi predictions (aggregator-unavailable fallback)', {
          original: hedgeRatio / delphiMultiplier,
          adjusted: hedgeRatio,
          delphiMultiplier,
          predictions: highRiskPredictions.length,
        });
      }

      // ⚡ NEW: Further adjust hedge ratio based on 5-min BTC signal
      // Strong DOWN signals in real-time = increase urgency of hedge
      // Strong UP signals = can slightly relax hedge ratio
      if (fiveMinSignal && assetSymbol === 'BTC' && fiveMinSignal.signalStrength !== 'WEAK') {
        const fiveMinMultiplier =
          fiveMinSignal.direction === 'DOWN'
            ? 1 + (fiveMinSignal.probability - 50) / 200 // DOWN: 70% prob → 1.1x boost
            : 1 - (fiveMinSignal.probability - 50) / 400; // UP: 70% prob → 0.95x slight relaxation

        // If there's a streak, amplify the signal
        const streakAmplifier =
          fiveMinSignalHistory?.streak?.direction === fiveMinSignal.direction &&
          (fiveMinSignalHistory?.streak?.count ?? 0) >= 3
            ? 1.05
            : 1.0;

        hedgeRatio = Math.min(Math.max(hedgeRatio * fiveMinMultiplier * streakAmplifier, 0.1), 1.0);

        logger.info('Hedge ratio adjusted by 5-min BTC signal', {
          direction: fiveMinSignal.direction,
          probability: fiveMinSignal.probability,
          fiveMinMultiplier: (fiveMinMultiplier * streakAmplifier).toFixed(3),
          adjustedHedgeRatio: hedgeRatio.toFixed(4),
          streak: fiveMinSignalHistory?.streak,
        });
      }

      // Get funding rate (cost of holding perpetual) — may fail for assets without perps
      let avgFundingRate = 0;
      try {
        const fundingHistory = await this.moonlanderClient.getFundingHistory(hedgeMarket, 24);
        avgFundingRate =
          fundingHistory.reduce((sum, f) => {
            const v = parseFloat(f.rate);
            return sum + (isNaN(v) ? 0 : v);
          }, 0) / (fundingHistory.length || 1);
      } catch (e) {
        logger.warn('Funding rate data unavailable, using 0 (conservative)', {
          hedgeMarket,
          error: e,
        });
      }

      // Calculate hedge effectiveness
      const spotFutureCorrelation = await this.calculateSpotFutureCorrelation(assetSymbol);
      const hedgeEffectiveness = Math.pow(spotFutureCorrelation, 2) * 100;

      // Determine recommendation
      // Aggregator STRONG signal is a first-class hedge trigger.
      const aggregatorRecommendHedge =
        aggPred !== null &&
        (aggPred.recommendation.startsWith('STRONG_HEDGE') ||
          (aggPred.recommendation.startsWith('HEDGE_') && aggPred.confidence >= 60 && aggPred.consensus >= 55));
      const delphiRecommendHedge =
        delphiInsights.overallRisk === 'HIGH' || highRiskPredictions.length >= 2;
      const fiveMinRecommendHedge =
        fiveMinSignal?.recommendation === 'HEDGE_SHORT' &&
        fiveMinSignal.signalStrength === 'STRONG';
      const shouldHedge =
        (volatility > 0.3 || aggregatorRecommendHedge || delphiRecommendHedge || fiveMinRecommendHedge) &&
        hedgeEffectiveness > 70 &&
        Math.abs(avgFundingRate) < 0.01;

      // Build reason with Delphi insights + 5-min signal and AI analysis
      let reason = shouldHedge
        ? `High volatility (${(volatility * 100).toFixed(2)}%) warrants hedging`
        : 'Volatility acceptable, no immediate hedge needed';

      // ⚡ Append 5-min signal context when available
      if (fiveMinSignal && assetSymbol === 'BTC' && fiveMinSignal.signalStrength !== 'WEAK') {
        reason += ` | ⚡ 5-Min Signal: ${fiveMinSignal.direction} (${fiveMinSignal.probability}% prob, ${fiveMinSignal.signalStrength})`;
      }

      // 🤖 Use AI to enhance hedge reasoning
      //
      // Two paths (env-gated for safe rollout):
      //   1. Tool-use (HEDGING_AGENT_TOOL_USE=1 + OPENAI_API_KEY): the
      //      model can query recent hedges on this asset, active halts,
      //      and postmortem accuracy to inform its recommendation.
      //   2. Text-only (default): unchanged legacy conversation path.
      // Neither path changes trade DECISIONS — those come from
      // `shouldHedge` above. Both only enrich the human-readable
      // reason string so ops see the model's take alongside the rule
      // that fired.
      try {
        const predictionsSummary =
          highRiskPredictions.length > 0
            ? highRiskPredictions.map((p) => `${p.question} (${p.probability}%)`).join('; ')
            : 'No high-risk signals';

        const useTools =
          (process.env.HEDGING_AGENT_TOOL_USE || '').trim() === '1' &&
          (process.env.ASI_API_KEY || '').trim().length > 0;

        const contextPrompt = `Analyze this hedge opportunity:

Asset: ${assetSymbol}
Notional Value: $${notionalValue.toFixed(2)}
Current Price: $${priceData.price}
Volatility: ${(volatility * 100).toFixed(1)}%
Hedge Ratio: ${(hedgeRatio * 100).toFixed(1)}%
Funding Rate: ${(avgFundingRate * 100).toFixed(4)}%
Hedge Effectiveness: ${hedgeEffectiveness.toFixed(1)}%
Delphi Signals: ${predictionsSummary}

Should hedge: ${shouldHedge ? 'YES' : 'NO'}

Provide:
1. One-sentence hedge recommendation
2. Key risk factor to monitor

Be concise and actionable.`;

        let responseText: string;
        let responseModel: string | undefined;
        let toolCallCount = 0;

        if (useTools) {
          const { runWithTools } = await import('@/lib/services/ai/tool-runner');
          const toolResult = await runWithTools({
            systemPrompt: `You are a DeFi hedging strategist for the ZKward autonomous trading system. You have tools to query live state. Prefer query_hedge_history (for recent P&L on this asset) and get_cron_state (to check halt directives like "cron:haltUntil:sui-community-pool:autohedge") before finalizing your recommendation. Keep the tool loop short (≤3 calls). Do NOT propose executing trades — only enrich the reasoning.`,
            userPrompt: contextPrompt,
            maxIterations: 4,
          });
          responseText = toolResult.finalText;
          responseModel = 'openai:tool-use';
          toolCallCount = toolResult.invocations.length;
          logger.info('🤖 HedgingAgent tool-use complete', {
            asset: assetSymbol,
            tools: toolResult.invocations.map(i => `${i.tool}(${i.ok ? 'ok' : 'err'})`),
            iterations: toolResult.iterations,
          });
        } else {
          const { llmProvider } = await import('@/lib/ai/llm-provider');
          const aiResponse = await llmProvider.generateResponse(
            `${agentSystemPrompt('You are a DeFi hedging strategist.')}\n\n${contextPrompt}`,
            `hedge-${portfolioId}-${assetSymbol}`,
          );
          responseText = aiResponse.content;
          responseModel = aiResponse.model;
        }

        const aiLines = responseText.split(/\r?\n/).filter((l) => l.trim());
        if (aiLines.length > 0) {
          reason = `🤖 ${aiLines[0]} | ${reason}`;
        }

        logger.info('🤖 AI hedge analysis completed', {
          model: responseModel,
          asset: assetSymbol,
          toolCallCount,
        });
      } catch (error) {
        logger.warn('AI hedge analysis failed, using rule-based reasoning', { error });
      }

      if (delphiRecommendHedge && highRiskPredictions.length > 0) {
        const topPrediction = highRiskPredictions[0];
        reason = `🔮 Delphi: ${topPrediction.probability}% risk - "${topPrediction.question}". ${reason}`;
      }

      const analysis: HedgeAnalysis = {
        portfolioId,
        exposure: {
          asset: assetSymbol,
          notionalValue: notionalValue.toString(),
          currentPrice: priceData.price.toString(),
          volatility,
        },
        recommendation: {
          action: shouldHedge ? 'OPEN' : 'HOLD',
          market: hedgeMarket,
          side: 'SHORT', // Typically short perp to hedge long spot
          size: (notionalValue * hedgeRatio).toFixed(4),
          leverage: Math.min(
            Math.floor(1 / volatility),
            marketInfo?.maxLeverage ? Math.min(marketInfo.maxLeverage, 5) : 5
          ),
          reason,
        },
        riskMetrics: {
          portfolioVar: notionalValue * volatility * 1.65, // 95% confidence
          hedgeEffectiveness,
          basisRisk: (1 - spotFutureCorrelation) * 100,
          fundingCost: avgFundingRate * 100,
        },
        timestamp: Date.now(),
      };

      return {
        success: true,
        data: analysis,
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      const details =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { error: String(error) };
      logger.error('Failed to analyze hedge opportunity', details);
      throw error;
    }
  }

  /**
   * Get comprehensive AI market context for hedging decisions
   * Uses AIMarketIntelligence service for multi-source, multi-timeframe analysis
   */
  async getEnhancedMarketContext(assets: string[] = ['BTC', 'ETH', 'CRO', 'SUI']): Promise<{
    context: AIMarketContext;
    hedgingRecommendation: {
      shouldHedge: boolean;
      urgency: 'IMMEDIATE' | 'SOON' | 'MONITOR' | 'NO_ACTION';
      direction: 'SHORT' | 'LONG' | 'NEUTRAL';
      confidenceScore: number;
      reasons: string[];
      riskFactors: string[];
    };
  }> {
    const context = await AIMarketIntelligence.getMarketContext(assets);

    // Analyze context for hedging decision
    const reasons: string[] = [];
    const riskFactors: string[] = [];
    let shouldHedge = false;
    let urgency: 'IMMEDIATE' | 'SOON' | 'MONITOR' | 'NO_ACTION' = 'NO_ACTION';
    let direction: 'SHORT' | 'LONG' | 'NEUTRAL' = 'NEUTRAL';
    let confidenceScore = 50;

    // 1. Check risk cascade
    if (context.riskCascade.detected) {
      shouldHedge = true;
      urgency = context.riskCascade.recommendation === 'HEDGE_IMMEDIATELY' ? 'IMMEDIATE' : 'SOON';
      reasons.push(`Risk cascade detected (severity: ${context.riskCascade.severity}%)`);
      context.riskCascade.signals.forEach((s) => riskFactors.push(s.description));
      confidenceScore = Math.max(confidenceScore, context.riskCascade.confidence);
    }

    // 2. Check 5-min signal
    if (context.fiveMinSignal) {
      const signal = context.fiveMinSignal;
      if (signal.signalStrength === 'STRONG') {
        shouldHedge = true;
        direction = signal.direction === 'DOWN' ? 'SHORT' : 'LONG';
        urgency = urgency === 'NO_ACTION' ? 'SOON' : urgency;
        reasons.push(`Strong 5-min signal: ${signal.direction} (${signal.probability}%)`);
        confidenceScore = Math.max(confidenceScore, signal.confidence);
      }
    }

    // 3. Check streak analysis
    if (context.streaks.streak5Min.count >= 4 && context.streaks.streak5Min.direction !== 'MIXED') {
      const streakDir = context.streaks.streak5Min.direction;
      direction = streakDir === 'DOWN' ? 'SHORT' : streakDir === 'UP' ? 'LONG' : 'NEUTRAL';
      if (context.streaks.streak5Min.count >= 5) {
        shouldHedge = true;
        urgency = urgency === 'NO_ACTION' ? 'MONITOR' : urgency;
      }
      reasons.push(`${context.streaks.streak5Min.count}-signal ${streakDir} streak`);
    }

    // 4. Check 30-min and 4-hour trends for confirmation
    if (
      context.streaks.streak30Min.direction === context.streaks.streak5Min.direction &&
      context.streaks.trend4Hour.direction === context.streaks.streak5Min.direction
    ) {
      confidenceScore = Math.min(confidenceScore + 15, 95);
      reasons.push('Multi-timeframe trend alignment');
    }

    // 5. Check market sentiment
    if (context.marketSentiment.label === 'EXTREME_FEAR') {
      shouldHedge = true;
      direction = 'SHORT';
      reasons.push('Extreme fear sentiment detected');
      riskFactors.push('Market sentiment at extreme fear levels');
    } else if (context.marketSentiment.label === 'EXTREME_GREED') {
      riskFactors.push('Market sentiment at extreme greed - potential reversal risk');
    }

    // 6. Check cross-market correlation
    if (context.correlation.divergingAssets.length >= 2) {
      riskFactors.push(`${context.correlation.divergingAssets.length} assets diverging from BTC`);
    }
    if (context.correlation.correlationBoost > 0) {
      confidenceScore = Math.min(confidenceScore + context.correlation.correlationBoost, 95);
    }

    // 7. Adjust confidence for liquidity
    if (!context.liquidity.sufficientLiquidity) {
      confidenceScore += context.liquidity.liquidityConfidencePenalty;
      riskFactors.push('Low prediction market liquidity - signals less reliable');
    }

    // 8. Check HEDGE predictions
    const hedgePredictions = context.predictions.filter((p) => p.recommendation === 'HEDGE');
    if (hedgePredictions.length >= 2) {
      shouldHedge = true;
      urgency = urgency === 'NO_ACTION' ? 'MONITOR' : urgency;
      reasons.push(`${hedgePredictions.length} prediction markets recommend HEDGE`);
      hedgePredictions.slice(0, 2).forEach((p) => {
        riskFactors.push(`${p.question}: ${p.probability}%`);
      });
    }

    // Ensure confidence is bounded
    confidenceScore = Math.max(20, Math.min(95, confidenceScore));

    // If not hedging, set urgency appropriately
    if (!shouldHedge) {
      urgency = riskFactors.length > 0 ? 'MONITOR' : 'NO_ACTION';
      direction = 'NEUTRAL';
    }

    logger.info('Enhanced market context analyzed for hedging', {
      shouldHedge,
      urgency,
      direction,
      confidenceScore,
      reasonCount: reasons.length,
      riskFactorCount: riskFactors.length,
    });

    return {
      context,
      hedgingRecommendation: {
        shouldHedge,
        urgency,
        direction,
        confidenceScore,
        reasons,
        riskFactors,
      },
    };
  }

  /**
   * Open hedge position (on-chain or off-chain based on configuration)
   */
  private async openHedgePosition(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = task.parameters as {
      market: string;
      side: 'LONG' | 'SHORT';
      notionalValue: string;
      leverage?: number;
      stopLoss?: string;
      takeProfit?: string;
    };
    const { market, side, notionalValue, leverage, stopLoss, takeProfit } = parameters;

    try {
      // ═══════════════════════════════════════════════════════════
      // ON-CHAIN EXECUTION (via HedgeExecutor contract)
      // ═══════════════════════════════════════════════════════════
      if (this.useOnChainExecution && this.hedgeExecutorClient) {
        logger.info('Opening ON-CHAIN hedge position', { market, side, notionalValue });

        const result = await this.hedgeExecutorClient.openHedge({
          market,
          side,
          collateralAmount: notionalValue,
          leverage: Math.min(leverage || 1, 100),
        });

        this.onChainHedges.set(result.hedgeId, result);

        return {
          success: true,
          data: {
            hedgeId: result.hedgeId,
            txHash: result.txHash,
            market,
            side,
            collateralAmount: result.collateralAmount,
            leverage: result.leverage,
            openPrice: result.openPrice,
            executionMode: 'on-chain',
            commitmentHash: result.commitmentHash,
          },
          error: null,
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      // ═══════════════════════════════════════════════════════════
      // OFF-CHAIN EXECUTION (legacy MoonlanderClient REST API)
      // ═══════════════════════════════════════════════════════════
      logger.info('Opening hedge position (off-chain)', { market, side, notionalValue });

      // Support multiple MoonlanderClient interfaces used in tests/mocks
      const extClient = this.moonlanderClient as unknown as MoonlanderClientExt;
      let order: OrderResult;
      if (typeof extClient.openHedge === 'function') {
        order = await extClient.openHedge({
          market,
          side,
          notionalValue,
          leverage: leverage || 1,
          stopLoss,
          takeProfit,
        });
      } else {
        const marketInfo = await this.moonlanderClient.getMarketInfo(market);
        const markPrice = parseFloat(marketInfo.markPrice || '0');
        if (!Number.isFinite(markPrice) || markPrice <= 0) {
          throw new Error(
            `[HedgingAgent] Invalid mark price for ${market}: ${marketInfo.markPrice} — refusing to size order (would divide by zero)`
          );
        }
        const notional = parseFloat(notionalValue);
        if (!Number.isFinite(notional) || notional <= 0) {
          throw new Error(`[HedgingAgent] Invalid notional value: ${notionalValue}`);
        }
        const size = ((notional * (leverage || 1)) / markPrice).toFixed(4);

        if (typeof extClient.createOrder === 'function') {
          order = await extClient.createOrder({
            market,
            side: side === 'LONG' ? 'BUY' : 'SELL',
            type: 'MARKET',
            quantity: size,
          });
        } else {
          order = await this.moonlanderClient.placeOrder({
            market,
            side: side === 'LONG' ? 'BUY' : 'SELL',
            type: 'MARKET',
            size,
          });
        }

        // Place stop-loss if specified
        if (stopLoss) {
          const stopSide = side === 'LONG' ? 'SELL' : 'BUY';
          if (typeof extClient.createOrder === 'function') {
            await extClient.createOrder({
              market,
              side: stopSide,
              type: 'STOP_MARKET',
              quantity: size,
              stopPrice: stopLoss,
              reduceOnly: true,
              clientOrderId: `${order.orderId}-sl`,
            });
          } else {
            await this.moonlanderClient.placeOrder({
              market,
              side: stopSide,
              type: 'STOP_MARKET',
              size,
              stopPrice: stopLoss,
              reduceOnly: true,
              clientOrderId: `${order.orderId}-sl`,
            });
          }
        }

        // Place take-profit if specified
        if (takeProfit) {
          const tpSide = side === 'LONG' ? 'SELL' : 'BUY';
          if (typeof extClient.createOrder === 'function') {
            await extClient.createOrder({
              market,
              side: tpSide,
              type: 'LIMIT',
              quantity: size,
              price: takeProfit,
              reduceOnly: true,
              postOnly: true,
              clientOrderId: `${order.orderId}-tp`,
            });
          } else {
            await this.moonlanderClient.placeOrder({
              market,
              side: tpSide,
              type: 'LIMIT',
              size,
              price: takeProfit,
              reduceOnly: true,
              postOnly: true,
              clientOrderId: `${order.orderId}-tp`,
            });
          }
        }
      }

      // Log the hedge execution
      logger.info('Hedge position opened', {
        agentId: this.agentId,
        action: 'open_hedge',
        orderId: order.orderId,
        timestamp: Date.now(),
      });

      return {
        success: true,
        data: {
          orderId: order.orderId,
          market: order.market,
          side: order.side,
          size: order.size,
          avgFillPrice: order.avgFillPrice,
          status: order.status,
          leverage: Math.min(leverage || 1, 20),
        },
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to open hedge position', { error });
      throw error;
    }
  }

  /**
   * Close hedge position (on-chain or off-chain)
   */
  private async closeHedgePosition(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = task.parameters as { market: string; size: string; hedgeId?: string };
    const { market, size, hedgeId } = parameters;

    try {
      // ═══════════════════════════════════════════════════════════
      // ON-CHAIN CLOSE (via HedgeExecutor contract)
      // ═══════════════════════════════════════════════════════════
      if (this.useOnChainExecution && this.hedgeExecutorClient && hedgeId) {
        logger.info('Closing ON-CHAIN hedge position', { hedgeId, market });

        const result = await this.hedgeExecutorClient.closeHedge(hedgeId);
        this.onChainHedges.delete(hedgeId);

        return {
          success: true,
          data: {
            hedgeId,
            txHash: result.txHash,
            pnl: result.pnl,
            closePrice: result.closePrice,
            executionMode: 'on-chain',
          },
          error: null,
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      // ═══════════════════════════════════════════════════════════
      // OFF-CHAIN CLOSE (legacy)
      // ═══════════════════════════════════════════════════════════
      logger.info('Closing hedge position (off-chain)', { market });

      const order = await this.moonlanderClient.closePosition({ market, size });

      return {
        success: true,
        data: {
          orderId: order.orderId,
          market: order.market,
          closedSize: order.filledSize,
          avgExitPrice: order.avgFillPrice,
        },
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to close hedge position', { error });
      throw error;
    }
  }

  /**
   * Rebalance hedge
   */
  private async rebalanceHedge(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const parameters = task.parameters as { strategyId: string };
    const { strategyId } = parameters;

    try {
      const strategy = this.activeStrategies.get(strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      // Get current position. Support clients that expose getPosition or only getPositions
      const extClient = this.moonlanderClient as unknown as MoonlanderClientExt;
      let position: PerpetualPosition | null = null;
      if (typeof extClient.getPosition === 'function') {
        position = await extClient.getPosition(strategy.targetMarket);
      }

      if (!position && typeof extClient.getPositions === 'function') {
        const positions = await extClient.getPositions();
        position = positions.find((p) => p.market === strategy.targetMarket) || null;
      }

      if (!position) {
        logger.warn('No position to rebalance', { strategyId });
        return {
          success: true,
          data: { action: 'none', reason: 'No position found' },
          error: null,
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      // Analyze current hedge effectiveness
      const analysis = await this.analyzeHedgeOpportunity({
        id: `rebalance-${strategyId}`,
        action: 'analyze_hedge',
        parameters: {
          portfolioId: strategy.portfolioId,
          assetSymbol: strategy.targetMarket.split('-')[0],
          notionalValue: position.size,
        },
        priority: 1,
        createdAt: new Date(),
      });

      if (!analysis.success || !analysis.data) {
        throw new Error('Failed to analyze hedge');
      }

      const hedgeAnalysis = analysis.data as HedgeAnalysis;

      // Check if rebalance is needed
      const currentSize = parseFloat(position.size);
      const targetSize = parseFloat(hedgeAnalysis.recommendation.size);
      const sizeChange = Math.abs((currentSize - targetSize) / currentSize) * 100;

      if (sizeChange > strategy.rebalanceThreshold) {
        // Adjust position size
        const adjustmentSize = Math.abs(targetSize - currentSize).toFixed(4);
        const adjustmentSide =
          targetSize > currentSize
            ? position.side === 'LONG'
              ? 'BUY'
              : 'SELL'
            : position.side === 'LONG'
              ? 'SELL'
              : 'BUY';

        let order: OrderResult;
        const rebalExtClient = this.moonlanderClient as unknown as MoonlanderClientExt;
        if (typeof rebalExtClient.createOrder === 'function') {
          order = await rebalExtClient.createOrder({
            market: strategy.targetMarket,
            side: adjustmentSide,
            type: 'MARKET',
            quantity: adjustmentSize,
          });
        } else {
          order = await this.moonlanderClient.placeOrder({
            market: strategy.targetMarket,
            side: adjustmentSide,
            type: 'MARKET',
            size: adjustmentSize,
          });
        }

        return {
          success: true,
          data: {
            action: 'rebalanced',
            oldSize: currentSize,
            newSize: targetSize,
            orderId: order.orderId,
          },
          error: null,
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      }

      return {
        success: true,
        data: { action: 'hold', reason: 'Within rebalance threshold' },
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to rebalance hedge', { error });
      throw error;
    }
  }

  /**
   * Create hedge strategy
   */
  private async createHedgeStrategy(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    const params = task.parameters as Record<string, unknown>;
    const chain = (params.chain as string) || task.chain || 'cronos';

    if (chain === 'sui') {
      try {
        const { getSuiAutoHedgingAdapter } =
          await import('../../lib/services/sui/SuiAutoHedgingAdapter');
        const suiAdapter = getSuiAutoHedgingAdapter();
        const riskResult = await suiAdapter.assessRisk(
          (params.portfolioId as string) || 'community-pool'
        );
        logger.info('SUI hedge strategy created via SuiAutoHedgingAdapter', {
          chain,
          recommendations: riskResult.recommendations?.length || 0,
        });
        return {
          success: true,
          data: {
            strategyId: `sui-strategy-${Date.now()}`,
            chain: 'sui',
            riskScore: riskResult.riskScore,
            recommendations: riskResult.recommendations,
            active: true,
          },
          error: null,
          executionTime: Date.now() - startTime,
          agentId: this.agentId,
        };
      } catch (error) {
        logger.warn('SUI hedge adapter failed, using generic strategy', { error });
      }
    }

    // ── Default: generic strategy ──
    const strategy: HedgeStrategy = {
      strategyId: `strategy-${Date.now()}`,
      ...(params as Omit<HedgeStrategy, 'strategyId' | 'active'>),
      active: true,
    };

    this.activeStrategies.set(strategy.strategyId, strategy);

    logger.info('Hedge strategy created', { strategyId: strategy.strategyId, chain });

    return {
      success: true,
      data: { ...strategy, chain },
      error: null,
      executionTime: Date.now() - startTime,
      agentId: this.agentId,
    };
  }

  /**
   * Monitor positions
   */
  private async monitorPositions(_task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();

    try {
      // Get all positions (guard if client only exposes getPositions)
      const monExtClient = this.moonlanderClient as unknown as MoonlanderClientExt;
      const positions: PerpetualPosition[] =
        typeof monExtClient.getPositions === 'function' ? await monExtClient.getPositions() : [];

      // Calculate liquidation risks if available on the client
      const risks: LiquidationRisk[] =
        typeof monExtClient.calculateLiquidationRisk === 'function'
          ? await monExtClient.calculateLiquidationRisk()
          : [];

      // Check each position against strategies
      const alerts = [];
      for (const position of positions) {
        const risk = risks.find((r) => r.positionId === position.positionId);

        if (risk && (risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL')) {
          alerts.push({
            positionId: position.positionId,
            market: position.market,
            riskLevel: risk.riskLevel,
            distanceToLiquidation: risk.distanceToLiquidation,
            action: 'ADD_MARGIN_OR_REDUCE_SIZE',
          });

          // Auto-add margin if critical
          if (risk.riskLevel === 'CRITICAL') {
            const marginToAdd = (parseFloat(position.margin) * 0.5).toFixed(6);
            await this.moonlanderClient.addMargin(position.market, marginToAdd);
            logger.warn('Emergency margin added', { market: position.market, amount: marginToAdd });
          }
        }
      }

      return {
        success: true,
        data: {
          positions: positions.length,
          alerts,
          timestamp: Date.now(),
        },
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.agentId,
      };
    } catch (error) {
      logger.error('Failed to monitor positions', { error });
      throw error;
    }
  }

  /**
   * Calculate optimal hedge ratio using minimum variance approach
   * h* = ρ × (σ_spot / σ_futures) — adjusted for position size and volatility regime
   */
  private async calculateOptimalHedgeRatio(
    assetSymbol: string,
    notionalValue: number,
    volatility: number
  ): Promise<number> {
    try {
      // Get spot-future correlation (already uses real data)
      const correlation = await this.calculateSpotFutureCorrelation(assetSymbol);
      const finalRatio = optimalHedgeRatio({ correlation, volatility, notionalValue });

      logger.info('Calculated optimal hedge ratio', {
        assetSymbol,
        correlation,
        volatility: (volatility * 100).toFixed(1) + '%',
        notionalValue,
        finalRatio: (finalRatio * 100).toFixed(1) + '%',
      });

      return finalRatio;
    } catch (error) {
      logger.warn('Hedge ratio calculation fallback to volatility-based', {
        assetSymbol,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback: volatility-based heuristic (still uses real vol, not hardcoded)
      return Math.max(0.3, Math.min(0.5 + volatility * 0.5, 1.0));
    }
  }

  /**
   * Calculate asset volatility from real candlestick data
   */
  private async calculateVolatility(assetSymbol: string): Promise<number> {
    try {
      const historicalPrices = await this.mcpClient.getHistoricalPrices(
        assetSymbol,
        '1d',
        30 // 30 days
      );

      if (historicalPrices.length < 5) {
        throw new Error(`Insufficient candlestick data: got ${historicalPrices.length} candles`);
      }

      const returns = logReturns(historicalPrices.map((p) => p.price));
      if (returns.length < 3) throw new Error('Not enough valid returns for volatility');
      const volatility = annualizedVolatility(returns);
      const dailyVol = volatility / Math.sqrt(365);

      logger.info('Calculated real volatility from Exchange candlestick data', {
        assetSymbol,
        dataPoints: returns.length,
        dailyVol: (dailyVol * 100).toFixed(2) + '%',
        annualizedVol: (volatility * 100).toFixed(2) + '%',
      });

      return volatility;
    } catch (error) {
      logger.warn('Real volatility calculation failed, deriving from current price data', {
        assetSymbol,
        error: error instanceof Error ? error.message : String(error),
      });

      // Last resort: derive approximate volatility from current 24h price change
      // This is a rough estimate but still uses REAL data, not hardcoded values
      try {
        const currentPrice = await this.getPriceFromSnapshotOrMCP(assetSymbol);
        const change24h = Math.abs(currentPrice.priceChange24h || 0) / 100; // as decimal
        // Rough annualization: daily move × sqrt(365)
        // 24h change is one sample of daily volatility
        const approxVol = Math.max(change24h, 0.01) * Math.sqrt(365);
        // Clamp to reasonable crypto range [0.1, 2.0]
        const clampedVol = Math.max(0.1, Math.min(2.0, approxVol));

        logger.info('Derived volatility from 24h price change', {
          assetSymbol,
          change24h: (change24h * 100).toFixed(2) + '%',
          derivedVol: (clampedVol * 100).toFixed(2) + '%',
        });

        return clampedVol;
      } catch (priceError) {
        logger.error('All volatility data sources failed', { assetSymbol, error: priceError });
        throw new Error(`Cannot calculate volatility for ${assetSymbol}: no data available`);
      }
    }
  }

  /**
   * Calculate spot-future correlation using real candlestick data
   * Compares spot and perpetual price returns from Exchange API
   */
  private async calculateSpotFutureCorrelation(assetSymbol: string): Promise<number> {
    try {
      // Get real spot candlestick data
      const spotPrices = await this.mcpClient.getHistoricalPrices(assetSymbol, '1d', 30);

      // Get real perpetual candlestick data
      let perpPrices: { price: number }[] = [];
      try {
        const perpData = await this.mcpClient.getHistoricalPrices(assetSymbol, '1d', 30, 'perp');
        perpPrices = perpData;
      } catch {
        logger.info('No perp candlestick data available, using spot self-analysis', {
          assetSymbol,
        });
      }

      // Case 1: Both spot and perp data available → real Pearson correlation
      if (spotPrices.length >= 10 && perpPrices.length >= 10) {
        const spotReturns = logReturns(spotPrices.map((p) => p.price));
        const perpReturns = logReturns(perpPrices.map((p) => p.price));
        const n = Math.min(spotReturns.length, perpReturns.length);
        if (n >= 5) {
          const spotSlice = spotReturns.slice(0, n);
          const perpSlice = perpReturns.slice(0, n);
          const rawCorrelation = pearsonCorrelation(spotSlice, perpSlice);
          if (rawCorrelation === 0) {
            // Degenerate variance — fall back to autocorrelation-based estimate
            const autocorr = lag1Autocorrelation(spotSlice);
            const correlation = Math.max(0.5, Math.min(0.99, 1 - autocorr * 0.4));
            logger.info('Spot-perp correlation from autocorrelation (degenerate variance)', {
              assetSymbol, autocorr, correlation, dataPoints: n,
            });
            return correlation;
          }
          const correlation = Math.max(0.5, Math.min(1.0, Math.abs(rawCorrelation)));
          logger.info('Calculated real spot-perp correlation from Exchange candlestick data', {
            assetSymbol, correlation, dataPoints: n,
          });
          return correlation;
        }
      }

      // Case 2: Only spot data → derive correlation proxy from market efficiency
      if (spotPrices.length >= 10) {
        const spotReturns = logReturns(spotPrices.map((p) => p.price));
        if (spotReturns.length >= 5) {
          const avgVolume =
            spotPrices.reduce((sum, p) => sum + (p.volume24h || 0), 0) / spotPrices.length;
          const dailyVol = annualizedVolatility(spotReturns) / Math.sqrt(365);
          const autocorr = lag1Autocorrelation(spotReturns);
          const correlation = deriveCorrelationFromMarketProxy({
            volume: avgVolume, dailyVol, autocorr,
          });
          logger.info('Derived spot-perp correlation from volume and volatility', {
            assetSymbol,
            avgVolume: avgVolume.toFixed(0),
            dailyVol: (dailyVol * 100).toFixed(2) + '%',
            correlation,
          });
          return correlation;
        }
      }

      // Case 3: Minimal data — derive from real ticker volume + price change
      const currentPrice = await this.getPriceFromSnapshotOrMCP(assetSymbol);
      const volume = currentPrice.volume24h || 0;
      const priceChange = Math.abs(currentPrice.priceChange24h || 0) / 100; // as decimal
      // Continuous formula: log volume score adjusted by 24h volatility
      const volScore = volume > 0 ? Math.min(1, Math.log10(volume) / 10) : 0;
      const volAdjust = priceChange * 0.3; // Higher daily move → more basis divergence
      const tickerCorr = Math.max(0.5, Math.min(0.99, 0.5 + volScore * 0.47 - volAdjust));
      logger.info('Derived correlation from real ticker data (minimal candlestick)', {
        assetSymbol,
        volume: volume.toFixed(0),
        priceChange: (priceChange * 100).toFixed(2) + '%',
        correlation: tickerCorr,
      });
      return tickerCorr;
    } catch (error) {
      logger.warn('Spot-future correlation using ticker-based estimate', {
        assetSymbol,
        error: error instanceof Error ? error.message : String(error),
      });

      // Even as a last resort, try to use real volume + change data
      try {
        const spot = await this.getPriceFromSnapshotOrMCP(assetSymbol);
        const volume = spot.volume24h || 0;
        const change = Math.abs(spot.priceChange24h || 0) / 100;
        const volScore = volume > 0 ? Math.min(1, Math.log10(volume) / 10) : 0;
        const fallbackCorr = Math.max(0.5, Math.min(0.99, 0.5 + volScore * 0.47 - change * 0.3));
        logger.info('Last-resort correlation from real ticker', {
          assetSymbol,
          correlation: fallbackCorr,
        });
        return fallbackCorr;
      } catch {
        // Absolute last resort - but this path should be extremely rare
        logger.error('All correlation data sources failed', { assetSymbol });
        throw new Error(`Cannot calculate correlation for ${assetSymbol}: no data available`);
      }
    }
  }

  /**
   * Independently evaluate a proposed execution and return a vote.
   * Called by LeadAgent during multi-agent consensus — the HedgingAgent
   * uses its own market data, Delphi signals, and 5-min Polymarket signal
   * to independently decide whether execution should proceed.
   */
  async voteOnExecution(proposal: {
    executionId: string;
    action: string;
    estimatedPositionSize: number;
    // Optional context (LeadAgent doesn't currently pass these; when it does
    // we get asset-specific voting instead of BTC-default).
    asset?: string;
    proposedSide?: 'LONG' | 'SHORT';
    riskAnalysis?: { totalRisk: number; volatility: number };
    predictionContext?: string;
  }): Promise<{ approved: boolean; reason: string }> {
    try {
      const asset = (proposal.asset ?? 'BTC').toUpperCase();
      // Fetch current volatility from real market data
      let volatility = proposal.riskAnalysis?.volatility ?? -1;
      if (volatility < 0) {
        try {
          volatility = await this.calculateVolatility(asset);
        } catch {
          volatility = 0.5; // Conservative fallback
        }
      }

      // 🎯 Aggregator-derived penalty is the primary signal input. Fused
      //    across all 12-20 sources for the asset. If aggregator can't
      //    be reached the code falls through to the legacy Delphi +
      //    Polymarket-5min penalties below (fail-open behavior preserved).
      let aggregatorPenalty = 0;
      const aggPred = await this.getAggregatorSignal(asset);
      if (aggPred) {
        // Direction opposition: aggregator says one way, proposed side goes
        // the other. Penalty scales with confidence × consensus so a
        // marginal 55/55 disagreement barely nudges but a 85/75 outright
        // conflict strongly opposes.
        if (proposal.proposedSide) {
          const proposedDir: 'UP' | 'DOWN' = proposal.proposedSide === 'LONG' ? 'UP' : 'DOWN';
          if (aggPred.direction !== 'NEUTRAL' && aggPred.direction !== proposedDir) {
            const strength = (aggPred.confidence / 100) * (aggPred.consensus / 100);
            aggregatorPenalty += Math.min(30, 10 + strength * 25);
          }
        }
        // Low-confidence / low-consensus signal → smaller nudge for uncertainty.
        if (aggPred.confidence < 55 || aggPred.consensus < 55) {
          aggregatorPenalty += 5;
        }
        // STRONG_HEDGE_* recommendations bring their own weight regardless
        // of the proposed side — the aggregator is telling us the market
        // is at risk.
        if (aggPred.recommendation.startsWith('STRONG_HEDGE')) {
          aggregatorPenalty += 10;
        }
      }

      // Factor in 5-min Polymarket BTC signal (legacy, still used as
      // fallback when aggregator missed — cheap since it's just a cached
      // read).
      let signalPenalty = 0;
      const signal = this.cachedFiveMinSignal;
      if (!aggPred && signal && Date.now() - signal.fetchedAt < 20_000) {
        if (signal.direction === 'DOWN' && signal.signalStrength === 'STRONG') {
          signalPenalty = 15; // Strong bearish → increase risk concern
        } else if (signal.direction === 'DOWN' && signal.signalStrength === 'MODERATE') {
          signalPenalty = 5;
        }
      }

      // Legacy Delphi penalty — used only when aggregator is unavailable.
      // When aggregator IS available, Delphi is already one of its inputs
      // (weighted 5-15%) so double-counting here would over-penalize.
      let delphiPenalty = 0;
      if (!aggPred) {
        try {
          const { DelphiMarketService } =
            await import('../../lib/services/market-data/DelphiMarketService');
          const btcInsights = await DelphiMarketService.getAssetInsights(asset);
          const highRiskHedge = btcInsights.predictions.filter(
            (p) => p.impact === 'HIGH' && p.probability > 60 && p.recommendation === 'HEDGE'
          );
          if (highRiskHedge.length >= 2) {
            delphiPenalty = 10;
          } else if (highRiskHedge.length >= 1) {
            delphiPenalty = 5;
          }
        } catch {
          // Delphi unavailable — no adjustment
        }
      }

      // Decision logic:
      //  - Annualized volatility ≥ 150% → reject (extreme market)
      //  - Position > $10M → reject (automated-only safeguard)
      //  - Effective risk (volatility-based + signal/Delphi/aggregator) ≥ 80 → reject
      //  - Analysis-only actions → always approve
      const isAnalysisOnly = proposal.action === 'analyze' || proposal.action === 'analysis';
      const effectiveRisk = Math.min(100, volatility * 50 + signalPenalty + delphiPenalty + aggregatorPenalty);
      const volatilityAcceptable = volatility < 1.5;
      const positionSizeAcceptable = proposal.estimatedPositionSize <= 10_000_000;
      const riskAcceptable = effectiveRisk < 80;

      const approved =
        isAnalysisOnly || (volatilityAcceptable && positionSizeAcceptable && riskAcceptable);

      const reason = approved
        ? `Market conditions acceptable (vol: ${(volatility * 100).toFixed(1)}%, risk: ${effectiveRisk.toFixed(1)}, size: $${proposal.estimatedPositionSize.toLocaleString()})`
        : `Market conditions unfavorable (vol: ${(volatility * 100).toFixed(1)}%, risk: ${effectiveRisk.toFixed(1)}, size: $${proposal.estimatedPositionSize.toLocaleString()})`;

      logger.info('🗳️ HedgingAgent independent vote', {
        executionId: proposal.executionId,
        asset,
        approved,
        volatility,
        effectiveRisk,
        signalPenalty,
        delphiPenalty,
        aggregatorPenalty,
        aggSources: aggPred ? aggPred.sources.length : 0,
        aggDir: aggPred?.direction ?? null,
        reason,
        agentId: this.agentId,
      });

      return { approved, reason };
    } catch (error) {
      logger.error('HedgingAgent vote failed — defaulting to cautious reject', {
        error,
        agentId: this.agentId,
      });
      return {
        approved: false,
        reason: `Vote evaluation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Start monitoring active strategies
   */
  startMonitoring(intervalMs: number = 60000): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    this.monitoringInterval = setInterval(async () => {
      try {
        this.enqueueTask({
          id: `monitor-${Date.now()}`,
          action: 'monitor_positions',
          parameters: {},
          priority: 1,
          createdAt: new Date(),
        });
      } catch (error) {
        logger.error('Monitoring error', { error });
      }
    }, intervalMs);

    logger.info('Hedge monitoring started', { intervalMs });
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      logger.info('Hedge monitoring stopped');
    }
  }

  /**
   * Shutdown agent
   */
  async shutdown(): Promise<void> {
    this.stopMonitoring();
    await this.moonlanderClient.disconnect();
    await this.mcpClient.disconnect();
    await super.shutdown();
  }
}
