/**
 * Auto-Hedging Service
 *
 * Background service that:
 * 1. Continuously monitors portfolio risk
 * 2. Updates hedge PnL with live prices
 * 3. Auto-creates hedges when risk thresholds are exceeded
 * 4. Coordinates with multi-agent system for intelligent decisions
 * 5. Integrates Polymarket prediction market signals for enhanced risk detection
 */

import { logger } from '@/lib/utils/logger';
import {
  riskToleranceToThreshold, computeRiskScore,
  computeCommunityPoolRiskScore, computeSuiPoolRiskScore,
} from '@/lib/services/hedging/risk-scoring';
import { getActiveHedges, createHedge } from '@/lib/db/hedges';
import { query } from '@/lib/db/postgres';
import { getAgentOrchestrator } from '../agent-orchestrator';
import { ethers } from 'ethers';
import { RWA_MANAGER_ABI } from '@/lib/contracts/abis';
import { getContractAddresses } from '@/lib/contracts/addresses';
import { getCronosRpcUrl, getCronosChainId } from '@/lib/throttled-provider';
import { getMarketDataService } from '../market-data/RealMarketDataService';
import {
  getUnifiedPriceProvider,
  getHedgeExecutionPrice,
} from '../market-data/unified-price-provider';
import { getAutoHedgeConfigs } from '@/lib/storage/auto-hedge-storage';
import {
  COMMUNITY_POOL_PORTFOLIO_ID,
  COMMUNITY_POOL_ADDRESS,
  SUI_COMMUNITY_POOL_PORTFOLIO_ID,
  isCommunityPoolPortfolio,
} from '@/lib/constants';
import { calculatePoolNAV } from '../cronos/CommunityPoolService';
import { getPoolStats as getUnifiedPoolStats } from '../CommunityPoolStatsService';
import { getCentralizedHedgeManager } from './CentralizedHedgeManager';
import {
  PredictionAggregatorService,
  type AggregatedPrediction,
} from '../market-data/PredictionAggregatorService';
import type { AutoHedgeConfig, RiskAssessment, HedgeRecommendation } from './hedge-types';
import {
  HEDGE_CONFIG as CONFIG,
  calculateDrawdown,
  calculateVolatility,
  calculateConcentrationRisk,
  generateHedgeRecommendations,
} from './hedge-risk-math';
import { SIZING_LIMITS, isPriceFreshEnough, safeLeverage, buildDecisionToken } from './calibration';
import {
  assessCommunityPoolRisk as assessCommunityPoolRiskPure,
  assessSuiCommunityPoolRisk as assessSuiCommunityPoolRiskPure,
} from './community-pool-risk-assessor';
// Re-export shared types for existing consumers
export type { AutoHedgeConfig, RiskAssessment, HedgeRecommendation } from './hedge-types';

class AutoHedgingService {
  private isRunning = false;
  private pnlUpdateInterval: NodeJS.Timeout | null = null;
  private riskCheckInterval: NodeJS.Timeout | null = null;
  private autoHedgeConfigs: Map<number, AutoHedgeConfig> = new Map();
  private lastRiskAssessments: Map<number, RiskAssessment> = new Map();

  // ── Overlap guards: prevent concurrent execution of async interval callbacks ──
  // Without these, if updateAllHedgePnL() takes >10s or checkAllPortfolioRisks() >60s,
  // overlapping executions could cause duplicate hedges, inconsistent state, or DB races.
  private pnlUpdateInProgress = false;
  private riskCheckInProgress = false;

  // ── Decision idempotency: prevent duplicate hedges from clock-skewed cron ticks ──
  // Maps decision-token → expiry timestamp; we refuse to re-execute a token while live.
  private recentDecisionTokens: Map<string, number> = new Map();
  private static readonly DECISION_TOKEN_TTL_MS = 5 * 60 * 1000;

  // ── Memory cap for assessments map ──
  private static readonly MAX_RISK_ASSESSMENTS = 500;

