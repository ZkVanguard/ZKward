/**
 * Crypto.com AI Agent Service Wrapper
 * 
 * Provides AI-powered portfolio analysis, risk assessment, and natural language
 * intent parsing using Crypto.com's AI Agent SDK.
 */

import { logger } from '../utils/logger';
import { getCronosRpcUrl } from '@/lib/throttled-provider';

// Note: @crypto.com/ai-agent-client types will be available at runtime
// Using interface for now until proper types are available
interface AIAgentClient {
  analyze?(params: Record<string, unknown>): Promise<{ intent?: string; confidence?: number; entities?: Record<string, unknown>; parameters?: Record<string, unknown> }>;
  analyzePortfolio?(address: string, portfolio: Record<string, unknown>): Promise<PortfolioAnalysis>;
  assessRisk?(portfolio: Record<string, unknown>): Promise<RiskAssessment>;
  generateHedgeRecommendations?(portfolio: Record<string, unknown>, riskProfile: Record<string, unknown>): Promise<HedgeRecommendation[]>;
}

// Types for AI analysis
export interface PortfolioAnalysis {
  totalValue: number;
  positions: number;
  riskScore: number;
  healthScore: number;
  recommendations: string[];
  topAssets: Array<{
    symbol: string;
    value: number;
    percentage: number;
  }>;
}

export interface RiskAssessment {
  overallRisk: 'low' | 'medium' | 'high';
  riskScore: number;
  volatility: number;
  var95: number;
  sharpeRatio: number;
  factors: Array<{
    factor: string;
    impact: 'low' | 'medium' | 'high';
    description: string;
  }>;
}

// Internal-only: the Crypto.com SDK response shape, not part of the
// module's public surface.
interface HedgeRecommendation {
  strategy: string;
  confidence: number;
  expectedReduction: number;
  description: string;
  actions: Array<{
    action: string;
    asset: string;
    amount: number;
  }>;
}

export interface IntentParsing {
  intent: 'analyze_portfolio' | 'assess_risk' | 'generate_hedge' | 'execute_settlement' | 'generate_report' | 'unknown';
  confidence: number;
  entities: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

interface PortfolioInput {
  tokens?: Array<{ symbol: string; usdValue?: number; value?: number }>;
  totalValue?: number;
  positions?: Array<{ symbol?: string; value?: number }>;
  address?: string;
  lastUpdated?: string;
}

class CryptocomAIService {
  private client: AIAgentClient | null = null;
  private apiKey: string | null = null;

  constructor() {
    // Initialize with API key from environment
    // Check both NEXT_PUBLIC_ (client-side) and regular (server-side) versions
    this.apiKey = process.env.NEXT_PUBLIC_CRYPTOCOM_DEVELOPER_API_KEY || 
                   process.env.CRYPTOCOM_DEVELOPER_API_KEY || 
                   process.env.CRYPTOCOM_AI_API_KEY || 
                   null;
    
    if (this.apiKey) {
      try {
        // Dynamic import for Crypto.com AI Agent SDK
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        import('@crypto.com/ai-agent-client').then((module: any) => {
          const { createClient } = module;
          if (createClient) {
            this.client = createClient({
              openaiApiKey: this.apiKey,
              blockchainRpcUrl: getCronosRpcUrl(),
            }) as AIAgentClient;
            logger.info('Crypto.com AI Agent SDK initialized successfully');
          } else {
            logger.warn('createClient not found in @crypto.com/ai-agent-client');
            this.client = null;
          }
        }).catch((_error) => {
          // Silent catch - fallback logic will be used
          this.client = null;
        });
      } catch (_error) {
        this.client = null;
      }
    }
  }

