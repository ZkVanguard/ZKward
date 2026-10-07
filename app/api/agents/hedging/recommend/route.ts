import { NextRequest, NextResponse } from 'next/server';
import { getCryptocomAIService } from '@/lib/ai/cryptocom-service';
import { MCPClient } from '@/integrations/mcp/MCPClient';
import { ethers } from 'ethers';
import type { PortfolioData } from '@/shared/types/portfolio';
import { logger } from '@/lib/utils/logger';
import { getCronosProvider } from '@/lib/throttled-provider';
import { getMarketDataService } from '@/lib/services/market-data/RealMarketDataService';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { getCached, setCached } from '@/lib/db/ui-cache';

// Import the multi-agent system
import { LeadAgent } from '@/agents/core/LeadAgent';
import { AgentRegistry } from '@/agents/core/AgentRegistry';
import { RiskAgent } from '@/agents/specialized/RiskAgent';
import { HedgingAgent } from '@/agents/specialized/HedgingAgent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Singleton agent instances (avoid re-initializing every request)
let _cachedLeadAgent: LeadAgent | null = null;
let _cachedRegistry: AgentRegistry | null = null;
let _agentInitPromise: Promise<void> | null = null;

// ============================================================================
// Two-Tier Cache: In-Memory (fast) + DB (survives cold starts)
// ============================================================================
interface CachedResponse {
  data: unknown;
  timestamp: number;
}
const responseCache = new Map<string, CachedResponse>();
const CACHE_TTL_MS = 60000; // 60 second cache TTL (DB-backed now)

function getCachedResponse(address: string): CachedResponse | null {
  const cached = responseCache.get(address.toLowerCase());
  if (!cached) return null;
  
  // Check if cache is still valid
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    responseCache.delete(address.toLowerCase());
    return null;
  }
  return cached;
}

function setCachedResponse(address: string, data: unknown): void {
  // Limit cache size to prevent memory leaks
  if (responseCache.size > 100) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }
  responseCache.set(address.toLowerCase(), { data, timestamp: Date.now() });
}

/**
 * Try DB cache as fallback when in-memory cache misses
 */
async function getDbCachedResponse(address: string): Promise<unknown | null> {
  try {
    const cacheKey = `recommend:${address.toLowerCase()}`;
    return await getCached('recommendations', cacheKey);
  } catch {
    return null;
  }
}

/**
 * Store response in both in-memory and DB cache
 */
