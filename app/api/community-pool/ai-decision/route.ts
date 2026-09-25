/**
 * Community Pool AI Decision Route
 *
 * Uses AI to analyze REAL market conditions and decide on optimal allocation
 * between BTC, ETH, SUI, and CRO for the community pool.
 *
 * Data Sources:
 * - Central RealMarketDataService (Crypto.com Exchange API)
 * - Real market indicators, NOT simulated
 *
 * Endpoints:
 * - GET  /api/community-pool/ai-decision          - Get current AI recommendation
 * - POST /api/community-pool/ai-decision          - Trigger AI analysis and optionally apply
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
// Cronos community pool retired 2026-09-25. Hedera flows short-circuit
// above these callers; SUI has its own path. Stubs fail if a Cronos code
// path is hit.
const cronosRetired = () => { throw new Error('Cronos pool retired'); };
const applyAIDecision = (..._args: unknown[]) => cronosRetired() as any;
const getPoolSummary = (_chain?: string) => cronosRetired() as any;
const fetchExtendedMarketData = () => cronosRetired() as any;
import { SUPPORTED_ASSETS, SupportedAsset } from '@/lib/storage/community-pool-storage';
import { requireAdminAuth } from '@/lib/security/auth-middleware';
import { readLimiter, heavyLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// ============================================================================
// OPTIMIZATION: In-memory cache for AI recommendations (2 minute TTL)
// Reduces CPU and API calls for frequently requested endpoint
// ============================================================================
interface AIRecommendationCache {
  data: unknown;
  timestamp: number;
}
const AI_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
let aiRecommendationCache: AIRecommendationCache | null = null;

// Real market indicators from central RealMarketDataService
interface MarketIndicators {
  asset: SupportedAsset;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  volatility: 'low' | 'medium' | 'high';
  trend: 'bullish' | 'bearish' | 'neutral';
  score: number;
}

/**
 * Fetch market indicators using central RealMarketDataService
 * Converts extended market data to AI-ready indicators with trend/volatility analysis
 */
async function fetchRealMarketIndicators(): Promise<MarketIndicators[]> {
  const extendedData = await fetchExtendedMarketData();
  const indicators: MarketIndicators[] = [];

  for (const asset of SUPPORTED_ASSETS) {
    const data = extendedData.get(asset);
    if (!data) {
      throw new Error(`Missing market data for ${asset}`);
    }

    const { price, change24h, volume24h, high24h, low24h } = data;

    // Calculate real volatility from 24h range
    const rangePercent = price > 0 ? ((high24h - low24h) / price) * 100 : 0;
    let volatility: 'low' | 'medium' | 'high';
    if (rangePercent < 3) volatility = 'low';
    else if (rangePercent < 7) volatility = 'medium';
    else volatility = 'high';

    // Determine trend based on real 24h change
    let trend: 'bullish' | 'bearish' | 'neutral';
    if (change24h > 2) trend = 'bullish';
    else if (change24h < -2) trend = 'bearish';
    else trend = 'neutral';

    // Calculate score (0-100) based on real factors
    let score = 50; // Base score
    score += change24h * 2; // Momentum weight
    if (volatility === 'low') score += 10;
    else if (volatility === 'high') score -= 5;
    if (trend === 'bullish') score += 10;
    else if (trend === 'bearish') score -= 10;

    // Volume factor
    const volumeUSD = volume24h * price;
    if (volumeUSD > 100_000_000) score += 5;

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    indicators.push({
      asset,
      price,
      change24h,
      volume24h,
      high24h,
      low24h,
      volatility,
      trend,
      score,
    });

    logger.debug(`[AI Decision] ${asset} indicators via central service:`, {
      price,
      change24h,
      volatility,
      trend,
      score,
    });
  }

  logger.info('[AI Decision] Market indicators via RealMarketDataService', {
    assets: indicators.map((i) => i.asset),
  });

  return indicators;
}

/**
 * AI-based allocation decision using REAL market data
 * Uses live 24h price changes, volatility, and diversification principles
 */