  /**
   * Check if AI service is available
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Parse user intent from natural language input
   */
  async parseIntent(input: string): Promise<IntentParsing> {
    if (!this.client) {
      return this.fallbackIntentParsing(input);
    }

    try {
      // Use Crypto.com AI for intent classification
      if (!this.client?.analyze) {
        return this.fallbackIntentParsing(input);
      }
      const response = await this.client.analyze({
        text: input,
        task: 'intent_classification',
        context: {
          domain: 'defi_portfolio_management',
          available_intents: [
            'analyze_portfolio',
            'assess_risk',
            'generate_hedge',
            'execute_settlement',
            'generate_report',
          ],
        },
      });

      return {
        intent: (response.intent || 'unknown') as IntentParsing['intent'],
        confidence: response.confidence || 0,
        entities: response.entities || {},
        parameters: response.parameters || {},
      };
    } catch (error) {
      logger.error('AI intent parsing failed', error);
      return this.fallbackIntentParsing(input);
    }
  }

  private calculateRealPortfolioAnalysis(portfolio?: PortfolioInput): PortfolioAnalysis {
    // Calculate analysis from REAL portfolio data
    if (portfolio && portfolio.tokens && (portfolio.totalValue ?? 0) > 0) {
      const tokens = portfolio.tokens as Array<{ symbol: string; usdValue: number }>;
      const totalValue = portfolio.totalValue as number;
      
      // Sort by value and get top assets
      const sortedTokens = [...tokens].sort((a, b) => b.usdValue - a.usdValue);
      const topAssets = sortedTokens.slice(0, 5).map(t => ({
        symbol: t.symbol,
        value: t.usdValue,
        percentage: (t.usdValue / totalValue) * 100,
      }));
      
      // Calculate real risk score based on concentration
      const weights = tokens.map(t => t.usdValue / totalValue);
      const herfindahl = weights.reduce((sum, w) => sum + w * w, 0);
      const riskScore = Math.min(100, Math.round(herfindahl * 100 + 20));
      
      // Health score based on diversification
      const healthScore = Math.max(0, Math.min(100, 100 - riskScore + 30));
      
      // Generate recommendations based on real data
      const recommendations: string[] = [];
      if (herfindahl > 0.5) {
        recommendations.push('Consider diversifying - portfolio is concentrated in few assets.');
      }
      if (tokens.length < 3) {
        recommendations.push('Adding more assets could reduce overall portfolio risk.');
      }
      if (tokens.some(t => t.symbol === 'USDC' || t.symbol === 'USDT')) {
        if (tokens.filter(t => ['USDC', 'USDT', 'DAI'].includes(t.symbol)).reduce((sum, t) => sum + t.usdValue, 0) / totalValue < 0.1) {
          recommendations.push('Consider holding more stablecoins for reduced volatility.');
        }
      }
      if (recommendations.length === 0) {
        recommendations.push('Portfolio appears well-balanced for current market conditions.');
      }
      
      return {
        totalValue,
        positions: tokens.length,
        riskScore,
        healthScore,
        recommendations,
        topAssets,
      };
    }
    
    // No portfolio data - return empty state
    return {
      totalValue: 0,
      positions: 0,
      riskScore: 0,
      healthScore: 0,
      recommendations: ['Connect wallet to see portfolio analysis.'],
      topAssets: [],
    };
  }