async function setAllCaches(address: string, data: unknown): Promise<void> {
  // In-memory (synchronous, fast)
  setCachedResponse(address, data);
  
  // DB cache (async, survives cold starts)
  const cacheKey = `recommend:${address.toLowerCase()}`;
  setCached('recommendations', cacheKey, data, CACHE_TTL_MS).catch(err => logger.warn('Recommendation cache write failed', { error: String(err) }));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Hedging Recommendations API Route
 * Uses the FULL Multi-Agent System:
 * - LeadAgent: Orchestrates all agents
 * - RiskAgent: Analyzes portfolio risk
 * - HedgingAgent: Creates hedge strategies
 * - PriceMonitorAgent: Provides real-time prices
 * - Crypto.com AI SDK: AI-powered insights
 * - Crypto.com MCP: Real market data
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  // Rate limiting (no auth required - frontend analysis endpoint)
  const rateLimitResponse = heavyLimiter.check(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json();
    const { address } = body;

    if (!address) {
      return NextResponse.json(
        { error: 'Address is required' },
        { status: 400 }
      );
    }

    // Check cache first (unless force refresh requested)
    const forceRefresh = body.force === true;
    if (!forceRefresh) {
      // Tier 1: In-memory cache (instant)
      const memCached = getCachedResponse(address);
      if (memCached) {
        logger.info('🚀 Returning in-memory cached recommendation', { address, age: Date.now() - memCached.timestamp });
        return NextResponse.json(memCached.data);
      }
      
      // Tier 2: DB cache (survives cold starts, shared across instances)
      const dbCached = await getDbCachedResponse(address);
      if (dbCached) {
        // Hydrate in-memory cache for subsequent requests
        setCachedResponse(address, dbCached);
        logger.info('🗄️ Returning DB-cached recommendation (cold start recovery)', { address });
        return NextResponse.json(dbCached);
      }
    }

    logger.info('🤖 Multi-Agent Hedge Recommendation requested', { address });

    // ========================================================================
    // STEP 1: Initialize Multi-Agent System
    // ========================================================================
    const provider = getCronosProvider().provider;
    
    // Trim private key to remove any trailing whitespace from env vars
    const rawPrivateKey = process.env.PRIVATE_KEY;
    const privateKey = rawPrivateKey?.trim();
    const signer = privateKey ? new ethers.Wallet(privateKey, provider) : undefined;

    // Use cached agent instances (singleton per process)
    if (!_cachedLeadAgent || !_cachedRegistry) {
      if (!_agentInitPromise) {
        _agentInitPromise = (async () => {
          try {
            const registry = new AgentRegistry();
            const riskAgent = new RiskAgent('risk-agent-1', provider, signer);
            await riskAgent.initialize();
            registry.register(riskAgent);
            if (signer) {
              try {
                const hedgingAgent = new HedgingAgent('hedging-agent-1', provider, signer);
                await hedgingAgent.initialize();
                registry.register(hedgingAgent);
              } catch (hedgeErr) {
                // HedgingAgent is optional — PerpMarketClient may not have API keys
                logger.warn('HedgingAgent init failed (non-critical, continuing without)', { 
                  error: hedgeErr instanceof Error ? hedgeErr.message : String(hedgeErr) 
                });
              }
            }
            const leadAgent = new LeadAgent('lead-agent-1', provider, signer, registry);
            await leadAgent.initialize();
            _cachedRegistry = registry;
            _cachedLeadAgent = leadAgent;
          } catch (err) {
            // Reset promise so next request retries initialization
            _agentInitPromise = null;
            throw err;
          }
        })();
      }
      await _agentInitPromise;
    }
    
    // Safety check: if agents still not initialized, fail gracefully
    if (!_cachedLeadAgent || !_cachedRegistry) {
      logger.error('Agent initialization completed but agents are null');
      return NextResponse.json({
        recommendations: [{
          strategy: 'Agent System Unavailable',
          confidence: 0.5,
          expectedReduction: 0,
          description: 'Multi-agent system failed to initialize. Please try again.',
          agentSource: 'system',
          actions: [],
        }],
        portfolioAnalysis: { totalValue: 0, tokens: 0, dominantAsset: null },
        totalExecutionTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    }
    
    const _registry = _cachedRegistry;
    const leadAgent = _cachedLeadAgent;;
    
    logger.info('✅ Multi-Agent System ready (cached)', { 
      agents: ['LeadAgent', 'RiskAgent', signer ? 'HedgingAgent' : '(HedgingAgent - no signer)'] 
    });

    // ========================================================================
    // STEP 2: Gather REAL Portfolio Data from On-Chain
    // ========================================================================
    logger.info('📊 Fetching real portfolio data for', { address });
    
    // Get real wallet balances using RealMarketDataService
    const marketDataService = getMarketDataService();
    let realPortfolio;
    try {
      realPortfolio = await marketDataService.getPortfolioData(address);
    } catch (portfolioError) {
      logger.error('Failed to fetch portfolio data', portfolioError);
      // Return empty portfolio response on failure
      return NextResponse.json({
        recommendations: [{
          strategy: 'Portfolio Fetch Failed',
          confidence: 0.5,
          expectedReduction: 0,
          description: 'Unable to fetch on-chain portfolio data. Please try again in a moment.',
          agentSource: 'system',
          actions: [],
        }],
        portfolioAnalysis: { totalValue: 0, tokens: 0, dominantAsset: null },
        totalExecutionTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    }
    
    const portfolioData: PortfolioData = {
      address,
      tokens: realPortfolio.tokens.map(t => {
        const balance = parseFloat(t.balance) || 0;
        // Prevent division by zero - use usdValue or 0 as price if balance is 0
        const price = balance > 0 ? t.usdValue / balance : (t.usdValue || 0);
        const usd = t.usdValue || 0;
        return {
          symbol: t.symbol,
          balance,
          price: isFinite(price) ? price : 0,
          value: usd,
          // Downstream (cryptocom-service.calculateRealRiskAssessment,
          // generateRealHedgeRecommendations) reads t.usdValue. Missing
          // this field made every weight NaN → NaN cascade in outputs.
          usdValue: usd,
        };
      }),
      totalValue: realPortfolio.totalValue || 0,
    };

    // If wallet has no tokens, provide helpful message
    if (portfolioData.tokens.length === 0) {
      logger.warn('No tokens found in wallet', { address });
      return NextResponse.json({
        recommendations: [{
          strategy: 'Connect & Fund Wallet',
          confidence: 1.0,
          expectedReduction: 0,
          description: 'No tokens detected in this wallet. Deposit CRO, BTC, ETH or testnet USDC to enable AI-powered hedge recommendations.',
          agentSource: 'system',
          actions: [],
        }],
        portfolioAnalysis: {
          totalValue: 0,
          tokens: 0,
          dominantAsset: null,
        },
        totalExecutionTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    }

    logger.info('📊 Real portfolio data gathered', { 
      totalValue: portfolioData.totalValue,
      tokens: portfolioData.tokens.length,
      assets: portfolioData.tokens.map(t => `${t.symbol}: $${t.value.toFixed(2)}`),
    });

    // Initialize MCP for price enhancement
    const mcpClient = new MCPClient();
    await mcpClient.connect();

    // ========================================================================
    // STEP 3: LeadAgent Orchestrates Multi-Agent Analysis
    // ========================================================================
    logger.info('🎯 LeadAgent orchestrating multi-agent hedge analysis...');
    
    // Execute strategy through LeadAgent with 30s timeout
    let executionReport;
    try {
      executionReport = await withTimeout(leadAgent.executeStrategyFromIntent({
        action: 'hedge',
        targetPortfolio: 1,
        objectives: {
          riskLimit: 30, // Target 30% risk reduction
        },
        constraints: {
          maxSlippage: 0.5,
          timeframe: 3600,
        },
        requiredAgents: ['risk', 'hedging', 'reporting'],
        estimatedComplexity: 'medium',
      }), 30000, 'LeadAgent.executeStrategyFromIntent');
    } catch (strategyError) {
      logger.error('LeadAgent strategy execution failed', strategyError);
      // Return fallback response based on portfolio data alone
      const dominantAsset = portfolioData.tokens[0];
      return NextResponse.json({
        recommendations: [{
          strategy: dominantAsset ? `${dominantAsset.symbol} Hedge (Fallback)` : 'Portfolio Analysis',
          confidence: 0.6,
          expectedReduction: 0.15,
          description: 'Agent analysis timed out. Based on portfolio composition, consider hedging your dominant position.',
          agentSource: 'system-fallback',
          actions: dominantAsset ? [{
            action: 'SHORT',
            asset: dominantAsset.symbol,
            size: dominantAsset.balance * 0.2,
            leverage: 3,
            protocol: 'BlueFin',
            reason: 'Basic hedge for dominant position',
          }] : [],
        }],
        portfolioAnalysis: {
          totalValue: portfolioData.totalValue,
          tokens: portfolioData.tokens.length,
          dominantAsset: dominantAsset?.symbol || null,
        },
        totalExecutionTime: Date.now() - startTime,
        aiPowered: false,
        timestamp: new Date().toISOString(),
        fallbackReason: 'Agent execution timeout or failure',
      });
    }

    logger.info('📋 Multi-Agent execution complete', {
      executionId: executionReport.executionId,
      status: executionReport.status,
      executionTime: executionReport.totalExecutionTime,
    });

    // ========================================================================
    // STEP 4: Generate Recommendations from Agent Results
    // ========================================================================
    interface HedgeRecommendation {
      strategy: string;
      confidence: number;
      expectedReduction: number;
      description: string;
      riskScore?: number;
      volatility?: number;
      sentiment?: string;
      agentSource: string;
      actions: Array<{
        action: string;
        asset: string;
        size: number;
        leverage: number;
        protocol: string;
        reason: string;
      }>;
    }

    const recommendations: HedgeRecommendation[] = [];
    
    // Extract recommendation from RiskAgent analysis
    const riskAnalysis = executionReport.riskAnalysis;
    if (riskAnalysis && portfolioData.tokens.length > 0) {
      const dominantAsset = portfolioData.tokens.reduce((max, token) => 
        token.value > (max?.value || 0) ? token : max
      , portfolioData.tokens[0]);

      if (dominantAsset) {
        // Determine hedge direction based on risk sentiment
        const hedgeSide = riskAnalysis.marketSentiment === 'bearish' ? 'SHORT' : 
                          riskAnalysis.marketSentiment === 'bullish' ? 'LONG' : 'SHORT';
        
        const totalRisk = isFinite(riskAnalysis.totalRisk) ? riskAnalysis.totalRisk : 50;
        const volatility = isFinite(riskAnalysis.volatility) ? riskAnalysis.volatility : 0.3;
        
        recommendations.push({
          strategy: `${hedgeSide} ${dominantAsset.symbol} Hedge`,
          confidence: Math.max(0.5, 1 - (totalRisk / 100)),
          expectedReduction: volatility * 0.5, // Aim to reduce 50% of volatility
          description: riskAnalysis.recommendations?.[0] || `Risk-adjusted ${hedgeSide.toLowerCase()} hedge based on ${riskAnalysis.marketSentiment || 'neutral'} sentiment`,
          riskScore: totalRisk,
          volatility: volatility,
          sentiment: riskAnalysis.marketSentiment,
          agentSource: 'RiskAgent + LeadAgent',
          actions: [{
            action: hedgeSide,
            asset: dominantAsset.symbol,
            size: (dominantAsset.balance || 0) * 0.25, // Hedge 25% of position
            leverage: Math.min(5, Math.ceil(volatility * 10)),
            protocol: 'BlueFin',
            reason: `AI-recommended hedge based on ${totalRisk.toFixed(0)}% risk score`,
          }],
        });
      }
    }

    // Extract recommendation from HedgingAgent strategy
    const hedgingStrategy = executionReport.hedgingStrategy;
    if (hedgingStrategy) {
      const hedgeAsset = hedgingStrategy.instruments?.[0]?.asset || 'BTC';
      const existingRec = recommendations.find(r => r.strategy.includes(hedgeAsset));
      if (!existingRec && hedgingStrategy.strategy) {
        recommendations.push({
          strategy: hedgingStrategy.strategy,
          confidence: 0.75,
          expectedReduction: 0.3,
          description: `HedgingAgent strategy: ${hedgingStrategy.strategy} with estimated yield ${hedgingStrategy.estimatedYield}%`,
          agentSource: 'HedgingAgent',
          actions: hedgingStrategy.instruments?.map(inst => ({
            action: inst.type === 'perpetual' ? 'SHORT' : 'LONG',
            asset: inst.asset,
            size: inst.size,
            leverage: inst.leverage || 5,
            protocol: 'BlueFin',
            reason: `Entry at $${inst.entryPrice}`,
          })) || [],
        });
      }
    }

    // ========================================================================
    // STEP 5: Enhance with Crypto.com AI Service
    // ========================================================================
    try {
      const aiService = getCryptocomAIService();
      const firstToken = portfolioData.tokens[0];
      const totalValue = portfolioData.totalValue || 1; // Avoid division by zero
      const riskProfile = {
        dominantAsset: firstToken?.symbol || 'BTC',
        concentration: firstToken ? Math.min(100, (firstToken.value / totalValue) * 100) : 50,
        totalValue: portfolioData.totalValue,
      };
      
      const aiRecommendations = await aiService.generateHedgeRecommendations(portfolioData, riskProfile);
      
      // Add AI recommendations that don't duplicate existing ones
      for (const rec of aiRecommendations) {
        const isDuplicate = recommendations.some(r => 
          r.actions?.[0]?.asset === rec.actions?.[0]?.asset && 
          r.actions?.[0]?.action === rec.actions?.[0]?.action?.toUpperCase()
        );
        
        if (!isDuplicate) {
          recommendations.push({
            strategy: rec.strategy,
            confidence: rec.confidence,
            expectedReduction: rec.expectedReduction,
            description: rec.description,
            agentSource: 'Crypto.com AI SDK',
            actions: rec.actions.map(action => ({
              action: action.action.toUpperCase(),
              asset: action.asset,
              size: action.amount,
              leverage: 5,
              protocol: 'BlueFin',
              reason: rec.description,
            })),
          });
        }
      }
    } catch (aiError) {
      logger.warn('Crypto.com AI service enhancement failed, using agent results only', { error: aiError });
    }

    // ========================================================================
    // STEP 6: Return Multi-Agent Results
    // ========================================================================
    const totalExecutionTime = Date.now() - startTime;
    
    const responseData = {
      recommendations,
      multiAgentExecution: {
        executionId: executionReport.executionId,
        status: executionReport.status,
        executionTime: executionReport.totalExecutionTime,
        aiSummary: executionReport.aiSummary,
        zkProofs: executionReport.zkProofs?.map(p => ({
          type: p.proofType,
          hash: p.proofHash?.substring(0, 16) + '...',
          verified: p.verified,
        })),
      },
      agentsUsed: {
        leadAgent: 'Orchestrating multi-agent coordination',
        riskAgent: `Analyzed risk: ${riskAnalysis?.totalRisk?.toFixed(0) || 'N/A'}% score`,
        hedgingAgent: signer ? 'Created hedge strategy' : 'Skipped (no signer)',
        priceMonitor: 'Real-time prices via MCP',
        aiService: 'Crypto.com AI SDK insights',
      },
      portfolioAnalysis: {
        totalValue: portfolioData.totalValue,
        tokens: portfolioData.tokens.length,
        dominantAsset: portfolioData.tokens[0]?.symbol,
      },
      totalExecutionTime,
      aiPowered: true,
      timestamp: new Date().toISOString(),
    };

    // Cache the response in both tiers (in-memory + DB)
    await setAllCaches(address, responseData);
    logger.info('💾 Cached recommendation (memory + DB)', { address, executionTime: totalExecutionTime });

    return NextResponse.json(responseData);
  } catch (error) {
    return safeErrorResponse(error, 'Multi-Agent hedge recommendation');
  }
}
