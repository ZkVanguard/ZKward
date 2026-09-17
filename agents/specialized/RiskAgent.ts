/**
 * @fileoverview Risk Agent - Analyzes portfolio risk and provides recommendations
 * @module agents/specialized/RiskAgent
 * 
 * Enhanced with AIMarketIntelligence for comprehensive risk assessment:
 * - Multi-timeframe streak analysis
 * - Cross-market correlation
 * - Risk cascade detection
 * - Market sentiment analysis
 */

import { BaseAgent } from '../core/BaseAgent';
import { logger } from '@shared/utils/logger';
import { AgentTask, AgentMessage, RiskAnalysis, TaskResult } from '@shared/types/agent';
import { ethers } from 'ethers';
import type { FiveMinBTCSignal, SignalEvent } from '../../lib/services/market-data/Polymarket5MinService';
import { AIMarketIntelligence, type AIMarketContext } from '../../lib/services/AIMarketIntelligence';
import { agentSystemPrompt } from '../../lib/services/ai/model-constitution';
import type { CanonicalRiskInputs } from '../../zk/prover/riskCanonical';

/**
 * Compliance threshold the STARK proof asserts `totalRisk` stays below.
 * Env override: RISK_ZK_THRESHOLD (0..100). Default 100 = permissive
 * (proof always asserts a true claim as long as the risk math is
 * honest). Set lower to force circuit breaker on high-risk states.
 */
const RISK_THRESHOLD_DEFAULT = Math.min(
  100,
  Math.max(0, Number(process.env.RISK_ZK_THRESHOLD ?? 100)),
);

/**
 * Risk Agent specializing in risk analysis and assessment
 */
export class RiskAgent extends BaseAgent {
  private provider?: ethers.Provider;
  private signer?: ethers.Wallet | ethers.Signer;
  private rwaManagerAddress?: string;

  // ── Proactive 5-min signal (pushed by ticker) ──────────
  private cachedFiveMinSignal: FiveMinBTCSignal | null = null;
  private fiveMinUnsubscribers: (() => void)[] = [];

  constructor(
    agentId: string,
    provider?: ethers.Provider,
    signer?: ethers.Wallet | ethers.Signer,
    rwaManagerAddress?: string
  ) {
    super(agentId, 'risk', ['RISK_ANALYSIS', 'PORTFOLIO_MANAGEMENT', 'MARKET_INTEGRATION']);
    this.provider = provider;
    this.signer = signer;
    this.rwaManagerAddress = rwaManagerAddress;
  }

  protected async onInitialize(): Promise<void> {
    logger.info('Risk Agent initializing...', { agentId: this.id });
    
    // Connect to MCP Server for data feeds
    await this.connectToDataSources();

    // Subscribe to the proactive 5-min signal ticker — never late
    try {
      const { Polymarket5MinService } = await import('../../lib/services/market-data/Polymarket5MinService');
      this.fiveMinUnsubscribers.push(
        Polymarket5MinService.on('signal:update', (evt: SignalEvent) => {
          this.cachedFiveMinSignal = evt.signal;
        }),
        Polymarket5MinService.on('signal:direction-flip', (evt: SignalEvent) => {
          logger.info('RiskAgent: 5-min direction flipped', {
            from: evt.previous?.direction, to: evt.signal.direction,
            probability: evt.signal.probability, agentId: this.id,
          });
        }),
      );
      // Seed with current signal so we're never empty on first assessment
      this.cachedFiveMinSignal = await Polymarket5MinService.getLatest5MinSignal();
      logger.info('RiskAgent subscribed to 5-min signal ticker', { agentId: this.id });
    } catch {
      logger.debug('RiskAgent: 5-min signal ticker unavailable at init');
    }
    
    logger.info('Risk Agent initialized successfully', { agentId: this.id });
  }

  protected async onExecuteTask(task: AgentTask): Promise<TaskResult> {
    const startTime = Date.now();
    try {
      let data: unknown;
      // Support both 'type' and 'action' fields for backwards compatibility
      const taskAction = task.action || task.type || '';
      const parameters = task.parameters || task.payload || {};
      
      switch (taskAction) {
        case 'analyze_risk':
        case 'analyze-risk':
          data = await this.analyzeRisk(parameters);
          break;
        case 'calculate_volatility':
        case 'calculate-volatility':
          data = await this.calculateVolatility(parameters as { portfolioId: number });
          break;
        case 'analyze_exposures':
        case 'analyze-exposures':
          data = await this.analyzeExposures(parameters as { portfolioId: number });
          break;
        case 'assess_sentiment':
        case 'assess-sentiment':
          data = await this.assessMarketSentiment(parameters as { market?: string });
          break;
        default:
          // Return success with empty data for unknown actions (graceful degradation)
          logger.warn(`Unknown task action: ${taskAction}`, { taskId: task.id });
          data = { message: `Unknown action: ${taskAction}`, handled: false };
      }
      return {
        success: true,
        data,
        error: null,
        executionTime: Date.now() - startTime,
        agentId: this.id,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        agentId: this.id,
      };
    }
  }