  private calculateRealRiskAssessment(portfolio?: PortfolioInput): RiskAssessment {
    // Calculate REAL risk metrics from portfolio data
    if (portfolio && portfolio.tokens && (portfolio.totalValue ?? 0) > 0) {
      const tokens = portfolio.tokens as Array<{ symbol: string; usdValue: number }>;
      const totalValue = portfolio.totalValue as number;
      
      // Calculate concentration risk (Herfindahl index)
      const weights = tokens.map(t => t.usdValue / totalValue);
      const herfindahl = weights.reduce((sum, w) => sum + w * w, 0);
      
      // Volatility estimates by asset class (annualized)
      const volatilityMap: Record<string, number> = {
        BTC: 0.60, ETH: 0.65, CRO: 0.75, SOL: 0.80, 
        USDC: 0.01, USDT: 0.01, DAI: 0.01, DEVUSDC: 0.01,
        DEFAULT: 0.50
      };
      
      // Calculate portfolio weighted volatility
      const portfolioVolatility = tokens.reduce((vol, token) => {
        const weight = token.usdValue / totalValue;
        const assetVol = volatilityMap[token.symbol.toUpperCase()] || volatilityMap.DEFAULT;
        return vol + weight * assetVol;
      }, 0);
      
      // Diversification benefit (correlation assumed 0.5 between assets)
      const diversificationFactor = Math.sqrt(herfindahl + (1 - herfindahl) * 0.5);
      const adjustedVolatility = portfolioVolatility * diversificationFactor;
      
      // Value at Risk (95% confidence) - parametric VaR
      const var95 = adjustedVolatility * 1.645 * Math.sqrt(1/252); // Daily VaR
      
      // Risk score (0-100) based on volatility and concentration
      const riskScore = Math.min(100, Math.round(
        (adjustedVolatility * 100) + (herfindahl * 30)
      ));
      
      // Sharpe Ratio estimate (assuming 5% risk-free rate, 10% expected return for crypto)
      const expectedReturn = 0.10;
      const riskFreeRate = 0.05;
      const sharpeRatio = adjustedVolatility > 0 
        ? (expectedReturn - riskFreeRate) / adjustedVolatility 
        : 0;
      
      return {
        overallRisk: riskScore > 60 ? 'high' : riskScore > 40 ? 'medium' : 'low',
        riskScore,
        volatility: adjustedVolatility,
        var95,
        sharpeRatio: Math.max(0, Math.min(3, sharpeRatio)), // Clamp to reasonable range
        factors: [
          {
            factor: 'Concentration Risk',
            impact: herfindahl > 0.5 ? 'high' : herfindahl > 0.25 ? 'medium' : 'low',
            description: `Portfolio concentration index: ${(herfindahl * 100).toFixed(1)}%`,
          },
          {
            factor: 'Market Volatility',
            impact: adjustedVolatility > 0.5 ? 'high' : adjustedVolatility > 0.3 ? 'medium' : 'low',
            description: `Estimated annualized volatility: ${(adjustedVolatility * 100).toFixed(1)}%`,
          },
        ],
      };
    }
    
    // No portfolio data - return empty/unknown state
    return {
      overallRisk: 'low',
      riskScore: 0,
      volatility: 0,
      var95: 0,
      sharpeRatio: 0,
      factors: [
        {
          factor: 'No Portfolio Data',
          impact: 'low',
          description: 'Connect wallet to see real risk metrics',
        },
      ],
    };
  }

  private generateRealHedgeRecommendations(portfolio?: PortfolioInput): HedgeRecommendation[] {
    // No portfolio data - return default recommendations
    if (!portfolio || !portfolio.tokens || (portfolio.totalValue ?? 0) <= 0) {
      return [{
        strategy: 'diversification',
        confidence: 0.7,
        expectedReduction: 0.15,
        description: 'Diversify portfolio to reduce concentration risk',
        actions: [{
          action: 'buy',
          asset: 'USDC',
          amount: 1000,
        }],
      }];
    }
    
    const tokens = portfolio.tokens as Array<{ symbol: string; usdValue: number }>;
    const totalValue = portfolio.totalValue as number;
    const recommendations: HedgeRecommendation[] = [];
    
    // Analyze each position and generate real recommendations
    for (const token of tokens) {
      const weight = token.usdValue / totalValue;
      
      // If position is >30% of portfolio, recommend hedging
      if (weight > 0.3) {
        recommendations.push({
          strategy: `Reduce ${token.symbol} Concentration`,
          confidence: Math.min(0.95, 0.5 + weight),
          expectedReduction: weight * 0.3,
          description: `${token.symbol} represents ${(weight * 100).toFixed(1)}% of portfolio. Consider diversifying to reduce concentration risk.`,
          actions: [
            {
              action: 'SWAP',
              asset: token.symbol,
              amount: token.usdValue * 0.2, // Suggest reducing by 20%
            },
          ],
        });
      }
    }
    
    // If portfolio is well-balanced, no recommendations needed
    return recommendations;
  }

