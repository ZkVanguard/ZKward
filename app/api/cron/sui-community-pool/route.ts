/**
 * Cron Job: SUI Community Pool AI Management (USDC)
 * 
 * Invoked by Upstash QStash every 30 minutes to:
 * 1. Fetch SUI pool on-chain stats (USDC balance, shares, members)
 * 2. Record NAV snapshot with 3-asset allocation tracking (BTC/ETH/SUI)
 * 3. Sync member data from on-chain → DB
 * 4. Run AI allocation decision (BTC/ETH/SUI)
 * 5. Trigger auto-hedge via BlueFin when risk is elevated
 * 
 * 3 Assets: BTC, ETH, SUI
 * Deposit token: USDC on SUI
 * 
 * Security: QStash signature verification + CRON_SECRET fallback
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { isPoolTradingEnabled } from '@/lib/services/sui/pool-trading-pause';
import { verifyCronRequest } from '@/lib/qstash';
import { getSuiUsdcPoolService, validateSuiMainnetConfig } from '@/lib/services/sui/SuiCommunityPoolService';
import { initCommunityPoolTables } from '@/lib/db/community-pool';
import { query } from '@/lib/db/postgres';
import { setCronState, tryClaimCronRun } from '@/lib/db/cron-state';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';
import { getSuiPoolAgent, type AllocationDecision } from '@/agents/specialized/SuiPoolAgent';
import { syncMembersToDb, savePoolState } from '@/lib/services/sui/cron/persistence';
import { notifyDiscord } from '@/lib/utils/discord-notify';
// v0.3.0 defense dispatch — statically imported so the graph sees the
// call chain. Previously loaded via `await import()` inside try-blocks
// (36 dynamic imports in this file); tree-sitter can't resolve those,
// so the entire defense pipeline was invisible in graph queries.
// Enclosing try-blocks handle runtime failures; converting the imports
// doesn't change error semantics (they still swallow throws).
import { runStep8AutoHedge } from '@/lib/services/sui/cron/step-8-auto-hedge';
import { runStep7_9DriftClose } from '@/lib/services/sui/cron/step-7-9-drift-close';
import { runStep4NavDefense } from '@/lib/services/sui/cron/step-4-nav-defense';
import { runStep7Rebalance } from '@/lib/services/sui/cron/step-7-rebalance';
import { runStep65HedgeSettle } from '@/lib/services/sui/cron/step-6-5-hedge-settle';
import { runStep66DriftRebalance } from '@/lib/services/sui/cron/step-6-6-drift-rebalance';
import { runStep9LogDecision } from '@/lib/services/sui/cron/step-9-log-decision';
import { runPolyDiscoverTick } from '@/lib/services/market-data/poly-discover-tick';
import { getAgentOrchestrator } from '@/lib/services/agent-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Rate limiting: prevent duplicate cron runs within 5 minutes.
// `lastSuccessfulRunTimestamp` is a per-instance fast-path; the real
// guard is the DB-backed CAS lock (`tryClaimCronRun`) so QStash retries
// and Vercel cold-start instances cannot double-execute.
let lastSuccessfulRunTimestamp = 0;
const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CRON_LOCK_KEY = 'sui-community-pool';
// Hard ceiling on pool NAV in USDC. Above this, the on-chain Move
// fee/withdrawal-cap math (`nav * bps * t`) approaches u64 limits
// and silently wraps. Mainnet contracts must be redeployed with u128
// before crossing this threshold. Override only after verifying the
// new package id has the u128 fixes.
// The Move contract already uses u128 intermediates for every NAV × bps ×
// time multiplication (community_pool_usdc.move:713, :738, :763), so the
// arithmetic itself is safe up to $18 trillion (u64::MAX in USDC micro-
// units). The ceiling here is a defensive shim that also gates against
// second-order risks:
//   - accumulated fee counters (u64) — safe up to ~$1.8T total accrued
//   - BlueFin perp OI ceiling (venue-level) — real limit ~$10-100M today
//   - single-tx DEX slippage — real limit ~$1-5M
// $10B is chosen as the *scale-readiness* ceiling; above that the
// multi-venue router + OTC path must be active or the pool blocks writes.
const NAV_SAFETY_CEILING_USDC = Number(process.env.NAV_SAFETY_CEILING_USDC) || 10_000_000_000;

// Step 6.6 drift-rebalance tunables (REBALANCE_DRIFT_THRESHOLD_PCT +
// MAX_REBALANCE_SELL_USD) now live in step-6-6-drift-rebalance.ts.

// 3 pool assets (SUI community pool — BTC, ETH, SUI only)
const POOL_ASSETS = ['BTC', 'ETH', 'SUI'] as const;
type PoolAsset = (typeof POOL_ASSETS)[number];

interface SuiCronResult {
  success: boolean;
  chain: 'sui';
  poolStats?: {
    totalNAV_USDC: string;
    totalShares: string;
    sharePrice: string;
    memberCount: number;
    allocations: Record<PoolAsset, number>;
  };
  aiDecision?: {
    action: string;
    allocations: Record<PoolAsset, number>;
    confidence: number;
    reasoning: string;
    swappableAssets?: string[];
    hedgedAssets?: string[];
    riskScore?: number;
  };
  riskScore?: number;
  pricesUSD?: Record<string, number>;
  autoHedge?: {
    triggered: boolean;
    hedges?: Array<{
      symbol: string;
      side: string;
      size: number;
      status: string;
      orderId?: string;
      error?: string;
    }>;
  };
  rebalanceSwaps?: {
    planned: number;
    executable: number;
    quotes: Array<{
      asset: string;
      amountInUsdc: string;
      expectedOut: string;
      route: string;
      canSwap: boolean;
    }>;
    simulated?: number;
    swappableAssets?: string[];
    hedgedAssets?: string[];
    executed?: number;
    failed?: number;
    txDigests?: Array<{ asset: string; digest: string }>;
  };
  driftRebalance?: {
    preHoldings: Record<string, number>;
    targets: Record<string, number>;
    deltas: Record<string, number>;
    sold: Array<{ asset: string; usdcReceived: number; driftPct: number; txDigest?: string; error?: string }>;
    totalSoldUsdc: number;
    executionAllocations?: Record<string, number>;
    skippedReason?: string;
  };
  duration: number;
  error?: string;
}



// ============================================================================
// GET Handler — QStash / Vercel Cron
// ============================================================================

export async function GET(request: NextRequest): Promise<NextResponse<SuiCronResult>> {
  const startTime = Date.now();

  // Verify QStash signature or CRON_SECRET
  const authResult = await verifyCronRequest(request, 'SUI CommunityPool Cron');
  if (authResult !== true) {
    return NextResponse.json(
      { success: false, chain: 'sui', error: 'Unauthorized', duration: Date.now() - startTime },
      { status: 401 }
    );
  }

  const network = ((process.env.SUI_NETWORK || 'testnet').trim()) as 'mainnet' | 'testnet';
  logger.info('[SUI Cron] Starting SUI community pool AI management', { network });

  // MAINNET SAFETY: Reject if contract addresses not configured
  if (network === 'mainnet') {
    const missing = validateSuiMainnetConfig();
    if (missing.length > 0) {
      logger.error('[SUI Cron] MAINNET CONFIG INCOMPLETE — aborting cron', { missing });
      return NextResponse.json(
        { success: false, chain: 'sui' as const, error: `Mainnet not configured. Missing: ${missing.join(', ')}`, duration: Date.now() - startTime },
        { status: 503 }
      );
    }
  }

  // Rate limit + distributed lock. The in-memory check is a fast-path that
  // catches same-instance reruns; the DB CAS is the authority that defeats
  // QStash retries and Vercel cold-start duplicates.
  const timeSinceLastRun = startTime - lastSuccessfulRunTimestamp;
  if (lastSuccessfulRunTimestamp > 0 && timeSinceLastRun < MIN_CRON_INTERVAL_MS) {
    logger.warn('[SUI Cron] Rate limited (in-memory) — too soon since last run', {
      secondsSinceLast: Math.round(timeSinceLastRun / 1000),
      minIntervalSeconds: MIN_CRON_INTERVAL_MS / 1000,
    });
    return NextResponse.json(
      { success: false, chain: 'sui' as const, error: `Rate limited. Last run ${Math.round(timeSinceLastRun / 1000)}s ago, min interval is ${MIN_CRON_INTERVAL_MS / 1000}s`, duration: Date.now() - startTime },
      { status: 429 }
    );
  }
  // DB-backed CAS lock: fails closed on any error so we never double-fire.
  const claim = await tryClaimCronRun(CRON_LOCK_KEY, MIN_CRON_INTERVAL_MS, startTime);
  if (!claim.claimed) {
    logger.warn('[SUI Cron] Distributed lock denied run', {
      reason: claim.reason,
      lastRunMs: claim.lastRunMs,
      secondsSinceLast: claim.lastRunMs > 0 ? Math.round((startTime - claim.lastRunMs) / 1000) : null,
    });
    return NextResponse.json(
      {
        success: false,
        chain: 'sui' as const,
        error: `Distributed lock denied (${claim.reason || 'unknown'})`,
        duration: Date.now() - startTime,
      },
      { status: 429 },
    );
  }

  try {
    // M3: Validate admin key format early (fail-fast, not during swap execution)
    const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
    if (adminKey) {
      // Reject if someone accidentally set a wallet address (0x + 64 hex) instead of a private key
      // A proper key is either bech32 (suiprivkey...) or will derive a DIFFERENT address than its own hex
      if (!adminKey.startsWith('suiprivkey') && /^0x[0-9a-fA-F]{64}$/.test(adminKey)) {
        // Could be hex key OR an address — derive and check
        try {
          const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
          const kp = Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.slice(2), 'hex'));
          const derived = kp.getPublicKey().toSuiAddress();
          if (derived !== adminKey) {
            // Valid hex key — derives to a different address (expected)
            logger.info('[SUI Cron] Admin key validated', { derivedWallet: derived.slice(0, 16) + '...' });
          }
          // If derived === adminKey, that would be astronomically unlikely for a real key
          // but we don't block it since the key format is technically valid
        } catch {
          logger.error('[SUI Cron] Invalid SUI_POOL_ADMIN_KEY — cannot derive keypair from hex');
          return NextResponse.json(
            { success: false, chain: 'sui' as const, error: 'Invalid SUI_POOL_ADMIN_KEY — failed to derive keypair', duration: Date.now() - startTime },
            { status: 503 }
          );
        }
      } else if (!adminKey.startsWith('suiprivkey')) {
        const isValidHex = /^[0-9a-fA-F]{64}$/.test(adminKey);
        if (!isValidHex) {
          logger.error('[SUI Cron] Invalid SUI_POOL_ADMIN_KEY format — must be suiprivkey... or 64-char hex');
          return NextResponse.json(
            { success: false, chain: 'sui' as const, error: 'Invalid SUI_POOL_ADMIN_KEY format', duration: Date.now() - startTime },
            { status: 503 }
          );
        }
      }
    }

    // Step 0: Ensure DB tables exist
    await initCommunityPoolTables();

    // Step 1: Fetch on-chain SUI pool stats
    const suiService = getSuiUsdcPoolService(network);
    const poolStats = await suiService.getPoolStats();

    logger.info('[SUI Cron] Pool stats fetched', {
      totalNAV: poolStats.totalNAV,
      totalNAVUsd: poolStats.totalNAVUsd,
      members: poolStats.memberCount,
      sharePrice: poolStats.sharePrice,
    });

    // Step 2: Fetch live prices for all 4 assets
    const pricesUSD: Record<string, number> = {};
    let pricesFetched = false;
    try {
      const results = await Promise.allSettled(
        POOL_ASSETS.map(async (asset) => {
          const validated = await getMultiSourceValidatedPrice(asset);
          return { asset, price: validated.price };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          // Reject 0/NaN/Infinity prices — these break NAV math and cause
          // divide-by-zero in size = notional/price. Better to halt the
          // cycle than to open Infinity-sized hedges.
          const p = Number(r.value.price);
          if (Number.isFinite(p) && p > 0) {
            pricesUSD[r.value.asset] = p;
          }
        }
      }
      pricesFetched = Object.keys(pricesUSD).length === POOL_ASSETS.length;
      logger.info('[SUI Cron] Prices fetched', pricesUSD);
    } catch (priceErr) {
      logger.error('[SUI Cron] Price fetch failed - aborting allocation decisions', { error: priceErr });
      return NextResponse.json({
        success: false,
        chain: 'sui' as const,
        duration: Date.now() - startTime,
        error: 'Price fetch failed - cannot make allocation decisions without prices',
      }, { status: 500 });
    }

    if (!pricesFetched) {
      logger.error('[SUI Cron] Incomplete prices - only got prices for: ' + Object.keys(pricesUSD).join(', '));
      return NextResponse.json({
        success: false,
        chain: 'sui' as const,
        duration: Date.now() - startTime,
        error: `Incomplete price data: got ${Object.keys(pricesUSD).length}/${POOL_ASSETS.length} prices`,
      }, { status: 500 });
    }

    // Step 3: Get AI allocation decision via SuiPoolAgent
    // Uses enhanced pipeline: prediction markets + risk cascade + sentiment + correlation
    const suiAgent = getSuiPoolAgent(network);

    // Fetch current allocations from last AI decision in DB (no hardcoded defaults)
    const currentAllocations: Record<string, number> = {
      BTC: 0,
      ETH: 0,
      SUI: 0,
    };
    try {
      const lastDecisions = await query(
        `SELECT details FROM community_pool_transactions 
         WHERE type = 'AI_DECISION' AND details->>'chain' = 'sui'
         ORDER BY created_at DESC LIMIT 1`
      ) as Array<{ details: Record<string, unknown> }>;
      if (lastDecisions.length > 0 && lastDecisions[0].details?.allocations) {
        const saved = lastDecisions[0].details.allocations as Record<string, number>;
        for (const asset of POOL_ASSETS) {
          if (typeof saved[asset] === 'number') {
            currentAllocations[asset] = saved[asset];
          }
        }
        logger.info('[SUI Cron] Loaded last AI allocations from DB', currentAllocations);
      } else {
        logger.info('[SUI Cron] No previous AI decision found, using zero allocations (first run)');
      }
    } catch (allocErr) {
      logger.warn('[SUI Cron] Could not load previous allocations from DB', { error: allocErr });
    }

    // Try enhanced allocation (prediction markets + AI intelligence) first,
    // fall back to basic allocation if external APIs are unavailable
    let aiResult: AllocationDecision;
    let enhancedContext: {
      marketSentiment?: string;
      recommendations?: string[];
      riskAlerts?: string[];
      correlationInsight?: string;
      predictionSignals?: Array<{ market: string; signal: string; probability: number }>;
      urgency?: string;
    } = {};

    try {
      const enhanced = await suiAgent.getEnhancedAllocationContext();
      aiResult = {
        allocations: enhanced.allocations,
        confidence: enhanced.confidence,
        reasoning: enhanced.reasoning,
        shouldRebalance: true, // Enhanced context triggers rebalance when urgency is medium+
        swappableAssets: ['BTC', 'ETH', 'SUI'] as PoolAsset[],
        hedgedAssets: [] as PoolAsset[],
        riskScore: enhanced.urgency === 'CRITICAL' ? 9 : enhanced.urgency === 'HIGH' ? 7 : enhanced.urgency === 'MEDIUM' ? 5 : 3,
      };
      // Check drift to decide if rebalance is actually needed
      const maxDrift = Math.max(
        ...POOL_ASSETS.map(a => Math.abs((enhanced.allocations[a] || 25) - (currentAllocations[a] || 25)))
      );
      aiResult.shouldRebalance = maxDrift > 3 || enhanced.confidence >= 65 || enhanced.urgency === 'MEDIUM' || enhanced.urgency === 'HIGH' || enhanced.urgency === 'CRITICAL';

      enhancedContext = {
        marketSentiment: enhanced.marketSentiment,
        recommendations: enhanced.recommendations,
        riskAlerts: enhanced.riskAlerts,
        correlationInsight: enhanced.correlationInsight,
        predictionSignals: enhanced.predictionSignals,
        urgency: enhanced.urgency,
      };

      logger.info('[SUI Cron] Enhanced AI allocation (prediction markets + intelligence)', {
        allocations: aiResult.allocations,
        confidence: aiResult.confidence,
        sentiment: enhanced.marketSentiment,
        urgency: enhanced.urgency,
        predictionSignals: enhanced.predictionSignals?.length || 0,
        riskAlerts: enhanced.riskAlerts?.length || 0,
        recommendations: enhanced.recommendations?.length || 0,
      });
    } catch (enhancedErr) {
      logger.warn('[SUI Cron] Enhanced allocation failed, falling back to basic', {
        error: enhancedErr instanceof Error ? enhancedErr.message : String(enhancedErr),
      });
      const indicators = await suiAgent.analyzeMarket();
      aiResult = suiAgent.generateAllocation(indicators, currentAllocations);
    }

    logger.info('[SUI Cron] AI Agent decision', {
      allocations: aiResult.allocations,
      confidence: aiResult.confidence,
      shouldRebalance: aiResult.shouldRebalance,
      swappableAssets: aiResult.swappableAssets,
      hedgedAssets: aiResult.hedgedAssets,
      riskScore: aiResult.riskScore,
      enhanced: Object.keys(enhancedContext).length > 0,
    });

    // Step 4: NAV snapshot + v0.3.0 defense stack
    // ═══════════════════════════════════════════════════════════════
    // Extracted to lib/services/sui/cron/step-4-nav-defense.ts —
    // scale ceiling + hedgeability clamp + profit-lock guard +
    // alert-response override + PortfolioDriver corrective unwind +
    // external NAV attest + NAV snapshot persist. aiResult.allocations
    // is mutated in-place, matching the inline block's behavior.
    const { navUsd, sharePriceUsd, aboveSafetyCeiling } = await runStep4NavDefense({
      poolStats, pricesUSD, aiResult,
      navSafetyCeilingUsdc: NAV_SAFETY_CEILING_USDC,
      network,
    });


    // Step 5: Sync members to DB from on-chain
    await syncMembersToDb({ suiService, suiPriceUsd: pricesUSD['SUI'] || 0 });

    // Step 6: Save pool state to DB
    await savePoolState({
      navUsd,
      sharePriceUsd,
      poolStats,
      allocations: aiResult.allocations,
      reasoning: aiResult.reasoning,
      pricesUSD,
    });

    // Capital-moving steps run only when trading is enabled (see
    // pool-trading-pause.ts). They already skip on `aboveSafetyCeiling`, so
    // the pause rides the same switch. Step 4 above (NAV, attestation,
    // snapshot) always runs.
    const tradingPaused = !isPoolTradingEnabled();
    const skipCapitalSteps = aboveSafetyCeiling || tradingPaused;
    if (tradingPaused) logger.info('[SUI Cron] Trading paused (SUI_POOL_TRADING_ENABLED is not set) — skipping settle, rebalance and hedge');

    // Step 6.5: Settle PREVIOUS cycle's hedges
    // ═══════════════════════════════════════════════════════════════
    // Extracted to lib/services/sui/cron/step-6-5-hedge-settle.ts —
    // shortfall-only replenish (598484a7 fix) + Audit-15 residual guard.
    const { hedgeSettlement } = await runStep65HedgeSettle({
      navUsd, aboveSafetyCeiling: skipCapitalSteps, pricesUSD, network,
    });


    // Step 6.6: Drift-based pre-rebalance
    // ═══════════════════════════════════════════════════════════════
    // Extracted to lib/services/sui/cron/step-6-6-drift-rebalance.ts —
    // sells overweight asset(s) to USDC so Step 7 has budget to buy
    // underweight assets. Emits executionAllocations for Step 7.
    const { driftRebalance, executionAllocations } = await runStep66DriftRebalance({
      navUsd, aboveSafetyCeiling: skipCapitalSteps, pricesUSD, aiResult, network,
    });


    // Step 7: Plan + Execute rebalance via SuiPoolAgent
    // ═══════════════════════════════════════════════════════════════
    // Extracted to lib/services/sui/cron/step-7-rebalance.ts —
    // rebalance planning + 7b (pool→admin USDC transfer with hedge-cap
    // ratio + reserve + daily-cap enforcement and AI-driven daily reset)
    // + 7c (re-plan against actual budget) + 7d (log hedged positions).
    const { rebalanceSwaps } = await runStep7Rebalance({
      navUsd, aboveSafetyCeiling: skipCapitalSteps,
      currentAllocations, executionAllocations,
      aiResult, enhancedContext, network,
    });


    // Step 7.9: Position-Drift Auto-Close (AG10)
    // ═══════════════════════════════════════════════════════════════
    // Extracted to lib/services/sui/cron/step-7-9-drift-close.ts.
    // Fire-and-forget: the module logs its own summary + swallows errors
    // so Step 8 continues even if the drift check throws.
    if (!tradingPaused) await runStep7_9DriftClose();

    // Step 8: Auto-Hedge via BlueFin perpetuals — BTC, ETH, SUI
    // ═══════════════════════════════════════════════════════════════
    // Extracted to lib/services/sui/cron/step-8-auto-hedge.ts —
    // signal-driven hedging with drawdown auto-halt, dedup gate,
    // self-healing reconciler, dust prevention, agent gate, per-fill
    // verification, ZK commitment emission. Behavior verbatim.
    const autoHedgeResult = await runStep8AutoHedge({
      navUsd, pricesUSD, aiResult, enhancedContext,
      aboveSafetyCeiling: skipCapitalSteps, navSafetyCeilingUsdc: NAV_SAFETY_CEILING_USDC, network,
      poolStats,
    });


    // Step 9: Log AI decision to transaction history
    // ═══════════════════════════════════════════════════════════════
    // Extracted to lib/services/sui/cron/step-9-log-decision.ts.
    await runStep9LogDecision({
      navUsd, sharePriceUsd, poolStats, pricesUSD, aiResult,
      enhancedContext, rebalanceSwaps,
    });


    // Build response
    const result: SuiCronResult = {
      success: true,
      chain: 'sui',
      poolStats: {
        totalNAV_USDC: navUsd.toFixed(2),
        totalShares: poolStats.totalShares.toFixed(4),
        sharePrice: (sharePriceUsd || poolStats.sharePrice).toFixed(6),
        memberCount: poolStats.memberCount,
        allocations: aiResult.allocations,
      },
      aiDecision: {
        action: aiResult.shouldRebalance ? 'REBALANCE' : 'HOLD',
        allocations: aiResult.allocations,
        confidence: aiResult.confidence,
        reasoning: aiResult.reasoning,
        swappableAssets: aiResult.swappableAssets,
        hedgedAssets: aiResult.hedgedAssets,
        riskScore: aiResult.riskScore,
        ...(enhancedContext.marketSentiment && { marketSentiment: enhancedContext.marketSentiment }),
        ...(enhancedContext.urgency && { urgency: enhancedContext.urgency }),
        ...(enhancedContext.predictionSignals && { predictionSignals: enhancedContext.predictionSignals }),
        ...(enhancedContext.riskAlerts?.length && { riskAlerts: enhancedContext.riskAlerts }),
        ...(enhancedContext.correlationInsight && { correlationInsight: enhancedContext.correlationInsight }),
        ...(enhancedContext.recommendations?.length && { recommendations: enhancedContext.recommendations }),
      },
      pricesUSD,
      autoHedge: autoHedgeResult.triggered ? autoHedgeResult : undefined,
      rebalanceSwaps,
      ...(driftRebalance && { driftRebalance }),
      ...(hedgeSettlement && { hedgeSettlement }),
      duration: Date.now() - startTime,
    };

    logger.info('[SUI Cron] Completed successfully', {
      duration: result.duration,
      action: result.aiDecision?.action,
      autoHedgeTriggered: autoHedgeResult.triggered,
    });

    // Update rate limit timestamp on success
    lastSuccessfulRunTimestamp = Date.now();

    // Piggy-back poly-discover at the tail. QStash free-tier is at its
    // 10-schedule cap so we run discovery + momentum + relevance + theme
    // analysis here instead of a standalone cron — same 30-min cadence
    // either way, plus we always run after the AI allocation tick that
    // would actually use the data. Wrapped in try/catch so a Polymarket
    // outage can never fail the SUI cron.
    try {
      const polyResult = await runPolyDiscoverTick();
      // Heartbeat for /api/health/production cron-freshness check on the
      // poly-discover key, so ops can still tell discovery is running.
      void setCronState('cron:lastRun:poly-discover', Date.now()).catch(() => {});
      logger.info('[SUI Cron] poly-discover (inlined) complete', {
        discovered: polyResult.discoveredCount,
        newAssets: polyResult.newSinceLastTick.length,
        newHighImpact: polyResult.broad.newHighImpactCount,
        hotMovers: polyResult.broad.hotMoversCount,
        themesAlerted: polyResult.broad.themesAlerted,
      });
    } catch (polyErr) {
      logger.warn('[SUI Cron] inlined poly-discover failed (non-fatal)', {
        error: polyErr instanceof Error ? polyErr.message : String(polyErr),
      });
    }

    // LeadAgent autonomous cycle — invokes Risk → Hedging consensus →
    // Hedging → Settlement → Reporting in sequence so the 7-agent
    // architecture actually fires every 30min instead of being dormant
    // until someone hits an API endpoint. Result persisted to
    // `lead-cycle:last-decision` for surfacing via the latest endpoint
    // + UI. Try/catch'd so a specialist failure can never break the
    // SUI cron.
    try {
      const orchestrator = getAgentOrchestrator();
      const cycle = await orchestrator.runAutonomousCycle({
        chain: 'sui',
        portfolioId: -2,
      });
      await Promise.all([
        setCronState('cron:lastRun:lead-cycle', Date.now()).catch(() => {}),
        setCronState('lead-cycle:last-decision', { ts: Date.now(), ...cycle }).catch(() => {}),
      ]);
      logger.info('[SUI Cron] LeadAgent autonomous cycle complete', {
        success: cycle.success,
        riskScore: cycle.riskScore,
        hedgeRecs: cycle.hedgeRecommendations,
        durationMs: cycle.durationMs,
      });
      // Discord ping on actionable findings: high risk OR rebalance needed.
      if (cycle.success && (cycle.needsRebalance || (cycle.riskScore ?? 0) > 70)) {
        try {
          await notifyDiscord(
            `🤖 LeadAgent cycle: risk=${cycle.riskScore ?? '?'}/${cycle.riskLevel ?? '?'}, ` +
            `hedge-recs=${cycle.hedgeRecommendations ?? 0}, ` +
            `rebalance=${cycle.needsRebalance ? 'YES' : 'no'}. ` +
            (cycle.leadSummary ?? '').slice(0, 200),
            cycle.needsRebalance ? 'WARN' : 'INFO',
            { cycle },
          ).catch(() => {});
        } catch { /* best-effort */ }
      }
    } catch (cycleErr) {
      logger.warn('[SUI Cron] LeadAgent cycle failed (non-fatal)', {
        error: cycleErr instanceof Error ? cycleErr.message : String(cycleErr),
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[SUI Cron] Failed', { error: message });

    return NextResponse.json(
      {
        success: false,
        chain: 'sui' as const,
        error: message,
        duration: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}

// QStash sends POST by default — support both methods
export const POST = GET;