  protected onMessageReceived(message: AgentMessage): void {
    logger.debug('Risk Agent received message', {
      agentId: this.id,
      messageType: message.type,
      from: message.from,
    });

    // Handle specific message types
    const payload = message.payload as { action?: string };
    if (message.type === 'request' && payload.action === 'analyze-risk') {
      this.enqueueTask({
        id: message.id,
        type: 'analyze-risk',
        status: 'queued',
        priority: 1,
        payload: message.payload,
        createdAt: new Date(),
      });
    }
  }

  protected async onShutdown(): Promise<void> {
    logger.info('Risk Agent shutting down...', { agentId: this.id });
    // Unsubscribe from 5-min signal ticker
    for (const unsub of this.fiveMinUnsubscribers) unsub();
    this.fiveMinUnsubscribers = [];
    this.cachedFiveMinSignal = null;
    await this.disconnectFromDataSources();
  }

  /**
   * Connect to data sources (MCP Server, Delphi, etc.)
   */
  private async connectToDataSources(): Promise<void> {
    // In production, establish connections to:
    // - MCP Server for real-time data
    // - Delphi for prediction markets
    // - Price oracles
    logger.info('Connected to data sources', { agentId: this.id });
  }

  /**
   * Disconnect from data sources
   */
  private async disconnectFromDataSources(): Promise<void> {
    logger.info('Disconnected from data sources', { agentId: this.id });
  }