  /**
   * Analyze portfolio using AI
   */
  async analyzePortfolio(
    address: string,
    portfolio: PortfolioInput
  ): Promise<PortfolioAnalysis> {
    if (!this.client || typeof this.client.analyzePortfolio !== 'function') {
      return this.calculateRealPortfolioAnalysis(portfolio);
    }
    try {
      const analysis = await this.client.analyzePortfolio(address, portfolio as unknown as Record<string, unknown>);
      return analysis;
    } catch (error) {
      logger.error('AI portfolio analysis failed', { error });
      return this.calculateRealPortfolioAnalysis(portfolio);
    }
  }

  /**
   * Assess risk using AI or calculate from real portfolio data
   */
  async assessRisk(
    portfolio: PortfolioInput
  ): Promise<RiskAssessment> {
    // First calculate base metrics from portfolio data
    const baseAssessment = this.calculateRealRiskAssessment(portfolio);
    
    // Try Crypto.com AI SDK first
    if (this.client && typeof this.client.assessRisk === 'function') {
      try {
        const risk = await this.client.assessRisk(portfolio as unknown as Record<string, unknown>);
        return risk;
      } catch (error) {
        logger.warn('Crypto.com AI SDK risk assessment failed, trying Ollama', { error });
      }
    }
    
    // Try Ollama for AI-enhanced analysis
    try {
      const { llmProvider } = await import('./llm-provider');
      await llmProvider.waitForInit();
      
      if (llmProvider.getActiveProvider()?.includes('ollama')) {
        const tokens = portfolio.tokens || [];
        const portfolioSummary = tokens
          .map((t) => `${t.symbol}: $${(t.usdValue || t.value || 0).toFixed(0)}`)
          .join(', ');
        
        const aiPrompt = `Analyze this DeFi portfolio risk. Portfolio: ${portfolioSummary}. Total: $${portfolio.totalValue?.toFixed(0) || 0}. Base volatility: ${(baseAssessment.volatility * 100).toFixed(1)}%, VaR: ${(baseAssessment.var95 * 100).toFixed(1)}%.

Respond with ONLY this format:
RISK_LEVEL: [low/medium/high]
RISK_FACTOR1: [factor name] - [brief description]
RISK_FACTOR2: [factor name] - [brief description]`;

        const aiResponse = await llmProvider.generateDirectResponse(aiPrompt, 'You are a DeFi risk analyst. Be concise.');
        
        // Parse AI response to enhance factors
        const lines = aiResponse.content.split('\n');
        const additionalFactors: Array<{ factor: string; impact: 'low' | 'medium' | 'high'; description: string }> = [];
        
        for (const line of lines) {
          const factorMatch = line.match(/RISK_FACTOR\d*:?\s*(.+?)\s*[-–]\s*(.+)/i);
          if (factorMatch) {
            additionalFactors.push({
              factor: `🤖 ${factorMatch[1].trim()}`,
              impact: 'medium',
              description: factorMatch[2].trim(),
            });
          }
        }
        
        // Merge AI insights with base assessment
        return {
          ...baseAssessment,
          factors: [...baseAssessment.factors, ...additionalFactors.slice(0, 2)],
        };
      }
    } catch (ollamaError) {
      logger.warn('Ollama AI risk enhancement failed', { error: ollamaError });
    }
    
    // Return base rule-based assessment
    return baseAssessment;
  }