async function generateAIAllocation(marketConditions?: {
  riskScore?: number;
  drawdownPercent?: number;
  volatility?: number;
  currentAllocations?: Record<string, number>;
}): Promise<{
  allocations: Record<SupportedAsset, number>;
  reasoning: string;
  confidence: number;
  indicators: MarketIndicators[];
  shouldRebalance: boolean;
}> {
  // Fetch REAL market indicators from Crypto.com
  const indicators = await fetchRealMarketIndicators();

  // Calculate allocations based on real scores
  const totalScore = indicators.reduce((sum, i) => sum + i.score, 0);

  // Sort by score for deterministic allocation
  const sortedIndicators = [...indicators].sort((a, b) => b.score - a.score);

  const allocations = {} as Record<SupportedAsset, number>;
  let remainingPercentage = 100;

  for (let i = 0; i < sortedIndicators.length; i++) {
    const indicator = sortedIndicators[i];
    if (i === sortedIndicators.length - 1) {
      // Last asset gets remaining percentage
      allocations[indicator.asset] = remainingPercentage;
    } else {
      // Calculate percentage based on score, with min 10% for diversification
      let percentage = Math.round((indicator.score / totalScore) * 100);
      percentage = Math.max(10, Math.min(40, percentage)); // 10-40% range for any single asset
      allocations[indicator.asset] = percentage;
      remainingPercentage -= percentage;
    }
  }

  // Generate reasoning with real data
  const topAsset = sortedIndicators[0];
  const bottomAsset = sortedIndicators[sortedIndicators.length - 1];

  // Calculate confidence based on real data quality
  // Higher confidence when assets show clear trends (not neutral) and lower volatility
  const clearTrends = indicators.filter((i) => i.trend !== 'neutral').length;
  const avgVolatility = indicators.filter((i) => i.volatility === 'high').length;
  let confidence = 60 + clearTrends * 8 - avgVolatility * 5;
  confidence = Math.max(50, Math.min(95, confidence));

  const reasoning = `AI Allocation Decision (${new Date().toISOString().split('T')[0]}):

**LIVE Market Analysis (Crypto.com):**
${indicators.map((i) => `- ${i.asset}: $${i.price.toLocaleString()} (${i.change24h > 0 ? '+' : ''}${i.change24h.toFixed(2)}% 24h) - ${i.trend} trend, ${i.volatility} volatility [HIGH: $${i.high24h.toLocaleString()} / LOW: $${i.low24h.toLocaleString()}]`).join('\n')}

**Recommendation:**
- Overweight ${topAsset.asset} (${allocations[topAsset.asset]}%) due to ${topAsset.trend} momentum and ${topAsset.volatility} volatility profile (score: ${topAsset.score.toFixed(1)})
- Underweight ${bottomAsset.asset} (${allocations[bottomAsset.asset]}%) showing ${bottomAsset.trend} signals (score: ${bottomAsset.score.toFixed(1)})
- Maintain diversification across all 4 assets to reduce portfolio risk

**Risk Assessment:** ${topAsset.volatility === 'high' ? 'Elevated' : 'Moderate'} risk environment
**Confidence Level:** ${Math.round(confidence)}% (based on trend clarity and market conditions)
**Data Source:** Real-time Crypto.com Exchange API`;

  // Determine if rebalancing should occur
  // Check if current allocations exist and calculate drift
  let shouldRebalance = false;
  if (marketConditions?.currentAllocations) {
    const drifts = SUPPORTED_ASSETS.map((asset) => {
      const current = marketConditions.currentAllocations![asset] || 0;
      const proposed = allocations[asset] || 0;
      return Math.abs(proposed - current);
    });
    const maxDrift = Math.max(...drifts);
    // Rebalance if max drift > 5% OR risk score >= 6
    shouldRebalance = maxDrift > 5 || (marketConditions.riskScore ?? 0) >= 6;
  } else {
    // Default: suggest rebalance if confidence is high
    shouldRebalance = confidence >= 75;
  }

  return { allocations, reasoning, confidence, indicators, shouldRebalance };
}