  /**
   * Analyze portfolio risk with AI-powered reasoning
   */
  private async analyzeRisk(payload: unknown): Promise<RiskAnalysis> {
    const params = payload as { 
      portfolioId?: number;
      address?: string;
      predictionContext?: string;
      chain?: string;
      portfolioData?: {
        totalValue: number;
        tokens: Array<{ symbol: string; balance: number; usdValue: number }>;
      };
    };
    
    const portfolioId = params.portfolioId ?? parseInt(params.address?.split('-')[1] || '0', 10);
    const portfolioData = params.portfolioData;
    const predictionContext = params.predictionContext || '';
    const chain = params.chain || 'cronos';

    logger.info('Analyzing portfolio risk with AI', {
      agentId: this.id,
      portfolioId,
      chain,
      hasData: !!portfolioData,
    });

    // 1. Calculate mathematical metrics
    const volatility = await this.calculateVolatilityInternal(portfolioId);
    const exposures = await this.calculateExposures(portfolioId, chain);
    const sentiment = await this.assessMarketSentimentInternal();

    // Calculate base risk score (0-100)
    const baseRiskScore = Math.min(
      100,
      volatility * 50 + exposures.reduce((sum, exp) => sum + exp.contribution, 0)
    );

    // 2. Use AI to analyze risk and generate intelligent recommendations
    let totalRisk = baseRiskScore;
    let aiRiskScoreForBinding: number | null = null;
    let aiRecommendations: string[] = [];
    
    try {
      const portfolioSummary = portfolioData?.tokens
        ? portfolioData.tokens
            .map(t => `${t.symbol}: $${t.usdValue.toFixed(2)} (${((t.usdValue / portfolioData.totalValue) * 100).toFixed(1)}%)`)
            .join(', ')
        : 'Portfolio data unavailable';

      const portfolioValue = portfolioData?.totalValue || 0;

      // Two AI paths:
      //   1. Tool-use (RISK_AGENT_TOOL_USE=1 + OPENAI_API_KEY): the model
      //      can query recent hedges, postmortem stats, spot prices, and
      //      pool state directly to inform its recommendations.
      //   2. Text-only (default): unchanged legacy path via llmProvider,
      //      routes through Crypto.com/ASI/OpenAI/Claude chain.
      // Both paths return the same RISK_SCORE + REC1-3 shape.
      const useTools =
        (process.env.RISK_AGENT_TOOL_USE || '').trim() === '1' &&
        (process.env.ASI_API_KEY || '').trim().length > 0;

      const systemPrompt = useTools
        ? `You are a DeFi risk analyst for the ZKward autonomous trading system. You have tools to query live state — use them to ground your analysis in real numbers, not just the summary provided. Prefer calling query_hedge_history, query_postmortem_stats, and get_cron_state to inform your view. Keep the tool loop short (≤3 calls).`
        : `You are a DeFi risk analyst. Provide concise, actionable risk analysis.`;

      const aiPrompt = `Analyze portfolio risk:
Value: $${portfolioValue.toFixed(2)}
Assets: ${portfolioSummary}
Volatility: ${(volatility * 100).toFixed(1)}%
Sentiment: ${sentiment}
Base Risk: ${baseRiskScore.toFixed(1)}/100${predictionContext ? `\n${predictionContext}` : ''}

Respond EXACTLY like this:
RISK_SCORE: [0-100]
REC1: [first recommendation]
REC2: [second recommendation]
REC3: [third recommendation]`;

      let responseText: string;
      let responseModel: string | undefined;
      let toolCallCount = 0;

      if (useTools) {
        const { runWithTools } = await import('@/lib/services/ai/tool-runner');
        const toolResult = await runWithTools({
          systemPrompt,
          userPrompt: aiPrompt,
          maxIterations: 4,
        });
        responseText = toolResult.finalText;
        responseModel = 'openai:tool-use';
        toolCallCount = toolResult.invocations.length;
        logger.info('🤖 RiskAgent tool-use complete', {
          tools: toolResult.invocations.map(i => `${i.tool}(${i.ok ? 'ok' : 'err'})`),
          iterations: toolResult.iterations,
        });
      } else {
        const { llmProvider } = await import('@/lib/ai/llm-provider');
        const aiResponse = await llmProvider.generateDirectResponse(
          aiPrompt,
          agentSystemPrompt(systemPrompt),
        );
        responseText = aiResponse.content;
        responseModel = aiResponse.model;
      }

      // Extract AI recommendations — validate length/content
      const lines = responseText.split('\n').filter(l => l.trim());
      
      // Parse recommendations with validation
      for (const line of lines) {
        const recMatch = line.match(/^REC\d*:?\s*(.+)/i);
        if (recMatch && recMatch[1].length > 5 && recMatch[1].length < 200) {
          const rec = recMatch[1].trim();
          // Reject suspicious LLM output
          if (!/unlimited|ignore|override|bypass/i.test(rec)) {
            aiRecommendations.push(`🤖 ${rec}`);
          }
        }
      }
      
      // Try to extract adjusted risk score — clamp to 0-100
      const scoreMatch = responseText.match(/RISK_SCORE:?\s*(\d+)/i);
      if (scoreMatch) {
        const aiRiskScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1], 10)));
        totalRisk = Math.min(100, Math.round((baseRiskScore + aiRiskScore) / 2));
        aiRiskScoreForBinding = aiRiskScore;
        logger.info('🤖 AI adjusted risk score', { base: baseRiskScore, ai: aiRiskScore, final: totalRisk });
      }

      logger.info('🤖 AI risk analysis completed', {
        model: responseModel,
        recommendations: aiRecommendations.length,
        toolCallCount,
      });
    } catch (error) {
      logger.warn('AI risk analysis failed, using rule-based fallback', { error });
      aiRecommendations = this.generateRecommendations(totalRisk, volatility, sentiment, exposures);
    }

    const analysis: RiskAnalysis = {
      portfolioId,
      timestamp: new Date(),
      totalRisk,
      volatility,
      exposures,
      recommendations: aiRecommendations.length > 0 ? aiRecommendations : this.generateRecommendations(totalRisk, volatility, sentiment, exposures),
      marketSentiment: sentiment,
    };

    logger.info('Risk analysis completed', {
      agentId: this.id,
      portfolioId,
      totalRisk,
      volatility,
      aiEnhanced: aiRecommendations.length > 0,
    });

    // Build the canonical binding tuple — everything the STARK proof
    // needs to prove `f(inputs) → totalRisk`. Portfolio value comes
    // from the resolved portfolioData; before this refactor it was
    // hardcoded to $10M in ProofGenerator, so proofs were meaningless
    // as a NAV attestation.
    const { SENTIMENT_CODE } = await import('@shared/../zk/prover/riskCanonical');
    const canonicalInputs = {
      version: 1 as const,
      portfolioId,
      chain,
      timestampMs: analysis.timestamp.getTime(),
      portfolioValueUsdc: Math.round((portfolioData?.totalValue ?? 0) * 100),
      volatilityBps: Math.round(volatility * 10_000),
      exposures: exposures.map((e) => ({
        asset: e.asset,
        // exposure + contribution are already in "percentage points" (0..100),
        // so ×100 gets us 2-decimal-place basis-point precision.
        exposureBps: Math.round(e.exposure * 100),
        contributionBps: Math.round(e.contribution * 100),
      })),
      sentimentCode: SENTIMENT_CODE[sentiment],
      baseRiskScore: Math.round(baseRiskScore),
      aiRiskScore: aiRiskScoreForBinding,
      totalRisk: Math.round(totalRisk),
      threshold: RISK_THRESHOLD_DEFAULT,
    };

    const { proofHash, binding } = await this.generateRiskProof(analysis, canonicalInputs);
    analysis.zkProofHash = proofHash;
    if (binding) analysis.zkBinding = binding;

    return analysis;
  }

  /**
   * Get comprehensive AI market context for risk assessment
   * Uses AIMarketIntelligence service for multi-source, multi-timeframe analysis
   */
  async getEnhancedRiskContext(assets: string[] = ['BTC', 'ETH', 'CRO', 'SUI']): Promise<{
    context: AIMarketContext;
    riskAssessment: {
      overallRisk: 'HIGH' | 'MODERATE' | 'LOW';
      riskScore: number;
      marketCondition: 'BEARISH' | 'BULLISH' | 'NEUTRAL' | 'VOLATILE';
      confidenceLevel: number;
      alerts: Array<{
        severity: 'CRITICAL' | 'WARNING' | 'INFO';
        message: string;
        source: string;
      }>;
      recommendations: string[];
    };
  }> {
    const context = await AIMarketIntelligence.getMarketContext(assets);
    
    // Analyze context for risk assessment
    const alerts: Array<{ severity: 'CRITICAL' | 'WARNING' | 'INFO'; message: string; source: string }> = [];
    const recommendations: string[] = [];
    let riskScore = 50; // Base risk score
    
    // 1. Check risk cascade (highest priority)
    if (context.riskCascade.detected) {
      const severity = context.riskCascade.severity >= 75 ? 'CRITICAL' : 'WARNING';
      alerts.push({
        severity,
        message: `Risk cascade detected: ${context.riskCascade.recommendation}`,
        source: 'Risk Cascade Detection',
      });
      riskScore += context.riskCascade.severity * 0.3;
      recommendations.push(context.riskCascade.recommendation === 'HEDGE_IMMEDIATELY' 
        ? 'Open protective hedge position immediately'
        : 'Prepare hedge parameters and monitor closely');
    }
    
    // 2. Check 5-min signal
    if (context.fiveMinSignal) {
      const signal = context.fiveMinSignal;
      if (signal.signalStrength === 'STRONG') {
        alerts.push({
          severity: 'WARNING',
          message: `Strong ${signal.direction} signal detected (${signal.probability}% probability)`,
          source: 'Polymarket 5-Min Signal',
        });
        riskScore += signal.direction === 'DOWN' ? 15 : -5;
      }
    }
    
    // 3. Check streak analysis
    if (context.streaks.streak5Min.count >= 4) {
      const dir = context.streaks.streak5Min.direction;
      alerts.push({
        severity: 'INFO',
        message: `${context.streaks.streak5Min.count}-signal ${dir} streak in progress`,
        source: 'Signal Streak Analysis',
      });
      if (dir === 'DOWN') riskScore += context.streaks.streak5Min.count * 3;
      
      // Check for potential reversal
      if (context.streaks.reversalProbability > 50) {
        alerts.push({
          severity: 'INFO',
          message: `${context.streaks.reversalProbability}% probability of reversal`,
          source: 'Pattern Analysis',
        });
      }
    }
    
    // 4. Check multi-timeframe alignment
    if (context.streaks.streak30Min.direction === context.streaks.streak5Min.direction &&
        context.streaks.trend4Hour.direction === context.streaks.streak5Min.direction) {
      const dir = context.streaks.streak5Min.direction;
      alerts.push({
        severity: dir === 'DOWN' ? 'WARNING' : 'INFO',
        message: `Multi-timeframe ${dir} alignment (5m, 30m, 4h agree)`,
        source: 'Multi-Timeframe Analysis',
      });
      if (dir === 'DOWN') {
        riskScore += 20;
        recommendations.push('Strong bearish alignment - consider reducing exposure');
      }
    }
    
    // 5. Check market sentiment
    if (context.marketSentiment.label === 'EXTREME_FEAR') {
      alerts.push({
        severity: 'WARNING',
        message: `Extreme fear sentiment (score: ${context.marketSentiment.score})`,
        source: 'Market Sentiment',
      });
      riskScore += 15;
      recommendations.push('Market in extreme fear - defensive positioning advised');
    } else if (context.marketSentiment.label === 'EXTREME_GREED') {
      alerts.push({
        severity: 'INFO',
        message: `Extreme greed sentiment - potential reversal risk`,
        source: 'Market Sentiment',
      });
      riskScore += 5;
    }
    
    // 6. Check correlation
    if (context.correlation.divergingAssets.length >= 2) {
      alerts.push({
        severity: 'INFO',
        message: `${context.correlation.divergingAssets.join(', ')} diverging from BTC`,
        source: 'Cross-Market Correlation',
      });
    }
    
    // 7. Check liquidity
    if (!context.liquidity.sufficientLiquidity) {
      alerts.push({
        severity: 'WARNING',
        message: 'Low prediction market liquidity - signals may be unreliable',
        source: 'Liquidity Analysis',
      });
      riskScore += 5;
    }
    
    // 8. Check HEDGE predictions
    const hedgePredictions = context.predictions.filter(p => p.recommendation === 'HEDGE');
    if (hedgePredictions.length > 0) {
      alerts.push({
        severity: hedgePredictions.length >= 2 ? 'WARNING' : 'INFO',
        message: `${hedgePredictions.length} prediction market(s) recommend HEDGE`,
        source: 'Prediction Markets',
      });
      riskScore += hedgePredictions.length * 5;
      hedgePredictions.slice(0, 2).forEach(p => {
        recommendations.push(`Monitor: ${p.question}`);
      });
    }
    
    // Bound risk score
    riskScore = Math.max(10, Math.min(95, riskScore));
    
    // Determine overall risk level
    const overallRisk: 'HIGH' | 'MODERATE' | 'LOW' = 
      riskScore >= 70 ? 'HIGH' : riskScore >= 40 ? 'MODERATE' : 'LOW';
    
    // Determine market condition
    let marketCondition: 'BEARISH' | 'BULLISH' | 'NEUTRAL' | 'VOLATILE';
    if (context.marketSentiment.score <= -30) marketCondition = 'BEARISH';
    else if (context.marketSentiment.score >= 30) marketCondition = 'BULLISH';
    else if (context.streaks.streak5Min.direction === 'MIXED') marketCondition = 'VOLATILE';
    else marketCondition = 'NEUTRAL';
    
    // Add default recommendations if none generated
    if (recommendations.length === 0) {
      if (overallRisk === 'HIGH') {
        recommendations.push('Consider opening protective hedge positions');
        recommendations.push('Reduce exposure to volatile assets');
      } else if (overallRisk === 'MODERATE') {
        recommendations.push('Monitor positions closely');
        recommendations.push('Prepare contingency hedge parameters');
      } else {
        recommendations.push('Risk levels acceptable - maintain positions');
      }
    }
    
    logger.info('Enhanced risk context generated', {
      overallRisk,
      riskScore,
      marketCondition,
      alertCount: alerts.length,
      recommendationCount: recommendations.length,
    });
    
    return {
      context,
      riskAssessment: {
        overallRisk,
        riskScore,
        marketCondition,
        confidenceLevel: Math.max(context.signalHistory.avgConfidence, 50),
        alerts,
        recommendations,
      },
    };
  }

  /**
   * Calculate portfolio volatility
   */
  private async calculateVolatility(payload: { portfolioId: number }): Promise<number> {
    return await this.calculateVolatilityInternal(payload.portfolioId);
  }

  /**
   * Internal volatility calculation using real market data
   * Uses 24h high/low from Exchange API to calculate annualized volatility
   */
  private async calculateVolatilityInternal(portfolioId: number): Promise<number> {
    try {
      // Import RealMarketDataService for extended price data with high/low
      const { getMarketDataService } = await import('../../lib/services/market-data/RealMarketDataService');
      const realMarketDataService = getMarketDataService();
      
      // Get portfolio exposures to determine which assets to analyze
      const exposures = await this.calculateExposures(portfolioId);
      
      // Get symbols for batch fetch
      const symbols = exposures.map(e => e.asset).filter(s => !['CASH', 'UNKNOWN'].includes(s));
      
      if (symbols.length === 0) {
        logger.info('No tradeable assets in portfolio for volatility calculation');
        return 0.05; // Low volatility for cash-only portfolio
      }
      
      // Fetch extended prices with 24h high/low data
      const extendedPrices = await realMarketDataService.getExtendedPrices(symbols);
      
      // Calculate weighted volatility based on portfolio composition
      let weightedVolatility = 0;
      let totalWeight = 0;
      
      for (const exposure of exposures) {
        const symbol = exposure.asset;
        if (['CASH', 'UNKNOWN'].includes(symbol)) continue;
        
        const priceData = extendedPrices.get(symbol.toUpperCase());
        let assetVolatility: number;
        
        if (priceData && priceData.high24h && priceData.low24h && priceData.price > 0) {
          // Calculate volatility from 24h range: (high - low) / price * sqrt(365)
          const dailyRange = (priceData.high24h - priceData.low24h) / priceData.price;
          assetVolatility = dailyRange * Math.sqrt(365); // Annualized
          logger.debug(`[RiskAgent] ${symbol} volatility from 24h range`, {
            high: priceData.high24h,
            low: priceData.low24h,
            price: priceData.price,
            volatility: assetVolatility,
          });
        } else {
          // Fallback to asset-type-based estimate
          const isStablecoin = ['USDC', 'USDT', 'DAI', 'DEVUSDC'].includes(symbol.toUpperCase());
          assetVolatility = isStablecoin ? 0.01 : 0.35;
          logger.warn(`[RiskAgent] ${symbol} using fallback volatility: ${assetVolatility}`);
        }
        
        weightedVolatility += assetVolatility * (exposure.exposure / 100);
        totalWeight += exposure.exposure / 100;
      }
      
      const portfolioVolatility = totalWeight > 0 ? weightedVolatility / totalWeight : 0.25;
      logger.info('[RiskAgent] Calculated real portfolio volatility', { 
        portfolioId, 
        volatility: portfolioVolatility,
        assetsAnalyzed: symbols.length,
      });
      return portfolioVolatility;
    } catch (error) {
      logger.error('[RiskAgent] Failed to calculate real volatility, using market estimate', { error });
      // Fallback to reasonable crypto market estimate
      return 0.30; // 30% annualized - typical crypto volatility
    }
  }

  /**
   * Analyze asset exposures
   */
  private async analyzeExposures(payload: { portfolioId: number }): Promise<RiskAnalysis['exposures']> {
    return await this.calculateExposures(payload.portfolioId);
  }

  /**
   * Calculate asset exposures from real portfolio data.
   * Routes to the correct chain's data source based on the `chain` parameter.
   */
  private async calculateExposures(portfolioId: number, chain: string = 'cronos'): Promise<RiskAnalysis['exposures']> {
    try {
      let portfolio: { positions?: Array<{ symbol?: string; value: number }>; totalValue?: number } = {};

      if (chain === 'sui') {
        // ── SUI: fetch from SUI community pool service ──
        try {
          const { getSuiCommunityPoolService } = await import('../../lib/services/sui/SuiCommunityPoolService');
          const suiPool = getSuiCommunityPoolService();
          const stats = await suiPool.getPoolStats();
          const totalValue = stats.totalNAVUsd || 0;
          // SUI pool tracks 4 assets — derive positions from target allocations
          // The pool's NAV is SUI-denominated; totalNAVUsd gives USD value
          if (totalValue > 0) {
            // Default target: 30% BTC, 30% ETH, 25% SUI, 15% CRO
            portfolio = {
              totalValue,
              positions: [
                { symbol: 'BTC', value: totalValue * 0.30 },
                { symbol: 'ETH', value: totalValue * 0.30 },
                { symbol: 'SUI', value: totalValue * 0.25 },
                { symbol: 'CRO', value: totalValue * 0.15 },
              ],
            };
          }
          logger.info('Using SUI on-chain pool data for exposures', { chain, totalValue });
        } catch (e) {
          logger.warn('SUI portfolio data unavailable, falling back to Cronos', { error: e });
        }
      } else if (chain === 'oasis-sapphire' || chain === 'oasis') {
        // ── Oasis Sapphire: fetch from Oasis community pool service ──
        try {
          const { getOasisPoolStats } = await import('../../lib/services/oasis/OasisCommunityPoolService');
          const stats = await getOasisPoolStats();
          const totalValue = parseFloat(stats.totalNAV) || 0;
          // Oasis pool returns allocation percentages per asset
          const alloc = stats.allocations;
          if (totalValue > 0) {
            portfolio = {
              totalValue,
              positions: [
                { symbol: 'BTC', value: totalValue * (alloc.BTC / 100) },
                { symbol: 'ETH', value: totalValue * (alloc.ETH / 100) },
                { symbol: 'SUI', value: totalValue * (alloc.SUI / 100) },
                { symbol: 'CRO', value: totalValue * (alloc.CRO / 100) },
              ].filter(p => p.value > 0),
            };
          }
          logger.info('Using Oasis Sapphire on-chain pool data for exposures', { chain, totalValue, allocations: alloc });
        } catch (e) {
          logger.warn('Oasis portfolio data unavailable, falling back to Cronos', { error: e });
        }
      }
      
      // ── Default / Cronos: use standard portfolio service ──
      if (!portfolio.positions || portfolio.positions.length === 0) {
        const { getPortfolioData } = await import('../../lib/services/portfolio-actions');
        const portfolioData = await getPortfolioData();
        portfolio = (portfolioData?.portfolio ?? {}) as { positions?: Array<{ symbol?: string; value: number }>; totalValue?: number };
      }
      
      if (!portfolio.positions || portfolio.positions.length === 0) {
        logger.info('No portfolio positions - will prompt user to add positions');
        // Return a meaningful default that indicates no positions
        // This helps the RiskAgent give actionable advice
        return [{
          asset: 'CASH',
          exposure: 100,
          contribution: 0, // Cash has no risk contribution
        }];
      }
      
      const positions = portfolio.positions;
      const totalValue = portfolio.totalValue || 0;
      
      if (totalValue === 0) {
        logger.warn('Portfolio has zero value');
        return [];
      }
      
      // Calculate real exposures based on position values
      const exposures: RiskAnalysis['exposures'] = [];
      
      for (const position of positions) {
        const exposure = (position.value / totalValue) * 100;
        
        // Calculate risk contribution based on asset volatility
        // Stablecoins contribute less to risk, crypto contributes more
        let riskMultiplier = 1.0;
        const symbol = position.symbol?.toUpperCase() || '';
        if (['USDC', 'USDT', 'DAI', 'DEVUSDC'].includes(symbol)) {
          riskMultiplier = 0.05; // Stablecoins have very low risk contribution
        } else if (['BTC', 'WBTC'].includes(symbol)) {
          riskMultiplier = 1.2; // BTC slightly higher due to market dominance
        } else if (['ETH', 'WETH'].includes(symbol)) {
          riskMultiplier = 1.0;
        } else {
          riskMultiplier = 1.5; // Altcoins have higher risk contribution
        }
        
        exposures.push({
          asset: position.symbol || 'UNKNOWN',
          exposure: Math.round(exposure * 100) / 100,
          contribution: Math.round(exposure * riskMultiplier * 100) / 100,
        });
      }
      
      // Sort by exposure descending
      exposures.sort((a, b) => b.exposure - a.exposure);
      
      logger.info('Calculated real portfolio exposures', { 
        portfolioId, 
        totalValue, 
        assetCount: exposures.length 
      });
      
      return exposures;
    } catch (error) {
      logger.error('Failed to calculate real exposures', { error });
      // Return empty array instead of mock data
      return [];
    }
  }

  /**
   * Assess market sentiment
   */
  private async assessMarketSentiment(_payload: unknown): Promise<string> {
    return await this.assessMarketSentimentInternal();
  }

  /**
   * Internal sentiment assessment using Delphi prediction markets + 5-min BTC signals
   */
  private async assessMarketSentimentInternal(): Promise<'bullish' | 'bearish' | 'neutral'> {
    try {
      // Import and use DelphiMarketService for real prediction data
      const { DelphiMarketService } = await import('../../lib/services/market-data/DelphiMarketService');
      
      // Get predictions for major assets
      const btcInsights = await DelphiMarketService.getAssetInsights('BTC');
      const ethInsights = await DelphiMarketService.getAssetInsights('ETH');
      
      // Aggregate sentiment from predictions
      let bullishCount = 0;
      let bearishCount = 0;
      
      const allPredictions = [
        ...btcInsights.predictions,
        ...ethInsights.predictions,
      ];
      
      for (const prediction of allPredictions) {
        // Count based on recommendation + probability — not impact level
        // HEDGE recommendation = agent sees downside risk = bearish signal
        // High probability with no HEDGE = market expects positive outcome = bullish
        if (prediction.probability >= 55) {
          if (prediction.recommendation === 'HEDGE') {
            bearishCount++;
          } else {
            bullishCount++;
          }
        } else if (prediction.probability <= 45) {
          // Low probability of the predicted event = contrarian signal
          if (prediction.recommendation === 'HEDGE') {
            // Low probability hedge = minor risk, still slightly bearish
            bearishCount++;
          } else {
            // Low probability of a positive event = bearish
            bearishCount++;
          }
        }
        // Probability 45-55: genuinely uncertain, skip (doesn't skew sentiment)
      }
      
      // 🔥 Proactive 5-min signal — always fresh via ticker subscription (no fetch delay)
      const fiveMinSignal = this.cachedFiveMinSignal;
      if (fiveMinSignal && fiveMinSignal.signalStrength !== 'WEAK') {
        // Check freshness: only use signals less than 20 s old
        const signalAge = Date.now() - fiveMinSignal.fetchedAt;
        if (signalAge < 20_000) {
          const weight = fiveMinSignal.signalStrength === 'STRONG' ? 3 : 2;
          if (fiveMinSignal.direction === 'DOWN') {
            bearishCount += weight;
          } else {
            bullishCount += weight;
          }
          logger.info('5-min BTC signal factored into sentiment (via ticker)', {
            direction: fiveMinSignal.direction,
            probability: fiveMinSignal.probability,
            weight,
            signalStrength: fiveMinSignal.signalStrength,
            ageMs: signalAge,
          });
        } else {
          logger.debug('5-min signal too stale, skipped', { ageMs: signalAge });
        }
      }
      
      // Determine overall sentiment
      if (bullishCount > bearishCount + 1) {
        logger.info('Market sentiment assessed from Delphi data', { 
          sentiment: 'bullish', 
          bullishCount, 
          bearishCount,
          predictionsAnalyzed: allPredictions.length 
        });
        return 'bullish';
      } else if (bearishCount > bullishCount + 1) {
        logger.info('Market sentiment assessed from Delphi data', { 
          sentiment: 'bearish', 
          bullishCount, 
          bearishCount,
          predictionsAnalyzed: allPredictions.length 
        });
        return 'bearish';
      }
      
      logger.info('Market sentiment assessed from Delphi data', { 
        sentiment: 'neutral', 
        bullishCount, 
        bearishCount,
        predictionsAnalyzed: allPredictions.length 
      });
      return 'neutral';
    } catch (error) {
      logger.warn('Failed to fetch Delphi predictions, using neutral fallback', { error });
      return 'neutral';
    }
  }

  /**
   * Generate risk recommendations
   */
  private generateRecommendations(
    totalRisk: number,
    volatility: number,
    sentiment: string,
    exposures?: RiskAnalysis['exposures']
  ): string[] {
    const recommendations: string[] = [];

    // Check if portfolio is just cash (no crypto positions)
    const isCashOnly = exposures && exposures.length === 1 && exposures[0].asset === 'CASH';
    
    if (isCashOnly) {
      recommendations.push('📊 Your portfolio is 100% in cash - consider diversifying');
      recommendations.push('💡 Try: "Buy 100 CRO" or "Buy 50 ETH" to start investing');
      recommendations.push('🎯 A balanced portfolio might include: 40% CRO, 30% ETH, 20% BTC, 10% stablecoins');
      return recommendations;
    }

    if (totalRisk > 70) {
      recommendations.push('⚠️ High risk detected: Consider reducing overall exposure');
      recommendations.push('🛡️ Implement hedging strategies using derivatives');
    } else if (totalRisk > 50) {
      recommendations.push('📈 Moderate risk: Monitor positions closely');
      recommendations.push('Consider partial hedging for protection');
    } else {
      recommendations.push('✅ Risk levels acceptable within target range');
    }

    if (volatility > 0.3) {
      recommendations.push('📉 High volatility detected: Consider volatility-targeting strategies');
    }

    if (sentiment === 'bearish') {
      recommendations.push('🐻 Bearish sentiment: Consider defensive positioning');
    } else if (sentiment === 'bullish') {
      recommendations.push('🐂 Bullish sentiment: Evaluate growth opportunities');
    }

    return recommendations;
  }

  /**
   * Independently evaluate a proposed execution and return a vote.
   * Called by LeadAgent during multi-agent consensus — the RiskAgent
   * performs its own real-time risk analysis rather than relying on
   * the LeadAgent's assessment.
   */
  async voteOnExecution(proposal: {
    executionId: string;
    action: string;
    estimatedPositionSize: number;
    portfolioId?: string;
    riskAnalysis?: { totalRisk: number; volatility: number };
    predictionContext?: string;
  }): Promise<{ approved: boolean; reason: string }> {
    try {
      // Use pre-existing risk analysis if the LeadAgent already ran one this cycle
      let totalRisk = proposal.riskAnalysis?.totalRisk ?? -1;
      let volatility = proposal.riskAnalysis?.volatility ?? -1;

      // If no analysis was supplied, run a quick assessment ourselves
      if (totalRisk < 0 || volatility < 0) {
        const freshVolatility = await this.calculateVolatilityInternal(0);
        const sentiment = await this.assessMarketSentimentInternal();
        volatility = freshVolatility;

        // Simple composite risk: vol * 50 baseline, shift by sentiment
        const sentimentShift = sentiment === 'bearish' ? 15 : sentiment === 'bullish' ? -10 : 0;
        totalRisk = Math.min(100, Math.max(0, freshVolatility * 50 + sentimentShift));
      }

      // Factor in 5-min Polymarket signal if available
      const signal = this.cachedFiveMinSignal;
      if (signal && (Date.now() - signal.fetchedAt) < 20_000) {
        if (signal.direction === 'DOWN' && signal.signalStrength === 'STRONG') {
          totalRisk = Math.min(100, totalRisk + 10);
        } else if (signal.direction === 'UP' && signal.signalStrength === 'STRONG') {
          totalRisk = Math.max(0, totalRisk - 5);
        }
      }

      // Decision thresholds:
      //  - Risk ≥ 75 → reject
      //  - Position > $10M → reject (automated trades only)
      //  - Analysis-only (action=analyze) → always approve
      const isAnalysisOnly = proposal.action === 'analyze' || proposal.action === 'analysis';
      const positionOk = proposal.estimatedPositionSize <= 10_000_000;
      const riskOk = totalRisk < 75;

      const approved = isAnalysisOnly || (riskOk && positionOk);

      const reason = approved
        ? `Risk acceptable (score: ${totalRisk.toFixed(1)}, vol: ${(volatility * 100).toFixed(1)}%, size: $${proposal.estimatedPositionSize.toLocaleString()})`
        : `Risk too high (score: ${totalRisk.toFixed(1)}, vol: ${(volatility * 100).toFixed(1)}%, size: $${proposal.estimatedPositionSize.toLocaleString()})`;

      logger.info('🗳️ RiskAgent independent vote', {
        executionId: proposal.executionId,
        approved,
        totalRisk,
        volatility,
        reason,
        agentId: this.id,
      });

      return { approved, reason };
    } catch (error) {
      logger.error('RiskAgent vote failed — defaulting to cautious reject', { error, agentId: this.id });
      return { approved: false, reason: `Vote evaluation error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Generate a bound ZK-STARK proof for the risk calculation. The
   * canonical inputs pin every numeric fed into the risk formula — the
   * Python prover recomputes the input hash and derived base score and
   * refuses to generate a proof if anything mismatches.
   *
   * Returns both `proofHash` (short fingerprint for downstream
   * attribution) and `binding` (hashes to attach to `RiskAnalysis`).
   * `binding` is `undefined` only when the Python prover is offline or
   * threw — in that case we return an empty proofHash rather than
   * fabricating one.
   */
  private async generateRiskProof(
    analysis: RiskAnalysis,
    canonical: CanonicalRiskInputs,
  ): Promise<{ proofHash: string; binding?: RiskAnalysis['zkBinding'] }> {
    logger.info('Generating ZK-STARK proof for risk calculation', {
      agentId: this.id,
      portfolioId: analysis.portfolioId,
      canonicalVersion: canonical.version,
    });

    try {
      const { proofGenerator } = await import('@shared/../zk/prover/ProofGenerator');
      const zkProof = await proofGenerator.generateRiskProof(analysis, canonical);

      logger.info('ZK-STARK proof generated successfully', {
        agentId: this.id,
        portfolioId: analysis.portfolioId,
        proofHash: zkProof.proofHash.substring(0, 16) + '...',
        inputsHash: zkProof.binding?.inputsHash.substring(0, 16) + '...',
        protocol: zkProof.protocol,
        generationTime: zkProof.generationTime,
      });

      return { proofHash: zkProof.proofHash, binding: zkProof.binding };
    } catch (error) {
      logger.error('ZK-STARK proof generation failed', {
        error,
        agentId: this.id,
        portfolioId: analysis.portfolioId,
      });

      // Do not fabricate a proof. Caller sees empty proofHash + no
      // binding, and downstream verifiers know to reject.
      return { proofHash: '' };
    }
  }
}