  /**
   * Generate hedge recommendations using AI
   */
  async generateHedgeRecommendations(
    portfolio: PortfolioInput,
    riskProfile: Record<string, unknown>
  ): Promise<HedgeRecommendation[]> {
    // Get base recommendations from rule-based logic
    const baseRecommendations = this.generateRealHedgeRecommendations(portfolio);
    
    // Try Crypto.com AI SDK first
    if (this.client && typeof this.client.generateHedgeRecommendations === 'function') {
      try {
        const recommendations = await this.client.generateHedgeRecommendations(
          portfolio as unknown as Record<string, unknown>,
          riskProfile
        );
        return recommendations;
      } catch (error) {
        logger.warn('Crypto.com AI SDK hedge recommendation failed, trying Ollama', { error });
      }
    }
    
    // Try Ollama for AI-enhanced recommendations
    try {
      const { llmProvider } = await import('./llm-provider');
      await llmProvider.waitForInit();
      
      if (llmProvider.getActiveProvider()?.includes('ollama')) {
        const tokens = portfolio.tokens || [];
        const portfolioSummary = tokens
          .map((t) => `${t.symbol}: $${(t.usdValue || t.value || 0).toFixed(0)} (${((t.usdValue || t.value || 0) / (portfolio.totalValue || 1) * 100).toFixed(0)}%)`)
          .join(', ');
        
        const aiPrompt = `Recommend hedging strategy for this DeFi portfolio: ${portfolioSummary}. Total: $${portfolio.totalValue?.toFixed(0) || 0}. Risk level: ${String(riskProfile?.overallRisk || 'medium')}.

Respond with ONLY this format:
STRATEGY: [strategy type: protective-put, perpetual-short, or diversify]
ASSET: [which asset to hedge]
REASON: [one sentence why]
EFFECTIVENESS: [0-100]`;

        const aiResponse = await llmProvider.generateDirectResponse(aiPrompt, 'You are a DeFi hedging strategist. Be concise.');
        
        // Parse AI response
        const lines = aiResponse.content.split('\n');
        let strategy = 'diversify', asset = 'BTC', reason = 'AI recommended', effectiveness = 70;
        
        for (const line of lines) {
          const stratMatch = line.match(/STRATEGY:?\s*(.+)/i);
          const assetMatch = line.match(/ASSET:?\s*(.+)/i);
          const reasonMatch = line.match(/REASON:?\s*(.+)/i);
          const effMatch = line.match(/EFFECTIVENESS:?\s*(\d+)/i);
          
          if (stratMatch) strategy = stratMatch[1].trim();
          if (assetMatch) asset = assetMatch[1].trim();
          if (reasonMatch) reason = reasonMatch[1].trim();
          if (effMatch) effectiveness = parseInt(effMatch[1], 10);
        }
        
        // Add AI recommendation to base recommendations
        const aiRecommendation: HedgeRecommendation = {
          strategy: `🤖 ${strategy}`,
          confidence: effectiveness / 100,
          expectedReduction: 0.25,
          description: `AI: ${reason}`,
          actions: [{
            action: strategy.includes('short') ? 'SHORT' : strategy.includes('put') ? 'BUY_PUT' : 'DIVERSIFY',
            asset,
            amount: (portfolio.totalValue || 0) * 0.1,
          }],
        };
        
        return [aiRecommendation, ...baseRecommendations];
      }
    } catch (ollamaError) {
      logger.warn('Ollama AI hedge recommendation failed', { error: ollamaError });
    }
    
    return baseRecommendations;
  }

  // ==================== Fallback Logic (Rule-Based) ====================

  private fallbackIntentParsing(input: string): IntentParsing {
    const lowerInput = input.toLowerCase();

    if (lowerInput.includes('portfolio') || lowerInput.includes('overview') || lowerInput.includes('balance')) {
      return {
        intent: 'analyze_portfolio',
        confidence: 0.85,
        entities: {},
        parameters: {},
      };
    }

    if (lowerInput.includes('risk') || lowerInput.includes('volatility') || lowerInput.includes('var')) {
      return {
        intent: 'assess_risk',
        confidence: 0.85,
        entities: {},
        parameters: {},
      };
    }

    if (lowerInput.includes('hedge') || lowerInput.includes('protect') || lowerInput.includes('mitigate')) {
      return {
        intent: 'generate_hedge',
        confidence: 0.85,
        entities: {},
        parameters: {},
      };
    }

    if (lowerInput.includes('settle') || lowerInput.includes('execute') || lowerInput.includes('batch')) {
      return {
        intent: 'execute_settlement',
        confidence: 0.85,
        entities: {},
        parameters: {},
      };
    }

    if (lowerInput.includes('report') || lowerInput.includes('summary') || lowerInput.includes('analysis')) {
      return {
        intent: 'generate_report',
        confidence: 0.85,
        entities: {},
        parameters: {},
      };
    }

    return {
      intent: 'unknown',
      confidence: 0,
      entities: {},
      parameters: {},
    };
  }

