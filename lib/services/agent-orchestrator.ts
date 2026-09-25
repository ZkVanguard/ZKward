/**
 * Agent Orchestrator Service
 * Coordinates all AI agents and provides unified interface for API routes
 */

import { ethers } from 'ethers';
import { RiskAgent } from '@/agents/specialized/RiskAgent';
import { HedgingAgent } from '@/agents/specialized/HedgingAgent';
import { ReportingAgent } from '@/agents/specialized/ReportingAgent';
import { PriceMonitorAgent } from '@/agents/specialized/PriceMonitorAgent';
import { LeadAgent } from '@/agents/core/LeadAgent';
import { logger } from '@/lib/utils/logger';
import { getCronosProvider } from '@/lib/throttled-provider';
import { saveAgentState, loadAgentState } from '@/lib/db/agent-state';
import type { MarketSnapshot } from './hedging/CentralizedHedgeManager';

export interface AgentOrchestrationResult {
  success: boolean;
  data: unknown;
  agentId: string;
  executionTime: number;
  error?: string;
}

/**
 * Singleton orchestrator for all agents
 */
export class AgentOrchestrator {
  private static instance: AgentOrchestrator | null = null;
  private provider: ethers.Provider;
  private signer: ethers.Signer | null = null;
  private initialized: boolean = false;

  // Agent instances
  private riskAgent: RiskAgent | null = null;
  private hedgingAgent: HedgingAgent | null = null;
  private reportingAgent: ReportingAgent | null = null;
  private leadAgent: LeadAgent | null = null;
  private priceMonitorAgent: PriceMonitorAgent | null = null;

  // Shared market snapshot — set by CentralizedHedgeManager each cycle
  private currentSnapshot: MarketSnapshot | null = null;