// ─── Hedera path — signal-driven allocation without the Cronos machinery ──
async function buildHederaRecommendation(request: NextRequest) {
  // Live prices for the three assets we project hedges across.
  const origin = request.nextUrl.origin;
  const [pricesRes, poolRes] = await Promise.all([
    fetch(`${origin}/api/prices?symbols=BTC,ETH,SUI`, { cache: 'no-store' }).catch(() => null),
    fetch(`${origin}/api/community-pool?chain=hedera&network=testnet`, { cache: 'no-store' }).catch(() => null),
  ]);
  const pricesJson = pricesRes ? await pricesRes.json().catch(() => ({})) : {};
  const poolJson = poolRes ? await poolRes.json().catch(() => ({})) : {};
  const prices = (pricesJson?.data ?? []) as Array<{ symbol: string; price: number; change24h: number }>;
  const nav = Number(poolJson?.pool?.totalValueUSD) || 0;

  // Derive per-asset trend from 24h change; use as a naive signal proxy.
  const bySymbol = new Map(prices.map((p) => [p.symbol, p]));
  const assets = ['BTC', 'ETH', 'SUI'] as const;
  const indicators = assets.map((asset) => {
    const p = bySymbol.get(asset);
    const change = Number(p?.change24h ?? 0);
    const trend: 'bullish' | 'bearish' | 'neutral' =
      change > 0.01 ? 'bullish' : change < -0.01 ? 'bearish' : 'neutral';
    return {
      asset,
      price: Number(p?.price ?? 0),
      change24h: change,
      trend,
      volatility: Math.abs(change) > 0.03 ? 'high' : Math.abs(change) > 0.01 ? 'medium' : 'low',
      score: Math.min(100, Math.round(Math.abs(change) * 100 * 20)),
    };
  });

  // Simple allocation: equal weight to the three assets IF any signal is
  // strong, else stay 100% USDC (hedge cash). Uses trend-count as gate.
  const bullishCount = indicators.filter((i) => i.trend === 'bullish').length;
  const shouldRebalance = bullishCount >= 2 && nav > 0;
  const allocationPct = shouldRebalance ? 30 : 0; // 30% per asset if signal
  const usdcPct = shouldRebalance ? 10 : 100;
  const allocations: Record<string, number> = shouldRebalance
    ? { BTC: allocationPct, ETH: allocationPct, SUI: allocationPct, USDC: usdcPct }
    : { USDC: 100, BTC: 0, ETH: 0, SUI: 0 };

  const currentPct = { USDC: 100, BTC: 0, ETH: 0, SUI: 0 };
  const changes = Object.keys(allocations).map((asset) => ({
    asset,
    currentPercent: currentPct[asset as keyof typeof currentPct] ?? 0,
    proposedPercent: allocations[asset],
    change: allocations[asset] - (currentPct[asset as keyof typeof currentPct] ?? 0),
  }));

  const trendSummary = indicators
    .map((i) => `${i.asset} ${i.trend} ${i.change24h >= 0 ? '+' : ''}${(i.change24h * 100).toFixed(2)}%`)
    .join(' · ');

  const reasoning = shouldRebalance
    ? `${bullishCount}/3 assets bullish — rotate into 30% per bullish asset, hold 10% USDC. Signal: ${trendSummary}. NAV: $${nav.toFixed(2)}.`
    : `Weak signal (${bullishCount}/3 bullish) — hold 100% USDC. Signal: ${trendSummary}. NAV: $${nav.toFixed(2)}. AI rotates only when at least 2/3 assets show clear trend.`;

  const confidence = Math.round(50 + (bullishCount / 3) * 40); // 50-90%

  return {
    success: true,
    recommendation: {
      allocations,
      shouldRebalance,
      reasoning,
      confidence,
      indicators,
      changes,
    },
    currentPool: {
      totalNAV: nav,
      allocations: {
        USDC: { percentage: 100 },
        BTC: { percentage: 0 },
        ETH: { percentage: 0 },
        SUI: { percentage: 0 },
      },
    },
    timestamp: Date.now(),
    source: 'hedera-signal-driven',
    note: 'Live signal fusion — Hedera pool is USDC-only today, allocation shows what the AI would target.',
  };
}

/**
 * GET - Get current AI recommendation without applying
 */