  private fallbackPortfolioAnalysis(_portfolioData: unknown): PortfolioAnalysis {
    // Return null-equivalent — caller must check for empty data
    return {
      totalValue: 0,
      positions: 0,
      riskScore: 0,
      healthScore: 0,
      recommendations: ['AI service unavailable — portfolio analysis requires live data'],
      topAssets: [],
    };
  }

  private fallbackRiskAssessment(portfolioData: PortfolioInput): RiskAssessment {
    // Deterministic fallback: compute volatility based on exposure to volatile assets
    try {
      const positions = Array.isArray(portfolioData.positions) ? portfolioData.positions : [];
      const totalValue = portfolioData.totalValue || positions.reduce((s: number, p) => s + (p.value || 0), 0) || 1;

      const volatileSymbols = new Set(['BTC', 'ETH', 'SOL', 'ADA', 'BNB', 'CRO', 'LTC', 'DOT']);
      const stableSymbols = new Set(['USDC', 'USDT', 'DAI']);

      let volatileExposure = 0;
      let stableExposure = 0;

      for (const p of positions) {
        const sym = (p.symbol || '').toUpperCase();
        const val = Number(p.value || 0);
        if (volatileSymbols.has(sym)) volatileExposure += val;
        if (stableSymbols.has(sym)) stableExposure += val;
      }

      const volatileRatio = Math.min(1, volatileExposure / totalValue);
      const stableRatio = Math.min(1, stableExposure / totalValue);

      // Base volatility scales with volatile exposure
      const volatility = Math.max(0.02, Math.min(1, 0.03 + volatileRatio * 0.6));
      // Scale VaR with portfolio size so larger portfolios show larger absolute VaR
      const sizeMultiplier = 0.05 * Math.log10(Math.max(10, totalValue));
      const var95 = Math.max(0.005, Math.min(0.5, volatility * (0.1 + sizeMultiplier)));
      const riskScore = Math.round(volatility * 100);
      const overallRisk: 'low' | 'medium' | 'high' = volatility < 0.08 ? 'low' : volatility < 0.25 ? 'medium' : 'high';

      return {
        overallRisk,
        riskScore,
        volatility,
        var95,
        sharpeRatio: Math.max(0.1, 1 / (volatility * 4)),
        factors: [
          {
            factor: 'Market Volatility',
            impact: overallRisk,
            description: 'Computed from portfolio exposure to volatile assets',
          },
          {
            factor: 'Concentration Risk',
            impact: volatileRatio > 0.5 ? 'high' : volatileRatio > 0.25 ? 'medium' : 'low',
            description: 'Higher concentration in a few assets increases risk',
          },
          {
            factor: 'Liquidity Risk',
            impact: stableRatio > 0.5 ? 'low' : 'medium',
            description: 'Stablecoin allocation reduces liquidity-driven volatility',
          },
        ],
      };
    } catch (e) {
      // Fallback deterministic defaults
      return {
        overallRisk: 'medium',
        riskScore: 50,
        volatility: 0.12,
        var95: 0.06,
        sharpeRatio: 1,
        factors: [],
      };
    }
  }

  private fallbackHedgeRecommendations(_portfolioData: unknown, _riskProfile: unknown): HedgeRecommendation[] {
    // No fabricated recommendations — return empty when AI is unavailable
    // The caller should indicate that no AI-driven recommendations are available
    return [];
  }
}

// Singleton instance
let aiServiceInstance: CryptocomAIService | null = null;

export function getCryptocomAIService(): CryptocomAIService {
  if (!aiServiceInstance) {
    aiServiceInstance = new CryptocomAIService();
  }
  return aiServiceInstance;
}

export default CryptocomAIService;