  /**
   * Start the auto-hedging service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info('[AutoHedging] Already running, reloading configs...');
      // Always reload configs so newly-added portfolios (e.g. community pool) are picked up
      await this.loadPortfoliosFromStorage();
      return;
    }

    this.isRunning = true;
    logger.info('[AutoHedging] Starting service (optimized mode)...');

    // Initial PnL update - Wrap in try/catch and log error but don't crash
    try {
      await this.updateAllHedgePnL();
    } catch (e: any) {
      logger.error('[AutoHedging] Initial PnL update failed (quota limit?)', { error: e?.message });
    }

    // Start PnL update loop — with overlap guard
    this.pnlUpdateInterval = setInterval(async () => {
      if (this.pnlUpdateInProgress) {
        logger.debug('[AutoHedging] PnL update skipped — previous still running');
        return;
      }
      this.pnlUpdateInProgress = true;
      try {
        await this.updateAllHedgePnL();
      } catch (error: any) {
        if (error?.message?.includes('usage limit') || error?.message?.includes('quota')) {
          logger.warn('[AutoHedging] Database quota reached, pausing updates temporarily...');
        } else {
          logger.error('[AutoHedging] PnL update error', {
            error: error instanceof Error ? error.message : error,
          });
        }
      } finally {
        this.pnlUpdateInProgress = false;
      }
    }, CONFIG.PNL_UPDATE_INTERVAL_MS);

    // Start risk check loop — with overlap guard
    this.riskCheckInterval = setInterval(async () => {
      if (this.riskCheckInProgress) {
        logger.debug('[AutoHedging] Risk check skipped — previous still running');
        return;
      }
      this.riskCheckInProgress = true;
      try {
        await this.checkAllPortfolioRisks();
      } catch (error) {
        logger.error('[AutoHedging] Risk check error', {
          error: error instanceof Error ? error.message : error,
        });
      } finally {
        this.riskCheckInProgress = false;
      }
    }, CONFIG.RISK_CHECK_INTERVAL_MS);

    logger.info('[AutoHedging] Service started', {
      pnlUpdateInterval: CONFIG.PNL_UPDATE_INTERVAL_MS,
      riskCheckInterval: CONFIG.RISK_CHECK_INTERVAL_MS,
    });

    // Load all enabled portfolios from persistent storage
    await this.loadPortfoliosFromStorage();
  }

  /**
   * Load all enabled portfolio configurations from storage
   * This replaces hardcoded portfolio IDs with dynamic database-driven configuration
   *
   * NOTE: Community Pool is ALWAYS auto-enrolled for protective monitoring
   */
  private async loadPortfoliosFromStorage(): Promise<void> {
    try {
      // ALWAYS enroll Community Pool first (self-sustaining fund requires protection)
      // Uses conservative thresholds: riskThreshold=3 means hedge early
      const communityPoolConfig: AutoHedgeConfig = {
        portfolioId: COMMUNITY_POOL_PORTFOLIO_ID,
        walletAddress: COMMUNITY_POOL_ADDRESS,
        enabled: true,
        riskThreshold: 3, // Aggressive: hedge at moderate risk (protects community funds)
        maxLeverage: 3,
        allowedAssets: ['BTC', 'ETH', 'SUI', 'CRO'],
      };
      this.enableForPortfolio(communityPoolConfig);
      logger.info('[AutoHedging] Community Pool auto-enrolled for protective monitoring', {
        portfolioId: COMMUNITY_POOL_PORTFOLIO_ID,
        address: COMMUNITY_POOL_ADDRESS,
        riskThreshold: communityPoolConfig.riskThreshold,
      });

      // Load additional portfolios from storage
      const storedConfigs = await getAutoHedgeConfigs();

      // Filter out community pool from stored configs (we already enrolled it above)
      const otherConfigs = storedConfigs.filter(
        (c) => c.portfolioId !== COMMUNITY_POOL_PORTFOLIO_ID
      );

      if (otherConfigs.length > 0) {
        logger.info('[AutoHedging] Loading additional configurations from storage', {
          count: otherConfigs.length,
          portfolios: otherConfigs.map((c) => c.portfolioId),
        });

        for (const config of otherConfigs) {
          // Convert storage format to service format
          this.enableForPortfolio({
            portfolioId: config.portfolioId,
            walletAddress: config.walletAddress,
            enabled: config.enabled,
            riskThreshold: config.riskThreshold,
            maxLeverage: config.maxLeverage,
            allowedAssets: config.allowedAssets,
          });
        }
      }

      logger.info('[AutoHedging] All portfolios loaded (including Community Pool)', {
        activeCount: this.autoHedgeConfigs.size,
        portfolioIds: Array.from(this.autoHedgeConfigs.keys()),
      });
    } catch (error) {
      logger.error('[AutoHedging] Failed to load configurations from storage', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Even on error, Community Pool should still be enrolled from the code above
      // Service continues running with at least the community pool
    }
  }

  /**
   * Stop the auto-hedging service
   */
  stop(): void {
    if (!this.isRunning) return;

    if (this.pnlUpdateInterval) {
      clearInterval(this.pnlUpdateInterval);
      this.pnlUpdateInterval = null;
    }

    if (this.riskCheckInterval) {
      clearInterval(this.riskCheckInterval);
      this.riskCheckInterval = null;
    }

    this.isRunning = false;
    this.pnlUpdateInProgress = false;
    this.riskCheckInProgress = false;
    logger.info('[AutoHedging] Service stopped');
  }

  /**
   * Enable auto-hedging for a portfolio
   * Immediately registers with provided config, then asynchronously fetches on-chain settings.
   * Uses a version counter to prevent stale async results from overwriting newer configs.
   */
  private configVersions: Map<number, number> = new Map();

  enableForPortfolio(config: AutoHedgeConfig): void {
    // Increment version for this portfolio — prevents stale async overwrites
    const version = (this.configVersions.get(config.portfolioId) || 0) + 1;
    this.configVersions.set(config.portfolioId, version);

    // Set config IMMEDIATELY so it's available for risk checks right away
    this.autoHedgeConfigs.set(config.portfolioId, config);
    logger.info('[AutoHedging] Portfolio registered immediately', {
      portfolioId: config.portfolioId,
      riskThreshold: config.riskThreshold,
      allowedAssets: config.allowedAssets,
    });

    // Then asynchronously refine settings from on-chain data (non-blocking)
    this.loadPortfolioSettings(config)
      .then((updatedConfig) => {
        // Only apply if this is still the latest version (no newer enableForPortfolio call)
        if (this.configVersions.get(config.portfolioId) === version) {
          this.autoHedgeConfigs.set(updatedConfig.portfolioId, updatedConfig);
          logger.info('[AutoHedging] Portfolio settings refined from on-chain', {
            portfolioId: updatedConfig.portfolioId,
            riskThreshold: updatedConfig.riskThreshold,
          });
        } else {
          logger.debug('[AutoHedging] Skipping stale on-chain config update', {
            portfolioId: config.portfolioId,
            staleVersion: version,
            currentVersion: this.configVersions.get(config.portfolioId),
          });
        }
      })
      .catch((error) => {
        // Config already set above, just log the warning
        logger.warn(
          '[AutoHedging] Failed to load on-chain portfolio settings, using stored defaults',
          {
            portfolioId: config.portfolioId,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      });
  }

  /**
   * Disable auto-hedging for a portfolio
   */
  disableForPortfolio(portfolioId: number): void {
    this.autoHedgeConfigs.delete(portfolioId);
    logger.info('[AutoHedging] Disabled for portfolio', { portfolioId });
  }

  /**
   * Load portfolio settings and map risk tolerance to hedging threshold
   * Risk tolerance (0-100) → Risk threshold (1-10) mapping:
   * - 0-20: Very Conservative → threshold 2 (hedge at slightest risk)
   * - 21-40: Conservative → threshold 4
   * - 41-60: Moderate → threshold 5-6
   * - 61-80: Aggressive → threshold 7-8
   * - 81-100: Very Aggressive → threshold 9-10 (only hedge at high risk)
   */
  private async loadPortfolioSettings(config: AutoHedgeConfig): Promise<AutoHedgeConfig> {
    try {
      // Use risk tolerance from on-chain contract data
      // Risk tolerance will be fetched from RWAManager in fetchPortfolioData
      // For now, use the config's default or set a reasonable default
      const riskTolerance = config.riskThreshold || 50; // Default medium risk

      // Map risk tolerance (0-100) to risk threshold (1-10)
      // Lower tolerance = lower threshold = more aggressive hedging
      // Higher tolerance = higher threshold = less hedging
      const calculatedThreshold = riskToleranceToThreshold(riskTolerance);

      logger.info('[AutoHedging] Using portfolio settings', {
        portfolioId: config.portfolioId,
        riskTolerance,
        calculatedThreshold,
      });

      return {
        ...config,
        riskThreshold: calculatedThreshold,
      };
    } catch (error) {
      logger.error('[AutoHedging] Error loading portfolio settings', { error });
      return config;
    }
  }

  /**
   * Get status of auto-hedging service
   */
  getStatus(): {
    isRunning: boolean;
    enabledPortfolios: number[];
    lastUpdate: number;
    config: typeof CONFIG;
  } {
    return {
      isRunning: this.isRunning,
      enabledPortfolios: Array.from(this.autoHedgeConfigs.keys()),
      lastUpdate: Date.now(),
      config: CONFIG,
    };
  }

  /**
   * Update PnL for all active hedges
   * Uses CentralizedHedgeManager's last snapshot if fresh, else fetches new snapshot
   */
  async updateAllHedgePnL(): Promise<{ updated: number; errors: number }> {
    try {
      const manager = getCentralizedHedgeManager();
      let snapshot = manager.getLastSnapshot();

      // Use existing snapshot if fresh (< 15s), else fetch new one
      if (!snapshot || Date.now() - snapshot.timestamp > 15_000) {
        snapshot = await manager.fetchMarketSnapshot();
      }

      return await manager.batchUpdatePnL(snapshot);
    } catch (error) {
      logger.warn('[AutoHedging] Centralized PnL update failed, falling back', { error });
      return this.updateAllHedgePnLLegacy();
    }
  }

  /**
   * Legacy PnL update — per-asset price fetching
   */
  private async updateAllHedgePnLLegacy(): Promise<{ updated: number; errors: number }> {
    const { isPaperHedge } = await import('@/lib/db/hedges');
    const activeHedges = (await getActiveHedges()).filter((h) => !isPaperHedge(h));

    if (activeHedges.length === 0) {
      return { updated: 0, errors: 0 };
    }

    // Get unique assets
    const uniqueAssets = [...new Set(activeHedges.map((h) => h.asset))];

    // Use unified price provider for real-time prices
    const priceProvider = getUnifiedPriceProvider();
    await priceProvider.initialize();

    // Fetch all prices from unified provider (instant, non-blocking)
    const priceMap = new Map<string, number>();
    for (const asset of uniqueAssets) {
      try {
        const baseAsset = asset.replace('-PERP', '').replace('-USD-PERP', '');
        const priceData = priceProvider.getPrice(baseAsset);
        if (priceData?.price) {
          priceMap.set(asset, priceData.price);
        } else {
          // Fallback to market data service if unified provider doesn't have it
          const marketDataService = getMarketDataService();
          const fallbackPrice = await marketDataService.getTokenPrice(baseAsset);
          if (fallbackPrice.price) priceMap.set(asset, fallbackPrice.price);
        }
      } catch (err) {
        logger.warn(`[AutoHedging] Failed to get price for ${asset}`);
      }
    }

    let updated = 0;
    let errors = 0;

    // Update each hedge
    for (const hedge of activeHedges) {
      try {
        const currentPrice = priceMap.get(hedge.asset);
        if (!currentPrice) continue;

        const entryPrice = Number(hedge.entry_price) || 0;
        const size = Number(hedge.size) || 0;

        // Calculate PnL (guard against division by zero / missing data)
        if (entryPrice === 0 || size === 0) continue;

        // PnL formula: size × (entry − mark) × sideSign.
        // Leverage affects MARGIN requirement, NOT PnL — the asset quantity
        // already fully encodes directional exposure. Multiplying by leverage
        // here (as we used to) inflated PnL by 3× for our 3× hedges and
        // drove the long-standing DB-vs-venue drift (DB \$6.33 vs venue \$2.95
        // on ETH SHORT, observed 2026-06-22).
        const sign = hedge.side === 'SHORT' ? 1 : -1;
        const unrealizedPnL = size * (entryPrice - currentPrice) * sign;

        // Guard against non-finite values (Infinity, NaN)
        if (!isFinite(unrealizedPnL)) continue;

        // Update in database
        await query(
          `UPDATE hedges SET current_pnl = $1, current_price = $2, price_updated_at = NOW() WHERE id = $3`,
          [unrealizedPnL, currentPrice, hedge.id]
        );

        updated++;
      } catch (err) {
        errors++;
        logger.error(`[AutoHedging] Failed to update hedge ${hedge.id}`, { error: err });
      }
    }

    if (updated > 0) {
      logger.debug(`[AutoHedging] Updated ${updated} hedge PnLs, ${errors} errors`);
    }

    return { updated, errors };
  }

  /**
   * Check risk for all enabled portfolios — CENTRALIZED
   * Uses CentralizedHedgeManager to fetch market data ONCE and assess all portfolios
   */
  async checkAllPortfolioRisks(): Promise<void> {
    if (this.autoHedgeConfigs.size === 0) return;

    try {
      const manager = getCentralizedHedgeManager();
      const result = await manager.runCycle(this.autoHedgeConfigs);

      // Store all assessments
      for (const [portfolioId, assessment] of result.assessments) {
        this.lastRiskAssessments.set(portfolioId, assessment);
      }

      logger.info('[AutoHedging] Centralized cycle complete', {
        portfolios: result.portfoliosAssessed,
        hedgesExecuted: result.hedgesExecuted,
        pnlUpdated: result.pnlUpdated,
        durationMs: result.durationMs,
      });
    } catch (error) {
      logger.error('[AutoHedging] Centralized risk check failed, falling back to serial', {
        error,
      });
      // Fallback to serial per-portfolio assessment
      await this.checkAllPortfolioRisksSerial();
    }
  }

  /**
   * Serial fallback: check risk for all portfolios one-by-one
   * Used when CentralizedHedgeManager fails
   */
  private async checkAllPortfolioRisksSerial(): Promise<void> {
    for (const [portfolioId, config] of this.autoHedgeConfigs) {
      if (!config.enabled) continue;

      try {
        const assessment = await this.assessPortfolioRisk(portfolioId, config.walletAddress);
        this.lastRiskAssessments.set(portfolioId, assessment);

        if (assessment.riskScore >= config.riskThreshold) {
          logger.info('[AutoHedging] Risk threshold exceeded', {
            portfolioId,
            riskScore: assessment.riskScore,
            threshold: config.riskThreshold,
          });

          for (const recommendation of assessment.recommendations) {
            if (recommendation.confidence >= 0.7) {
              await this.executeAutoHedge(portfolioId, config, recommendation);
            }
          }
        }
      } catch (error) {
        logger.error('[AutoHedging] Risk assessment failed', { portfolioId, error });
      }
    }
  }

  /**
   * Assess risk for a portfolio using comprehensive data
   * Fetches positions, allocations, risk metrics, and active hedges
   */
  async assessPortfolioRisk(
    portfolioId: number,
    walletAddress: string,
    chain?: string
  ): Promise<RiskAssessment> {
    // Special handling for CommunityPool (portfolioId = COMMUNITY_POOL_PORTFOLIO_ID or SUI_COMMUNITY_POOL_PORTFOLIO_ID)
    if (isCommunityPoolPortfolio(portfolioId)) {
      // SUI pool uses dedicated SUI risk assessment path
      if (chain === 'sui' || portfolioId === SUI_COMMUNITY_POOL_PORTFOLIO_ID) {
        return this.assessSuiCommunityPoolRisk();
      }
      return this.assessCommunityPoolRisk();
    }

    try {
      // Fetch comprehensive portfolio data from database
      const portfolioData = await this.fetchPortfolioData(portfolioId, walletAddress);

      // Get AI agent analysis with full context
      const orchestrator = getAgentOrchestrator();
      const analysisResult = await orchestrator.analyzePortfolio({
        address: walletAddress,
        portfolioData: {
          portfolioId,
          positions: portfolioData.positions,
          allocations: portfolioData.allocations,
          riskMetrics: portfolioData.riskMetrics,
          activeHedges: portfolioData.activeHedges,
        },
      });

      const aiAnalysis = analysisResult.data as {
        totalValue?: number;
        positions?: Array<{ symbol: string; value: number; change24h: number }>;
        riskMetrics?: { volatility?: number; drawdown?: number };
      } | null;

      // Combine database data with AI analysis
      const totalValue = portfolioData.totalValue || aiAnalysis?.totalValue || 0;
      const positions =
        portfolioData.positions.length > 0 ? portfolioData.positions : aiAnalysis?.positions || [];

      // Calculate risk metrics
      const drawdownPercent = calculateDrawdown(positions, totalValue);
      const volatility = calculateVolatility(positions);
      const concentrationRisk = calculateConcentrationRisk(positions, totalValue);

      // Calculate comprehensive risk score (1-10) — see lib/services/hedging/risk-scoring.ts
      const riskScore = computeRiskScore({ drawdownPercent, volatility, concentrationRisk });

      logger.info('[AutoHedging] Portfolio risk assessment', {
        portfolioId,
        totalValue,
        positionsCount: positions.length,
        drawdownPercent: drawdownPercent.toFixed(2),
        volatility: volatility.toFixed(2),
        concentrationRisk: concentrationRisk.toFixed(1),
        riskScore,
        activeHedges: portfolioData.activeHedges.length,
      });

      // Generate hedge recommendations based on comprehensive data
      const recommendations = generateHedgeRecommendations(
        positions,
        totalValue,
        portfolioData.allocations,
        portfolioData.activeHedges,
        drawdownPercent,
        concentrationRisk
      );

      return {
        portfolioId,
        totalValue,
        drawdownPercent,
        volatility,
        riskScore,
        recommendations,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('[AutoHedging] Risk assessment error — treating as elevated risk', {
        portfolioId,
        error,
      });
      // Unknown state = elevated risk, not safe default
      return {
        portfolioId,
        totalValue: 0,
        drawdownPercent: 0,
        volatility: 0,
        riskScore: 4,
        recommendations: [],
        timestamp: Date.now(),
      };
    }
  }


  /**
   * Assess risk for the Cronos community pool. Implementation lives in
   * community-pool-risk-assessor.ts (extracted 2026-08-30).
   */
  private assessCommunityPoolRisk(): Promise<RiskAssessment> {
    return assessCommunityPoolRiskPure();
  }

  /**
   * Assess risk for the SUI USDC community pool. Implementation lives in
   * community-pool-risk-assessor.ts (extracted 2026-08-30).
   */
  private assessSuiCommunityPoolRisk(): Promise<RiskAssessment> {
    return assessSuiCommunityPoolRiskPure();
  }

  /**
   * Fetch comprehensive portfolio data from on-chain sources (blockchain)
   * Uses RWAManager contract for trustless data retrieval
   */
  private async fetchPortfolioData(
    portfolioId: number,
    _walletAddress: string
  ): Promise<{
    totalValue: number;
    positions: Array<{ symbol: string; value: number; change24h: number; balance: number }>;
    allocations: Record<string, number>;
    riskMetrics: { volatility: number; sharpeRatio: number; maxDrawdown: number };
    activeHedges: Array<{ asset: string; side: string; size: number; notionalValue: number }>;
  }> {
    try {
      // Setup on-chain connection
      const provider = new ethers.JsonRpcProvider(getCronosRpcUrl());
      const addresses = getContractAddresses(getCronosChainId());
      const rwaManager = new ethers.Contract(addresses.rwaManager, RWA_MANAGER_ABI, provider);
      const marketDataService = getMarketDataService();

      // Read portfolio data from blockchain
      const portfolioData = await rwaManager.portfolios(portfolioId);
      const isActive = portfolioData[5];

      if (!isActive) {
        logger.warn('[AutoHedging] Portfolio inactive on-chain', { portfolioId });
        return this.emptyPortfolioData(portfolioId);
      }

      // Get portfolio assets from contract
      const assetAddresses = await rwaManager.getPortfolioAssets(portfolioId);

      let totalValue = 0;
      const positions: Array<{
        symbol: string;
        value: number;
        change24h: number;
        balance: number;
      }> = [];

      // Read asset allocations from contract
      for (const assetAddress of assetAddresses) {
        const allocation = await rwaManager.getAssetAllocation(portfolioId, assetAddress);
        const addr = assetAddress.toLowerCase();

        // USDT = institutional portfolio with virtual allocations
        if (addr === '0x28217daddc55e3c4831b4a48a00ce04880786967') {
          const usdtValue = Number(allocation) / 1e6; // 6 decimals

          // Large portfolio? Create virtual BTC/ETH/CRO/SUI allocations
          if (usdtValue > 1000000) {
            totalValue = usdtValue;
            const virtualAllocations = [
              { symbol: 'BTC', percentage: 35 },
              { symbol: 'ETH', percentage: 30 },
              { symbol: 'CRO', percentage: 20 },
              { symbol: 'SUI', percentage: 15 },
            ];

            // Fetch live prices and calculate positions
            for (const alloc of virtualAllocations) {
              try {
                const priceData = await marketDataService.getTokenPrice(alloc.symbol);
                const price = priceData.price;
                const change24h = priceData.change24h || 0;
                const value = usdtValue * (alloc.percentage / 100);
                const balance = value / price;

                positions.push({
                  symbol: alloc.symbol,
                  value,
                  change24h,
                  balance,
                });
              } catch (error) {
                logger.warn(`[AutoHedging] Failed to fetch price for ${alloc.symbol}`, { error });
              }
            }
          }
        }
      }

      // Calculate allocations
      const allocations: Record<string, number> = {};
      positions.forEach((p) => {
        allocations[p.symbol] = (p.value / totalValue) * 100;
      });

      // Calculate on-chain risk metrics from positions
      const volatility = calculateVolatility(positions);
      const maxDrawdown = calculateDrawdown(positions, totalValue);
      const riskMetrics = {
        volatility,
        sharpeRatio: 0, // Not calculable from on-chain data alone
        maxDrawdown,
      };

      // Fetch active hedges (kept in database for internal tracking)
      const hedgesResult = await query(
        `SELECT asset, side, size, notional_value
         FROM hedges
         WHERE portfolio_id = $1 AND status = 'active'`,
        [portfolioId]
      );

      const activeHedges = hedgesResult.map((h) => ({
        asset: String(h.asset || ''),
        side: String(h.side || ''),
        size: parseFloat(String(h.size)) || 0,
        notionalValue: parseFloat(String(h.notional_value)) || 0,
      }));

      logger.info('[AutoHedging] Fetched on-chain portfolio data', {
        portfolioId,
        totalValue: `$${totalValue.toLocaleString()}`,
        positions: positions.length,
        activeHedges: activeHedges.length,
      });

      return {
        totalValue,
        positions,
        allocations,
        riskMetrics,
        activeHedges,
      };
    } catch (error) {
      logger.error('[AutoHedging] Failed to fetch on-chain portfolio data', { error, portfolioId });
      return this.emptyPortfolioData(portfolioId);
    }
  }

  /**
   * Return empty portfolio data structure
   */
  private async emptyPortfolioData(portfolioId: number) {
    // Still fetch hedges from DB
    const hedgesResult = await query(
      `SELECT asset, side, size, notional_value
       FROM hedges
       WHERE portfolio_id = $1 AND status = 'active'`,
      [portfolioId]
    );

    return {
      totalValue: 0,
      positions: [],
      allocations: {},
      riskMetrics: { volatility: 0, sharpeRatio: 0, maxDrawdown: 0 },
      activeHedges: hedgesResult.map((h) => ({
        asset: String(h.asset || ''),
        side: String(h.side || ''),
        size: parseFloat(String(h.size)) || 0,
        notionalValue: parseFloat(String(h.notional_value)) || 0,
      })),
    };
  }

  /**
   * Execute an auto-hedge recommendation
   * Validates real-time prices before execution
   */
  async executeAutoHedge(
    portfolioId: number,
    config: AutoHedgeConfig,
    recommendation: HedgeRecommendation
  ): Promise<boolean> {
    // Validate asset is allowed
    if (config.allowedAssets.length > 0 && !config.allowedAssets.includes(recommendation.asset)) {
      logger.info('[AutoHedging] Asset not in allowed list', { asset: recommendation.asset });
      return false;
    }

    // Validate suggested size — fail closed on bad input
    if (!Number.isFinite(recommendation.suggestedSize) || recommendation.suggestedSize <= 0) {
      logger.warn('[AutoHedging] Invalid suggestedSize, skipping hedge', {
        asset: recommendation.asset,
        size: recommendation.suggestedSize,
      });
      return false;
    }

    // ═══ IDEMPOTENCY GATE — refuse duplicate decisions in same 5-min window ═══
    // Two cron ticks within 5 minutes for the same {portfolio, asset, side, risk-bucket}
    // resolve to the same token; we drop the second.
    const lastRisk = this.lastRiskAssessments.get(portfolioId);
    const decisionToken = buildDecisionToken({
      portfolioId,
      asset: recommendation.asset,
      side: recommendation.side as 'LONG' | 'SHORT',
      riskScore: lastRisk?.riskScore ?? 0,
    });
    const now = Date.now();
    // Sweep expired tokens (cheap; map stays small in practice)
    for (const [k, exp] of this.recentDecisionTokens) {
      if (exp <= now) this.recentDecisionTokens.delete(k);
    }
    if (this.recentDecisionTokens.has(decisionToken)) {
      logger.info('[AutoHedging] Duplicate decision token, skipping hedge', {
        token: decisionToken,
        asset: recommendation.asset,
      });
      return false;
    }
    // Reserve the token *before* execution so concurrent calls see it
    this.recentDecisionTokens.set(decisionToken, now + AutoHedgingService.DECISION_TOKEN_TTL_MS);

    // Hard leverage cap (mirrors on-chain Move guard intent)
    const leverage = safeLeverage(recommendation.leverage, config.maxLeverage);

    // ═══ VALIDATE REAL-TIME PRICE BEFORE EXECUTION ═══
    const priceContext = await getHedgeExecutionPrice(recommendation.asset, recommendation.side);

    if (!priceContext.validation.isValid) {
      logger.warn('[AutoHedging] Invalid price, skipping hedge', {
        asset: recommendation.asset,
        warnings: priceContext.validation.warnings,
      });
      return false;
    }

    // ═══ STALENESS GATE — refuse to hedge on stale prices ═══
    // A 60s-stale price during a fast move can mean executing 5–10% off market.
    if (!isPriceFreshEnough(priceContext.validation.staleness)) {
      logger.error('[AutoHedging] Price too stale, aborting hedge', {
        asset: recommendation.asset,
        staleness: `${priceContext.validation.staleness}ms`,
        maxAllowed: `${SIZING_LIMITS.MAX_PRICE_STALENESS_MS}ms`,
      });
      return false;
    }

    // Log price validation details
    logger.info('[AutoHedging] Price validated for hedge execution', {
      asset: recommendation.asset,
      entryPrice: priceContext.entryPrice,
      effectivePrice: priceContext.effectivePrice,
      slippage: `${priceContext.slippageEstimate.toFixed(3)}%`,
      source: priceContext.validation.priceSource,
      staleness: `${priceContext.validation.staleness}ms`,
      leverage,
    });

    // Convert asset to market format (e.g., BTC -> BTC-USD-PERP)
    const market = `${recommendation.asset}-USD-PERP`;

    try {
      // Create hedge via orchestrator with validated price context
      const orchestrator = getAgentOrchestrator();
      const result = await orchestrator.executeHedge({
        market,
        side: recommendation.side,
        leverage,
        notionalValue: recommendation.suggestedSize.toString(),
      });

      if (result.success) {
        // Record in our hedges table for tracking with real price
        const orderId = `auto-hedge-${portfolioId}-${Date.now()}`;
        await createHedge({
          orderId,
          portfolioId,
          asset: recommendation.asset,
          market,
          side: recommendation.side,
          size: recommendation.suggestedSize / 1000,
          notionalValue: recommendation.suggestedSize,
          leverage,
          entryPrice: priceContext.effectivePrice,
          simulationMode: false,
          reason: `[AUTO] ${recommendation.reason}`,
          metadata: {
            confidence: recommendation.confidence,
            orchestratorResult: result.data,
            priceValidation: {
              source: priceContext.validation.priceSource,
              entryPrice: priceContext.entryPrice,
              effectivePrice: priceContext.effectivePrice,
              slippage: priceContext.slippageEstimate,
            },
          },
        });

        logger.info('[AutoHedging] Hedge executed successfully', {
          portfolioId,
          asset: recommendation.asset,
          side: recommendation.side,
          size: recommendation.suggestedSize,
          entryPrice: priceContext.effectivePrice,
        });
        return true;
      } else {
        // Orchestrator failed — do NOT silently simulate, and release the
        // idempotency reservation so the next genuine attempt can proceed.
        this.recentDecisionTokens.delete(decisionToken);
        logger.error('[AutoHedging] Orchestrator execution failed', {
          error: result.error,
          asset: recommendation.asset,
        });
        return false;
      }
    } catch (error) {
      this.recentDecisionTokens.delete(decisionToken);
      logger.error('[AutoHedging] Live execution failed', { error, asset: recommendation.asset });
      return false;
    }
  }

  /**
   * Get last risk assessment for a portfolio
   */
  getLastRiskAssessment(portfolioId: number): RiskAssessment | null {
    return this.lastRiskAssessments.get(portfolioId) || null;
  }

  /**
   * Manual trigger for risk assessment
   * When triggered (e.g., after rebalancing), also executes hedges if needed
   */
  async triggerRiskAssessment(
    portfolioId: number,
    walletAddress: string,
    chain?: string
  ): Promise<RiskAssessment> {
    const assessment = await this.assessPortfolioRisk(portfolioId, walletAddress, chain);
    this.lastRiskAssessments.set(portfolioId, assessment);

    // Get portfolio config
    const config = this.autoHedgeConfigs.get(portfolioId);

    // If auto-hedging is enabled for this portfolio and risk threshold exceeded, execute hedges
    if (config && config.enabled && assessment.riskScore >= config.riskThreshold) {
      logger.info('[AutoHedging] Risk threshold exceeded in triggered assessment', {
        portfolioId,
        riskScore: assessment.riskScore,
        threshold: config.riskThreshold,
        recommendations: assessment.recommendations.length,
      });

      // Execute recommended hedges with high confidence
      for (const recommendation of assessment.recommendations) {
        if (recommendation.confidence >= 0.7) {
          logger.info('[AutoHedging] Executing high-confidence hedge recommendation', {
            asset: recommendation.asset,
            side: recommendation.side,
            confidence: recommendation.confidence,
          });
          await this.executeAutoHedge(portfolioId, config, recommendation);
        }
      }
    } else if (config && config.enabled) {
      logger.info('[AutoHedging] Risk within acceptable range', {
        portfolioId,
        riskScore: assessment.riskScore,
        threshold: config.riskThreshold,
      });
    }

    return assessment;
  }
}

// Singleton instance
export const autoHedgingService = new AutoHedgingService();

// Auto-start the service (fire and forget)
// This ensures hedging is active as soon as the app starts
if (typeof window === 'undefined') {
  // Server-side only
  autoHedgingService.start().catch((error) => {
    logger.error('[AutoHedging] Failed to auto-start service:', error);
  });
}

// Export for API routes
export { AutoHedgingService, CONFIG as AUTO_HEDGE_CONFIG };