export async function GET(request: NextRequest) {
  // Rate limiting
  const rateLimitResponse = readLimiter.check(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const searchParams = request.nextUrl.searchParams;
    const forceRefresh = searchParams.get('refresh') === 'true';
    const chain = searchParams.get('chain') || undefined;

    // Hedera-specific short-circuit — the legacy getPoolSummary path is
    // Cronos-bound and throws for Hedera. Compose a live signal-driven
    // recommendation from the aggregator + on-chain NAV instead.
    if (chain === 'hedera') {
      const hederaResponse = await buildHederaRecommendation(request);
      return NextResponse.json(hederaResponse);
    }

    // OPTIMIZATION: Return cached response if fresh (2 minute TTL)
    if (
      !forceRefresh &&
      aiRecommendationCache &&
      Date.now() - aiRecommendationCache.timestamp < AI_CACHE_TTL_MS
    ) {
      logger.debug('[AI Decision] Returning cached recommendation');
      return NextResponse.json({
        ...(aiRecommendationCache.data as object),
        cached: true,
        cacheAge: Math.round((Date.now() - aiRecommendationCache.timestamp) / 1000),
      });
    }

    const poolSummary = await getPoolSummary(chain);
    const { allocations, reasoning, confidence, indicators, shouldRebalance } =
      await generateAIAllocation();

    // Calculate what would change
    const currentAllocations = poolSummary.allocations;
    const changes = SUPPORTED_ASSETS.map((asset) => ({
      asset,
      currentPercent: currentAllocations[asset].percentage,
      proposedPercent: allocations[asset],
      change: allocations[asset] - currentAllocations[asset].percentage,
    }));

    const responseData = {
      success: true,
      recommendation: {
        allocations,
        shouldRebalance,
        reasoning,
        confidence: Math.round(confidence),
        indicators,
        changes,
      },
      currentPool: poolSummary,
      timestamp: Date.now(),
      note: 'This is a recommendation. Use POST to apply the decision.',
    };

    // Cache the response
    aiRecommendationCache = {
      data: responseData,
      timestamp: Date.now(),
    };

    return NextResponse.json({
      ...responseData,
      cached: false,
    });
  } catch (error: unknown) {
    return safeErrorResponse(error, 'CommunityPool AI GET');
  }
}

/**
 * POST - Generate and optionally apply AI decision
 */
export async function POST(request: NextRequest) {
  // Rate limiting
  const rateLimitResponse = heavyLimiter.check(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const { apply = false, marketConditions, chain } = body;

    // If applying changes, require admin auth (internal API only)
    if (apply) {
      const adminAuth = await requireAdminAuth(request);
      if (adminAuth instanceof NextResponse) return adminAuth;
    }

    const { allocations, reasoning, confidence, indicators, shouldRebalance } =
      await generateAIAllocation(marketConditions);

    if (!apply) {
      // Just return the recommendation
      const poolSummary = await getPoolSummary(chain);
      const changes = SUPPORTED_ASSETS.map((asset) => ({
        asset,
        currentPercent: poolSummary.allocations[asset].percentage,
        proposedPercent: allocations[asset],
        change: allocations[asset] - poolSummary.allocations[asset].percentage,
      }));

      return NextResponse.json({
        success: true,
        recommendation: {
          allocations,
          shouldRebalance,
          reasoning,
          confidence: Math.round(confidence),
          indicators,
          changes,
        },
        applied: false,
        message: 'Recommendation generated. Set apply:true to execute.',
      });
    }

    // Apply the AI decision
    const result = await applyAIDecision(allocations, reasoning, chain);

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    // Calculate changes from previous and new allocations
    const changes = SUPPORTED_ASSETS.map((asset) => ({
      asset,
      previousPercent: result.previousAllocations[asset],
      newPercent: result.newAllocations[asset],
      change: result.newAllocations[asset] - result.previousAllocations[asset],
    }));

    return NextResponse.json({
      success: true,
      applied: true,
      message: 'AI allocation decision applied successfully',
      result: {
        previousAllocations: result.previousAllocations,
        newAllocations: result.newAllocations,
        trades: result.trades,
        changes,
      },
      reasoning,
      confidence: Math.round(confidence),
      timestamp: Date.now(),
    });
  } catch (error: unknown) {
    return safeErrorResponse(error, 'CommunityPool AI POST');
  }
}