  private constructor() {
    // Initialize provider — resolves mainnet vs testnet from NEXT_PUBLIC_CHAIN_ID
    this.provider = getCronosProvider().provider;

    // Initialize signer if private key available
    // Check multiple env var names for compatibility
    // Trim to prevent whitespace issues from env copy-paste
    const privateKey = (process.env.AGENT_PRIVATE_KEY 
      || process.env.SERVER_PRIVATE_KEY 
      || process.env.SERVER_WALLET_PRIVATE_KEY
      || process.env.PRIVATE_KEY)?.trim();
    if (privateKey) {
      this.signer = new ethers.Wallet(privateKey, this.provider);
      logger.info('AgentOrchestrator: Signer initialized');
    } else {
      logger.warn('AgentOrchestrator: No private key found, agents will run in read-only mode');
    }
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator();
    }
    return AgentOrchestrator.instance;
  }

  /**
   * Reset singleton instance for testing
   */
  public static async resetInstance(): Promise<void> {
    if (AgentOrchestrator.instance) {
      await AgentOrchestrator.instance.shutdown();
      AgentOrchestrator.instance = null;
    }
  }

  /**
   * Shutdown all agents
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }
    logger.info('Shutting down AgentOrchestrator...');
    // Stop PriceMonitorAgent polling loop
    if (this.priceMonitorAgent) {
      try { this.priceMonitorAgent.stop(); } catch { /* */ }
    }

    const shutdownResults = await Promise.allSettled([
      this.riskAgent?.shutdown(),
      this.hedgingAgent?.shutdown(),
      this.reportingAgent?.shutdown(),
      this.leadAgent?.shutdown(),
    ]);

    shutdownResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const agentNames = ['RiskAgent', 'HedgingAgent', 'ReportingAgent', 'LeadAgent'];
        logger.warn(`${agentNames[index]} shutdown failed:`, { error: result.reason });
      }
    });

    this.initialized = false;
    this.riskAgent = null;
    this.hedgingAgent = null;
    this.reportingAgent = null;
    this.leadAgent = null;
    this.priceMonitorAgent = null;
    this.currentSnapshot = null;
    logger.info('AgentOrchestrator shutdown complete.');
  }

  /**
   * Initialize all agents
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      logger.info('AgentOrchestrator already initialized');
      return;
    }

    try {
      logger.info('Initializing AgentOrchestrator...', {
        hasPrivateKey: !!this.signer,
        providerUrl: await this.provider.getNetwork().then(n => n.name).catch(() => 'unknown'),
      });

      // Use demo signer if no real signer available
      const signerToUse = this.signer || ethers.Wallet.createRandom(this.provider);
      logger.info('Signer configured', { isDemoSigner: !this.signer });

      // Initialize specialized agents
      logger.info('Creating RiskAgent...');
      this.riskAgent = new RiskAgent(
        'risk-agent-001',
        this.provider
      );

      logger.info('Creating HedgingAgent...');
      this.hedgingAgent = new HedgingAgent(
        'hedging-agent-001',
        this.provider,
        signerToUse,
      );

      logger.info('Creating ReportingAgent...');
      this.reportingAgent = new ReportingAgent('reporting-agent-001', this.provider);

      logger.info('Creating LeadAgent...');
      // Create LeadAgent with provider, signer, and registry for agent delegation
      const { AgentRegistry } = await import('@/agents/core/AgentRegistry');
      const agentRegistry = new AgentRegistry();
      
      this.leadAgent = new LeadAgent(
        'lead-agent-001',
        this.provider,
        signerToUse,
        agentRegistry
      );
      
      // Register specialized agents with the registry so LeadAgent can delegate
      if (this.riskAgent) agentRegistry.register(this.riskAgent);
      if (this.hedgingAgent) agentRegistry.register(this.hedgingAgent);
      if (this.reportingAgent) agentRegistry.register(this.reportingAgent);

      // Initialize PriceMonitorAgent (standalone — not a BaseAgent, has its own lifecycle)
      logger.info('Creating PriceMonitorAgent...');
      this.priceMonitorAgent = new PriceMonitorAgent();

      // Initialize all agents with individual error handling
      logger.info('Initializing agents...');
      const initResults = await Promise.allSettled([
        this.riskAgent.initialize().then(() => logger.info('✅ RiskAgent initialized')),
        this.hedgingAgent.initialize().then(() => logger.info('✅ HedgingAgent initialized')),
        this.reportingAgent.initialize().then(() => logger.info('✅ ReportingAgent initialized')),
        this.leadAgent.initialize().then(() => logger.info('✅ LeadAgent initialized')),
        this.priceMonitorAgent.start().then(() => logger.info('✅ PriceMonitorAgent started')),
      ]);

      // Log any initialization failures
      initResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const agentNames = ['RiskAgent', 'HedgingAgent', 'ReportingAgent', 'LeadAgent', 'PriceMonitorAgent'];
          logger.warn(`${agentNames[index]} initialization failed:`, { error: result.reason });
        }
      });

      this.initialized = true;
      logger.info('AgentOrchestrator initialized successfully', {
        riskAgent: !!this.riskAgent,
        hedgingAgent: !!this.hedgingAgent,
        reportingAgent: !!this.reportingAgent,
        leadAgent: !!this.leadAgent,
        priceMonitorAgent: !!this.priceMonitorAgent,
      });

      // Start auto-hedging PnL tracking (but not auto-execute hedges by default)
      try {
        const { autoHedgingService } = await import('./hedging/AutoHedgingService');
        await autoHedgingService.start();
        logger.info('✅ AutoHedgingService started for PnL tracking');
      } catch (err) {
        logger.warn('AutoHedgingService start failed (non-critical)', { error: err });
      }
      
      // Persist agent state to DB for cold start recovery
      const activeAgents = [
        this.riskAgent && 'RiskAgent',
        this.hedgingAgent && 'HedgingAgent',
        this.reportingAgent && 'ReportingAgent',
        this.leadAgent && 'LeadAgent',
        this.priceMonitorAgent && 'PriceMonitorAgent',
      ].filter(Boolean) as string[];
      
      saveAgentState({
        initialized_at: new Date().toISOString(),
        agents_active: activeAgents,
      }).catch(err => logger.debug('[Orchestrator] Non-critical: state save failed', { err }));
      
      // Load last known state from DB (for warm restart context)
      try {
        const lastState = await loadAgentState();
        if (lastState?.last_risk_assessment) {
          logger.info('[Orchestrator] Restored last risk assessment from DB', {
            riskScore: lastState.last_risk_assessment.riskScore,
            timestamp: lastState.last_risk_assessment.timestamp,
          });
        }
      } catch {
        // Non-critical — agents will fetch fresh data
      }
    } catch (error) {
      logger.error('Failed to initialize AgentOrchestrator', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Ensure orchestrator is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      try {
        await this.initialize();
      } catch (error) {
        logger.error('Failed to initialize orchestrator', { error });
        // Continue in degraded mode - agents will use fallbacks
      }
    }
  }

  /**
   * Analyze portfolio using real agents
   */
  public async analyzePortfolio(params: {
    address: string;
    portfolioData?: unknown;
    chain?: string;
  }): Promise<AgentOrchestrationResult> {
    await this.ensureInitialized();
    const startTime = Date.now();

    try {
      if (!this.riskAgent) {
        throw new Error('RiskAgent not initialized - check logs for initialization errors');
      }

      // Execute portfolio analysis via RiskAgent
      const result = await this.riskAgent.executeTask({
        id: `analyze-${Date.now()}`,
        action: 'analyze_portfolio',
        parameters: {
          address: params.address,
          includeAssets: true,
          includeRisk: true,
          chain: params.chain,
        },
        priority: 3,
        createdAt: new Date(),
        chain: params.chain,
      });

      return {
        success: result.success,
        data: result.data,
        agentId: 'risk-agent-001',
        executionTime: Date.now() - startTime,
        error: result.error || undefined,
      };
    } catch (error) {
      logger.error('Portfolio analysis failed', { error });
      return {
        success: false,
        data: null,
        agentId: 'risk-agent-001',
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Assess risk using real RiskAgent
   */
  public async assessRisk(params: {
    address: string;
    portfolioData?: unknown;
    chain?: string;
  }): Promise<AgentOrchestrationResult> {
    await this.ensureInitialized();
    const startTime = Date.now();

    try {
      if (!this.riskAgent) {
        throw new Error('RiskAgent not initialized');
      }

      // Execute risk assessment
      const result = await this.riskAgent.executeTask({
        id: `risk-${Date.now()}`,
        action: 'assess_portfolio_risk',
        parameters: {
          portfolioAddress: params.address,
          chain: params.chain,
        },
        priority: 4,
        createdAt: new Date(),
        chain: params.chain,
      });

      // Persist last risk assessment for cold start recovery
      if (result.success && result.data) {
        const data = result.data as Record<string, unknown>;
        saveAgentState({
          last_risk_assessment: {
            riskScore: Number(data.riskScore || 0),
            drawdownPercent: Number(data.drawdownPercent || 0),
            volatility: Number(data.volatility || 0),
            recommendations: Number(data.recommendations || 0),
            timestamp: new Date().toISOString(),
          },
        }).catch(() => {/* non-critical */});
      }

      return {
        success: result.success,
        data: result.data,
        agentId: "risk-agent-001",
        executionTime: Date.now() - startTime,
        error: result.error || undefined,
      };
    } catch (error) {
      logger.error('Risk assessment failed', { error });
      return {
        success: false,
        data: null,
        agentId: 'risk-agent-001',
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate hedge recommendations using real HedgingAgent
   */
  public async generateHedgeRecommendations(params: {
    portfolioId: string;
    assetSymbol: string;
    notionalValue: number;
    chain?: string;
  }): Promise<AgentOrchestrationResult> {
    await this.ensureInitialized();
    const startTime = Date.now();

    try {
      if (!this.hedgingAgent) {
        throw new Error('HedgingAgent not initialized');
      }

      // Execute hedge analysis
      const result = await this.hedgingAgent.executeTask({
        id: `hedge-${Date.now()}`,
        action: 'analyze_hedge',
        parameters: {
          portfolioId: params.portfolioId,
          assetSymbol: params.assetSymbol,
          notionalValue: params.notionalValue,
          chain: params.chain,
        },
        priority: 4,
        createdAt: new Date(),
        chain: params.chain,
      });

      return {
        success: result.success,
        data: result.data,
        agentId: "hedging-agent-001",
        executionTime: Date.now() - startTime,
        error: result.error || undefined,
      };
    } catch (error) {
      logger.error('Hedge recommendation failed', { error });
      return {
        success: false,
        data: null,
        agentId: 'hedging-agent-001',
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Execute hedge position using real HedgingAgent + Moonlander
   */
  public async executeHedge(params: {
    market: string;
    side: 'LONG' | 'SHORT';
    notionalValue: string;
    leverage?: number;
    chain?: string;
  }): Promise<AgentOrchestrationResult> {
    await this.ensureInitialized();
    const startTime = Date.now();

    try {
      if (!this.hedgingAgent) {
        throw new Error('HedgingAgent not initialized');
      }

      // Execute hedge via HedgingAgent (routes to correct chain adapter)
      const result = await this.hedgingAgent.executeTask({
        id: `execute-hedge-${Date.now()}`,
        action: 'open_hedge',
        parameters: {
          market: params.market,
          side: params.side,
          notionalValue: params.notionalValue,
          leverage: params.leverage || 2,
          chain: params.chain,
        },
        priority: 5,
        createdAt: new Date(),
        chain: params.chain,
      });

      return {
        success: result.success,
        data: result.data,
        agentId: "hedging-agent-001",
        executionTime: Date.now() - startTime,
        error: result.error || undefined,
      };
    } catch (error) {
      logger.error('Hedge execution failed', { error });
      return {
        success: false,
        data: null,
        agentId: 'hedging-agent-001',
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate report using ReportingAgent
   */
  public async generateReport(params: {
    reportType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
    startDate?: Date;
    endDate?: Date;
  }): Promise<AgentOrchestrationResult> {
    await this.ensureInitialized();
    const startTime = Date.now();

    try {
      if (!this.reportingAgent) {
        throw new Error('ReportingAgent not initialized');
      }

      const result = await this.reportingAgent.executeTask({
        id: `report-${Date.now()}`,
        action: 'generate_report',
        parameters: {
          type: params.reportType,
          startDate: params.startDate,
          endDate: params.endDate,
        },
        priority: 2,
        createdAt: new Date(),
      });

      return {
        success: result.success,
        data: result.data,
        agentId: "reporting-agent-001",
        executionTime: Date.now() - startTime,
        error: result.error || undefined,
      };
    } catch (error) {
      logger.error('Report generation failed', { error });
      return {
        success: false,
        data: null,
        agentId: 'reporting-agent-001',
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get agent status
   */
  public getStatus(): {
    initialized: boolean;
    agents: {
      risk: boolean;
      hedging: boolean;
      reporting: boolean;
      lead: boolean;
      priceMonitor: boolean;
    };
    signerAvailable: boolean;
    snapshotAge: number | null;
  } {
    return {
      initialized: this.initialized,
      agents: {
        risk: this.riskAgent !== null,
        hedging: this.hedgingAgent !== null,
        reporting: this.reportingAgent !== null,
        lead: this.leadAgent !== null,
        priceMonitor: this.priceMonitorAgent !== null,
      },
      signerAvailable: this.signer !== null,
      snapshotAge: this.currentSnapshot ? Date.now() - this.currentSnapshot.timestamp : null,
    };
  }

  /**
   * Backwards-compatible alias used by tests: getAgentStatus
   */
  public getAgentStatus(): {
    initialized: boolean;
    riskAgent: RiskAgent | null;
    hedgingAgent: HedgingAgent | null;
    reportingAgent: ReportingAgent | null;
    leadAgent: LeadAgent | null;
    priceMonitorAgent: PriceMonitorAgent | null;
    signerAvailable: boolean;
  } {
    return {
      initialized: this.initialized,
      riskAgent: this.riskAgent,
      hedgingAgent: this.hedgingAgent,
      reportingAgent: this.reportingAgent,
      leadAgent: this.leadAgent,
      priceMonitorAgent: this.priceMonitorAgent,
      signerAvailable: this.signer !== null,
    };
  }

  /**
   * Get LeadAgent for direct orchestration
   * Ensures orchestrator is initialized first
   */
  public async getLeadAgent(): Promise<LeadAgent | null> {
    await this.ensureInitialized();
    return this.leadAgent;
  }

  /**
   * Get RiskAgent for direct access
   */
  public async getRiskAgent(): Promise<RiskAgent | null> {
    await this.ensureInitialized();
    return this.riskAgent;
  }

  /**
   * Get HedgingAgent for direct access
   */
  public async getHedgingAgent(): Promise<HedgingAgent | null> {
    await this.ensureInitialized();
    return this.hedgingAgent;
  }

  /**
   * Get PriceMonitorAgent for direct access
   */
  public getPriceMonitorAgent(): PriceMonitorAgent | null {
    return this.priceMonitorAgent;
  }

  // ─── AUTONOMOUS LEAD-AGENT CYCLE ──────────────────────────────────────────

  /**
   * Run one complete LeadAgent orchestration cycle. Invokes every wired
   * specialist agent (Risk → Hedging consensus → Hedging → Settlement →
   * Reporting), gathers their results, and returns the LeadAgent's
   * execution report.
   *
   * Designed to be called periodically from a cron (currently inlined at
   * the tail of sui-community-pool) so the 7-agent system fires
   * autonomously without depending on user API hits.
   *
   * The `action: 'analyze'` intent bypasses position-size validation
   * (the cycle is read-only). Each specialist runs its full pipeline
   * (real risk calc, real hedge recommendation, etc.) and returns its
   * data; LeadAgent collects, sends to ReportingAgent for the audit
   * trail, and returns the full report.
   */
  public async runAutonomousCycle(params: {
    chain?: 'sui' | 'cronos' | 'oasis-sapphire' | 'hedera';
    portfolioId?: number;
    walletAddress?: string;
  } = {}): Promise<{
    success: boolean;
    ranAt: string;
    durationMs: number;
    chain: string;
    portfolioId: number;
    riskScore?: number;
    riskLevel?: string;
    hedgeRecommendations?: number;
    needsRebalance?: boolean;
    settlementsProcessed?: number;
    zkProofs?: number;
    leadSummary?: string;
    priceMonitor?: {
      pricesFetched: number;
      alertsChecked: number;
      alertsTriggered: number;
      fiveMinProcessed: boolean;
      symbols: string[];
    } | null;
    error?: string;
  }> {
    const startTime = Date.now();
    const ranAt = new Date().toISOString();
    const chain = params.chain ?? 'sui';
    const portfolioId = params.portfolioId ?? -2;       // SUI community pool

    try {
      await this.ensureInitialized();
      if (!this.leadAgent) throw new Error('LeadAgent not initialized');

      // Build an "analyze" intent — read-only, no position changes.
      // requiredAgents covers the specialists that are MEANINGFUL for the
      // target chain. PriceMonitorAgent is ticked separately below.
      const requiredAgents: Array<'risk' | 'hedging' | 'reporting'> =
        ['risk', 'hedging', 'reporting'];
      const intent = {
        action: 'analyze' as const,
        targetPortfolio: portfolioId,
        chain,
        objectives: {
          yieldTarget: 0,
          riskLimit: 50,
        },
        constraints: {
          maxSlippage: 0.3,
          timeframe: 3600,
        },
        requiredAgents,
        estimatedComplexity: 'high' as const,
      };

      const report = await this.leadAgent.executeStrategyFromIntent(intent);

      // PriceMonitorAgent tick alongside the lead cycle. Standalone agent
      // (not in the LeadAgent chain) — its monitoringLoop can't survive
      // serverless suspend, so we drive one fetch+process cycle directly
      // via the new tick() one-shot. Best-effort: failures don't bubble.
      let priceMonitorTick: Awaited<ReturnType<PriceMonitorAgent['tick']>> | null = null;
      try {
        if (this.priceMonitorAgent) {
          priceMonitorTick = await this.priceMonitorAgent.tick();
          logger.info('[Orchestrator] PriceMonitorAgent tick complete', priceMonitorTick);
        }
      } catch (pmErr) {
        logger.warn('[Orchestrator] PriceMonitorAgent tick failed', {
          error: pmErr instanceof Error ? pmErr.message : String(pmErr),
        });
      }

      const riskData = (report.riskAnalysis ?? null) as null | { totalRisk?: number; riskLevel?: string };
      const hedgeData = (report.hedgingStrategy ?? null) as null | { needsRebalance?: boolean; positions?: unknown[]; recommendations?: unknown[] };
      const settlementData = (report.settlement ?? null) as null | { settled?: number; pending?: number };

      // Two-layer directive fusion + cycle-attestation write. Extracted to
      // keep runAutonomousCycle focused on the lead-cycle orchestration.
      // See publishDirectivesAndAttest for the Layer 1/2 semantics.
      await this.publishDirectivesAndAttest({
        chain, riskData, hedgeData, report, priceMonitorTick,
      });

      const summary = report.aiSummary ?? `Lead cycle: ${chain} portfolio ${portfolioId}, ` +
        `risk=${riskData?.totalRisk ?? '?'} ` +
        `hedge-recs=${hedgeData?.recommendations?.length ?? 0} ` +
        `settlements=${settlementData?.settled ?? 0}`;

      return {
        success: report.status === 'success',
        ranAt,
        durationMs: Date.now() - startTime,
        chain,
        portfolioId,
        riskScore: riskData?.totalRisk,
        riskLevel: riskData?.riskLevel,
        hedgeRecommendations: hedgeData?.recommendations?.length,
        needsRebalance: hedgeData?.needsRebalance,
        settlementsProcessed: settlementData?.settled,
        zkProofs: report.zkProofs.length,
        leadSummary: summary,
        priceMonitor: priceMonitorTick,
      };
    } catch (err) {
      logger.error('[AgentOrchestrator] runAutonomousCycle failed', { error: err });
      return {
        success: false,
        ranAt,
        durationMs: Date.now() - startTime,
        chain,
        portfolioId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── CENTRALIZED MARKET SNAPSHOT SHARING ──────────────────────────────────

  /**
   * Share a centralized MarketSnapshot with all agents.
   * Called by CentralizedHedgeManager at the start of each cycle so agents
   * can use this data instead of fetching independently.
   */
  public shareMarketSnapshot(snapshot: MarketSnapshot): void {
    this.currentSnapshot = snapshot;

    // Feed snapshot to PriceMonitorAgent so it skips its next independent fetch
    if (this.priceMonitorAgent) {
      this.priceMonitorAgent.ingestCentralizedPrices(snapshot);
    }

    logger.debug('[Orchestrator] Market snapshot shared with agents', {
      symbols: snapshot.prices.size,
      timestamp: snapshot.timestamp,
      source: snapshot.source,
    });
  }

  /**
   * TWO-LAYER FUSION per-asset directive publisher + cycle-attestation write.
   * Extracted from runAutonomousCycle so the parent method stays focused on
   * lead-cycle orchestration.
   *
   *   Layer 1 (base): PredictionAggregatorService per-asset raw signal —
   *     direction + confidence from Polymarket + Delphi + tickers + funding
   *     + cross-asset alignment.
   *   Layer 2 (override): HedgingAgent's LLM-reasoned recommendations
   *     (already computed inside the LeadAgent cycle above). When present,
   *     they override the raw signal so the trade guard consumes the
   *     AGENT'S interpretation, not just signal aggregation.
   *
   * Before the 2026-07-02 fusion upgrade, HedgingAgent output was purely
   * observational — `scripts/audit-agent-impact.ts` flagged it as
   * DECORATIVE. Now HedgingAgent-derived directives carry
   * source='hedging-agent'; PredictionAggregator-derived carry
   * source='signal-aggregator'; trade guard reads whichever won.
   *
   * Also writes `cycle-attestation:last` so the AgentTradeGuard can gate
   * on PriceMonitor alerts (PRICE_ALERT_GATE) and require ZK proofs for
   * large trades (REPORTING_ZK_ATTEST_GATE). All failures logged + swallowed.
   */
  private async publishDirectivesAndAttest(input: {
    chain: string;
    riskData: null | { totalRisk?: number; riskLevel?: string };
    hedgeData: null | { needsRebalance?: boolean; positions?: unknown[]; recommendations?: unknown[] };
    report: { aiSummary?: string; zkProofs?: unknown[]; status?: string };
    priceMonitorTick: { alertsTriggered?: number; symbols?: string[]; fiveMinProcessed?: boolean } | null;
  }): Promise<void> {
    const { chain, riskData, hedgeData, report, priceMonitorTick } = input;

    try {
      const { PredictionAggregatorService } = await import('@/lib/services/market-data/PredictionAggregatorService');
      const { resolveAgentUniverse } = await import('@/lib/config/agent-universe');
      const assetUniverse = await resolveAgentUniverse();
      const perAsset = await PredictionAggregatorService.getPerAssetPredictions(assetUniverse);
      const { publishDirectives } = await import('@/lib/services/agents/agent-trade-guard');
      const byAsset: Record<string, {
        asset: string;
        recommendedSide: 'LONG' | 'SHORT' | null;
        confidence: number;
        shouldHedge: boolean;
        reason: string;
        riskScore: number;
        computedAt: number;
        source?: 'hedging-agent' | 'signal-aggregator';
      }> = {};
      const overallRisk = Math.round(riskData?.totalRisk ?? 50);

      // Layer 1: seed byAsset from PredictionAggregator
      for (const [asset, pred] of Object.entries(perAsset)) {
        const dir = pred.direction;
        let side: 'LONG' | 'SHORT' | null = null;
        if (pred.recommendation.endsWith('LONG')) side = 'LONG';
        else if (pred.recommendation.endsWith('SHORT')) side = 'SHORT';
        else if (dir === 'UP') side = 'LONG';
        else if (dir === 'DOWN') side = 'SHORT';
        const shouldHedge = pred.recommendation !== 'WAIT' || dir !== 'NEUTRAL';
        byAsset[asset.toUpperCase()] = {
          asset: asset.toUpperCase(),
          recommendedSide: side,
          confidence: Math.round(pred.confidence ?? 0),
          shouldHedge,
          reason: `${pred.recommendation} (dir=${dir}, conf=${Math.round(pred.confidence ?? 0)}%, cons=${Math.round(pred.consensus ?? 0)}%)`,
          riskScore: overallRisk,
          computedAt: Date.now(),
          source: 'signal-aggregator',
        };
      }

      // Layer 2: overlay HedgingAgent's LLM-reasoned recommendations.
      // Shape (SUI): SuiHedgeRecommendation[] with confidence 0-1; (generic): 0-100. Coerce below.
      const hedgeRecs = (hedgeData?.recommendations ?? []) as Array<{
        asset?: string; pair?: string; side?: string;
        confidence?: number; reason?: string;
        suggestedSize?: number; action?: string;
      }>;
      let hedgingAgentOverrides = 0;
      for (const rec of hedgeRecs) {
        if (!rec || typeof rec !== 'object') continue;
        const asset = String(rec.asset ?? rec.pair ?? '').toUpperCase().replace(/-PERP$|USD.*$/, '');
        if (!asset) continue;
        const sideRaw = String(rec.side ?? '').toUpperCase();
        const side: 'LONG' | 'SHORT' | null =
          sideRaw === 'LONG' ? 'LONG' :
          sideRaw === 'SHORT' ? 'SHORT' : null;
        const rawConf = Number(rec.confidence ?? 0);
        const confidence = rawConf <= 1 ? Math.round(rawConf * 100) : Math.min(100, Math.round(rawConf));
        const shouldHedge = rec.action !== 'HOLD' && (side !== null);
        const prior = byAsset[asset];
        byAsset[asset] = {
          asset,
          recommendedSide: side,
          confidence,
          shouldHedge,
          reason: prior
            ? `HedgingAgent: ${String(rec.reason ?? 'no reason').slice(0, 120)} · (raw signal: ${prior.reason.slice(0, 60)})`
            : `HedgingAgent: ${String(rec.reason ?? 'no reason').slice(0, 120)}`,
          riskScore: overallRisk,
          computedAt: Date.now(),
          source: 'hedging-agent',
        };
        hedgingAgentOverrides++;
      }

      await publishDirectives({
        ranAt: Date.now(),
        chain,
        riskScore: overallRisk,
        riskLevel: riskData?.riskLevel ?? 'MEDIUM',
        byAsset,
      });
      logger.info('[Orchestrator] Per-asset directives published', {
        chain, overallRisk, hedgingAgentOverrides,
        totalAssets: Object.keys(byAsset).length,
        summary: Object.values(byAsset).map((d) =>
          `${d.asset}=${d.recommendedSide ?? '?'}/${d.confidence}%${d.shouldHedge ? '' : '/HOLD'}[${d.source === 'hedging-agent' ? 'HA' : 'PA'}]`,
        ).join(', '),
      });
    } catch (dirErr) {
      logger.warn('[Orchestrator] Per-asset directive computation failed', {
        error: dirErr instanceof Error ? dirErr.message : String(dirErr),
      });
    }

    // Cycle attestation write (best-effort; gate consumers tolerate missing key).
    try {
      const { setCronState } = await import('@/lib/db/cron-state');
      await setCronState('cycle-attestation:last', {
        ranAt: Date.now(),
        chain,
        zkProofsCount: report.zkProofs?.length ?? 0,
        priceAlerts: {
          alertsTriggered: priceMonitorTick?.alertsTriggered ?? 0,
          symbolsAlerted: priceMonitorTick?.symbols ?? [],
          fiveMinProcessed: priceMonitorTick?.fiveMinProcessed ?? false,
        },
        reportingSummary: (report.aiSummary ?? '').slice(0, 300),
        success: report.status === 'success',
      });
    } catch (attErr) {
      logger.warn('[Orchestrator] cycle-attestation write failed', {
        error: attErr instanceof Error ? attErr.message : String(attErr),
      });
    }
  }

  /**
   * Get the current shared MarketSnapshot (if any).
   * Agents can call this to use centralized prices before falling back to their own fetch.
   */
  public getSharedSnapshot(): MarketSnapshot | null {
    if (!this.currentSnapshot) return null;
    // Only return if fresh (< 30s)
    if (Date.now() - this.currentSnapshot.timestamp > 30_000) return null;
    return this.currentSnapshot;
  }
}

// Export singleton instance getter
export const getAgentOrchestrator = () => AgentOrchestrator.getInstance();

/**
 * Reset orchestrator for tests
 */
export const resetAgentOrchestrator = async () => {
  await AgentOrchestrator.resetInstance();
};


