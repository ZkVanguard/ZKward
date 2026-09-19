/**
 * Prediction Market Aggregator Service
 * 
 * Combines multiple prediction market data sources to produce
 * optimized hedge recommendations for the community pool.
 * 
 * Data Sources:
 * 1. Polymarket 5-min BTC signals (short-term sentiment)
 * 2. Crypto.com market data (real-time prices, 24h momentum)
 * 3. Delphi Digital predictions (medium-term market outlook)
 * 4. On-chain metrics (funding rates approximated from sentiment)
 * 
 * Weighting: Each source gets a confidence-weighted score
 * Final recommendation combines all signals for optimal hedging
 */

import { logger } from '@/lib/utils/logger';
import { cache } from '../../utils/cache';
import {
  scoreTradeOpportunity,
  determineRecommendation as determineRecommendationPure,
  calculateSizeMultiplier as calculateSizeMultiplierPure,
} from '@/lib/services/market-data/opportunity-scoring';
import type { FiveMinBTCSignal } from './Polymarket5MinService';
import type { PredictionMarket } from './DelphiMarketService';
import type { MultiAssetSignal } from './MultiAssetSignalService';
import { MultiAssetSignalService } from './MultiAssetSignalService';
import { ManifoldMarketService } from './ManifoldMarketService';
import { SignalDriftFusion, type FusionUpgrade } from './SignalDriftFusion';

// ─── Types ───────────────────────────────────────────────────────────

export interface PredictionSource {
  name: string;
  type: 'short_term' | 'medium_term' | 'long_term' | 'sentiment' | 'on_chain';
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number; // 0-100
  probability: number; // 0-100 for the predicted direction
  weight: number; // How much this source influences the final decision
  rawData: unknown;
  fetchedAt: number;
}

export interface AggregatedPrediction {
  /** Overall predicted direction */
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  /** Combined confidence (weighted average) */
  confidence: number;
  /** Overall probability of the predicted direction */
  probability: number;
  /** Consensus score: how aligned are sources (0-100) */
  consensus: number;
  /** Recommended hedge action */
  recommendation: 'STRONG_HEDGE_SHORT' | 'HEDGE_SHORT' | 'LIGHT_HEDGE_SHORT' | 'WAIT' | 'LIGHT_HEDGE_LONG' | 'HEDGE_LONG' | 'STRONG_HEDGE_LONG';
  /** Recommended hedge size multiplier (0.5-2.0) */
  sizeMultiplier: number;
  /** Individual source contributions */
  sources: PredictionSource[];
  /** Summary of reasoning */
  reasoning: string;
  /** When this aggregation was computed */
  timestamp: number;
}

// Cache TTL for aggregated predictions
const CACHE_KEY = 'prediction_aggregation';
const CACHE_TTL_MS = 20_000; // 20 seconds - balance freshness vs. API load

/**
 * In-memory OI history — one-tick-back per asset. Populated by
 * fetchBybitPositioning; consumed as delta% in getPerAssetPredictions.
 * Serverless-scoped (dies with the lambda), which is fine — after 20s
 * the cache warms up again.
 */
const OI_CACHE = new Map<string, number>();

import { CACHE_TAG_CRYPTOCOM_TICKER, CACHE_TAG_BLUEFIN_FUNDING } from './cache-tags';
// Re-export so anything that previously imported the tags from here keeps
// working; no importers today, kept for symmetry with the prior commit.
export { CACHE_TAG_CRYPTOCOM_TICKER, CACHE_TAG_BLUEFIN_FUNDING };

// ─── Service ─────────────────────────────────────────────────────────

export class PredictionAggregatorService {
  
  /**
   * Get aggregated prediction from all available sources
   * Uses caching to reduce API load
   */
  static async getAggregatedPrediction(): Promise<AggregatedPrediction> {
    // Check cache first
    const cached = cache.get<AggregatedPrediction>(CACHE_KEY);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached;
    }

    // Fetch from all sources in parallel
    const [
      polymarketSignal,
      delphiPredictions,
      cryptoComData,
    ] = await Promise.all([
      this.fetchPolymarketSignal(),
      this.fetchDelphiPredictions(),
      this.fetchCryptoComData(),
    ]);

    // Build source array
    const sources: PredictionSource[] = [];

    // 1. Polymarket 5-min signal (weight: 30% - real-time crowd wisdom)
    if (polymarketSignal) {
      sources.push({
        name: 'Polymarket 5-Min BTC',
        type: 'short_term',
        direction: polymarketSignal.direction,
        confidence: polymarketSignal.confidence,
        probability: polymarketSignal.direction === 'UP' 
          ? polymarketSignal.upProbability 
          : polymarketSignal.downProbability,
        weight: 0.30,
        rawData: polymarketSignal,
        fetchedAt: polymarketSignal.fetchedAt,
      });
    }

    // 2. Delphi/Crypto.com price momentum signals (weight: 25% each)
    for (const pred of delphiPredictions) {
      const isPositive = pred.probability > 50;
      sources.push({
        name: `Delphi: ${pred.question.substring(0, 40)}...`,
        type: pred.category === 'price' ? 'medium_term' : 'sentiment',
        direction: isPositive ? 'UP' : pred.probability < 45 ? 'DOWN' : 'NEUTRAL',
        confidence: pred.confidence,
        probability: pred.probability,
        weight: pred.impact === 'HIGH' ? 0.15 : pred.impact === 'MODERATE' ? 0.10 : 0.05,
        rawData: pred,
        fetchedAt: pred.lastUpdate,
      });
    }

    // 3. Crypto.com 24h data (weight: 20% - real market momentum)
    if (cryptoComData.btc) {
      const btcChange = cryptoComData.btc.change24h;
      const btcDirection: 'UP' | 'DOWN' | 'NEUTRAL' = 
        btcChange > 1 ? 'UP' : btcChange < -1 ? 'DOWN' : 'NEUTRAL';
      sources.push({
        name: 'Crypto.com BTC 24h',
        type: 'medium_term',
        direction: btcDirection,
        confidence: Math.min(50 + Math.abs(btcChange) * 10, 90),
        probability: btcChange > 0 ? 50 + Math.min(btcChange * 5, 30) : 50 + Math.max(btcChange * 5, -30),
        weight: 0.20,
        rawData: cryptoComData.btc,
        fetchedAt: Date.now(),
      });
    }

    // 4. ETH correlation signal (weight: 10%)
    if (cryptoComData.eth) {
      const ethChange = cryptoComData.eth.change24h;
      const ethDirection: 'UP' | 'DOWN' | 'NEUTRAL' = 
        ethChange > 1 ? 'UP' : ethChange < -1 ? 'DOWN' : 'NEUTRAL';
      sources.push({
        name: 'Crypto.com ETH 24h',
        type: 'medium_term',
        direction: ethDirection,
        confidence: Math.min(45 + Math.abs(ethChange) * 8, 85),
        probability: ethChange > 0 ? 50 + Math.min(ethChange * 4, 25) : 50 + Math.max(ethChange * 4, -25),
        weight: 0.10,
        rawData: cryptoComData.eth,
        fetchedAt: Date.now(),
      });
    }

    // 5. Funding rate approximation (weight: 10% - market sentiment proxy)
    const fundingSignal = this.approximateFundingRateSentiment(sources);
    if (fundingSignal) {
      sources.push(fundingSignal);
    }

    // Normalize weights
    const totalWeight = sources.reduce((sum, s) => sum + s.weight, 0);
    sources.forEach(s => { s.weight = s.weight / totalWeight; });

    // Calculate aggregated metrics
    const aggregation = this.calculateAggregation(sources);
    
    logger.info('[PredictionAggregator] Computed aggregated prediction', {
      direction: aggregation.direction,
      confidence: aggregation.confidence.toFixed(1),
      consensus: aggregation.consensus.toFixed(1),
      recommendation: aggregation.recommendation,
      sourceCount: sources.length,
    });

    // Cache result
    cache.set(CACHE_KEY, aggregation, CACHE_TTL_MS);
    
    return aggregation;
  }

  /**
   * Calculate weighted aggregation from all sources
   */
  private static calculateAggregation(sources: PredictionSource[]): AggregatedPrediction {
    if (sources.length === 0) {
      return {
        direction: 'NEUTRAL',
        confidence: 0,
        probability: 50,
        consensus: 0,
        recommendation: 'WAIT',
        sizeMultiplier: 1.0,
        sources: [],
        reasoning: 'No prediction data available',
        timestamp: Date.now(),
      };
    }

    // Calculate weighted direction score (-1 = DOWN, +1 = UP)
    let directionScore = 0;
    let totalConfidenceWeight = 0;
    let upCount = 0;
    let downCount = 0;

    for (const source of sources) {
      const dirValue = source.direction === 'UP' ? 1 : source.direction === 'DOWN' ? -1 : 0;
      const effectiveWeight = source.weight * (source.confidence / 100);
      directionScore += dirValue * effectiveWeight;
      totalConfidenceWeight += effectiveWeight;
      
      if (source.direction === 'UP') upCount++;
      else if (source.direction === 'DOWN') downCount++;
    }

    // Normalize direction score
    const normalizedDirection = totalConfidenceWeight > 0 
      ? directionScore / totalConfidenceWeight 
      : 0;

    // Determine overall direction
    const direction: 'UP' | 'DOWN' | 'NEUTRAL' =
      normalizedDirection > 0.15 ? 'UP' :
      normalizedDirection < -0.15 ? 'DOWN' : 'NEUTRAL';

    // Consensus = fraction of sources that AGREE with the chosen direction.
    // Previously computed as max(upCount, downCount) / total, which returned
    // majority-dominance regardless of whether that majority matched the
    // aggregate direction. That let the aggregator return direction=UP with
    // consensus=57% while the 57% majority actually pointed DOWN — the exact
    // root cause of the 22% paper-trader win rate diagnosed 2026-09-18.
    // Live snapshot: ETH aggregate=UP, sources 3 UP / 4 DOWN, old consensus
    // reported 57% (down-majority), new consensus reports 43% (up-agreement).
    // Downstream gates (PAPER_MIN_CONSENSUS, live trader effectiveCons) now
    // filter on the correct metric.
    const totalSources = sources.length;
    let agreeCount = 0;
    if (direction === 'UP') agreeCount = upCount;
    else if (direction === 'DOWN') agreeCount = downCount;
    // For NEUTRAL, consensus is 0 (no directional call to agree with).
    const consensus = totalSources > 0 && direction !== 'NEUTRAL'
      ? (agreeCount / totalSources) * 100
      : 0;

    // Calculate weighted confidence
    const weightedConfidence = sources.reduce((sum, s) => 
      sum + s.confidence * s.weight, 0);

    // Calculate weighted probability
    const weightedProbability = sources.reduce((sum, s) => 
      sum + s.probability * s.weight, 0);

    // Determine recommendation based on direction + confidence + consensus
    const recommendation = this.determineRecommendation(
      direction, 
      weightedConfidence, 
      consensus, 
      Math.abs(normalizedDirection)
    );

    // Calculate size multiplier (1.0 = normal, 0.5 = small, 2.0 = large)
    const sizeMultiplier = this.calculateSizeMultiplier(
      weightedConfidence, 
      consensus, 
      Math.abs(normalizedDirection)
    );

    // Build reasoning
    const reasoning = this.buildReasoning(sources, direction, consensus, recommendation);

    return {
      direction,
      confidence: weightedConfidence,
      probability: weightedProbability,
      consensus,
      recommendation,
      sizeMultiplier,
      sources,
      reasoning,
      timestamp: Date.now(),
    };
  }

  /**
   * Determine hedge recommendation
   */
  private static determineRecommendation(
    direction: 'UP' | 'DOWN' | 'NEUTRAL',
    confidence: number,
    consensus: number,
    directionStrength: number
  ): AggregatedPrediction['recommendation'] {
    return determineRecommendationPure(direction, confidence, consensus, directionStrength);
  }

  /**
   * Calculate position size multiplier
   */
  private static calculateSizeMultiplier(
    confidence: number,
    consensus: number,
    directionStrength: number
  ): number {
    return calculateSizeMultiplierPure(confidence, consensus, directionStrength);
  }

  /**
   * Build human-readable reasoning
   */
  private static buildReasoning(
    sources: PredictionSource[],
    direction: 'UP' | 'DOWN' | 'NEUTRAL',
    consensus: number,
    recommendation: AggregatedPrediction['recommendation']
  ): string {
    const parts: string[] = [];

    // Direction summary
    if (direction === 'NEUTRAL') {
      parts.push('Mixed signals from prediction markets - no clear direction.');
    } else {
      const upSources = sources.filter(s => s.direction === 'UP').map(s => s.name.split(':')[0]);
      const downSources = sources.filter(s => s.direction === 'DOWN').map(s => s.name.split(':')[0]);
      
      if (direction === 'DOWN') {
        parts.push(`Bearish signals from ${downSources.length} sources (${downSources.slice(0, 3).join(', ')}).`);
      } else {
        parts.push(`Bullish signals from ${upSources.length} sources (${upSources.slice(0, 3).join(', ')}).`);
      }
    }

    // Consensus
    if (consensus >= 75) {
      parts.push('High consensus among prediction sources.');
    } else if (consensus >= 50) {
      parts.push('Moderate consensus - some disagreement between sources.');
    } else {
      parts.push('Low consensus - sources are divergent.');
    }

    // Recommendation explanation
    if (recommendation.includes('STRONG')) {
      parts.push('Strong hedge recommended due to aligned high-confidence signals.');
    } else if (recommendation === 'WAIT') {
      parts.push('Recommend waiting - signals are too weak or mixed.');
    }

    return parts.join(' ');
  }

  // ─── Data Fetchers ─────────────────────────────────────────────────

  private static async fetchPolymarketSignal(): Promise<FiveMinBTCSignal | null> {
    try {
      const { Polymarket5MinService } = await import('./Polymarket5MinService');
      return await Polymarket5MinService.getLatest5MinSignal();
    } catch (error) {
      logger.debug('[PredictionAggregator] Polymarket fetch failed', { error });
      return null;
    }
  }

  private static async fetchDelphiPredictions(): Promise<PredictionMarket[]> {
    try {
      const { DelphiMarketService } = await import('./DelphiMarketService');
      const { resolveAgentUniverse } = await import('@/lib/config/agent-universe');
      const assets = await resolveAgentUniverse();
      const predictions = await DelphiMarketService.getRelevantMarkets(assets);
      // Only return high-impact predictions
      return predictions.filter(p => p.impact === 'HIGH' || p.impact === 'MODERATE').slice(0, 5);
    } catch (error) {
      logger.debug('[PredictionAggregator] Delphi fetch failed', { error });
      return [];
    }
  }

  private static async fetchCryptoComData(assets: string[] = ['BTC', 'ETH']): Promise<{
    btc: { price: number; change24h: number; volume: number } | null;
    eth: { price: number; change24h: number; volume: number } | null;
    perAsset: Record<string, { price: number; change24h: number; volume: number }>;
  }> {
    try {
      // Next.js data cache: 30s revalidate + tag for on-demand invalidation.
      // Ticker is public + moves slowly enough at 30s cadence; caching across
      // Vercel instances significantly reduces external API load when
      // trader (5min) + autohedge (30min) crons both call this hot.
      const response = await fetch('https://api.crypto.com/exchange/v1/public/get-tickers', {
        signal: AbortSignal.timeout(5000),
        next: { revalidate: 30, tags: [CACHE_TAG_CRYPTOCOM_TICKER] },
      });

      if (!response.ok) throw new Error('Crypto.com API unavailable');

      const data = await response.json();
      const tickers: Array<Record<string, string>> = data.result?.data || [];

      // Build a per-asset map. Crypto.com instrument names are SYMBOL_USDT.
      const perAsset: Record<string, { price: number; change24h: number; volume: number }> = {};
      const tickerMap: Record<string, Record<string, string>> = {};
      for (const t of tickers) tickerMap[String(t.i || '')] = t;

      for (const rawAsset of assets) {
        const asset = rawAsset.toUpperCase();
        const t = tickerMap[`${asset}_USDT`];
        if (!t) continue;
        // Use bid+ask MID for drift tracking. `t.a` (ask) alone goes stale
        // between updates on quiet pairs — multiple consecutive fetches
        // return the identical ask even when bid moved, producing
        // zero-delta drift samples. Midpoint averages both sides so any
        // real book movement registers.
        const ask = parseFloat(t.a || '0');
        const bid = parseFloat(t.b || '0');
        const price = (ask > 0 && bid > 0) ? (ask + bid) / 2 : (ask || bid);
        if (!Number.isFinite(price) || price <= 0) continue;
        perAsset[asset] = {
          price,
          change24h: parseFloat(t.c || '0') * 100,
          volume: parseFloat(t.v || '0') * (ask || price),
        };
      }

      const btcTicker = tickerMap['BTC_USDT'];
      const ethTicker = tickerMap['ETH_USDT'];

      return {
        btc: btcTicker ? {
          price: parseFloat(btcTicker.a || '0'),
          change24h: parseFloat(btcTicker.c || '0') * 100,
          volume: parseFloat(btcTicker.v || '0') * parseFloat(btcTicker.a || '0'),
        } : null,
        eth: ethTicker ? {
          price: parseFloat(ethTicker.a || '0'),
          change24h: parseFloat(ethTicker.c || '0') * 100,
          volume: parseFloat(ethTicker.v || '0') * parseFloat(ethTicker.a || '0'),
        } : null,
        perAsset,
      };
    } catch (error) {
      logger.debug('[PredictionAggregator] Crypto.com fetch failed', { error });
      return { btc: null, eth: null, perAsset: {} };
    }
  }

  /**
   * Binance perpetual funding + long/short account ratio.
   *
   * Added 2026-09-19 to diversify beyond BlueFin (much smaller
   * volume) for retail-positioning signal. Both are contrarian:
   *   - funding > +0.03% per 8h (~30% APR) → longs crowded → SHORT
   *   - long/short ratio > 1.5 or < 0.67 → extreme retail positioning
   *
   * Endpoints are public + free. Returns sparse map on any error.
   */
  private static async fetchBinancePositioning(
    assets: string[],
  ): Promise<Record<string, { funding: number; longShortRatio: number }>> {
    const out: Record<string, { funding: number; longShortRatio: number }> = {};
    const symbolFor = (asset: string) => `${asset.toUpperCase()}USDT`;
    await Promise.all(
      assets.map(async (rawAsset) => {
        const asset = rawAsset.toUpperCase();
        const symbol = symbolFor(asset);
        try {
          const [premiumResp, ratioResp] = await Promise.all([
            fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {
              signal: AbortSignal.timeout(4000),
              next: { revalidate: 60 },
            }).catch(() => null),
            fetch(
              `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`,
              { signal: AbortSignal.timeout(4000), next: { revalidate: 300 } },
            ).catch(() => null),
          ]);
          if (!premiumResp?.ok || !ratioResp?.ok) return;
          const premiumJson = (await premiumResp.json()) as { lastFundingRate?: string };
          const ratioJson = (await ratioResp.json()) as Array<{ longShortRatio?: string }>;
          const funding = parseFloat(premiumJson.lastFundingRate ?? '');
          const ratio = parseFloat(ratioJson[0]?.longShortRatio ?? '');
          if (Number.isFinite(funding) && Number.isFinite(ratio) && ratio > 0) {
            out[asset] = { funding, longShortRatio: ratio };
          }
        } catch (e) {
          logger.debug('[PredictionAggregator] Binance fetch failed', {
            asset, error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
    return out;
  }

  /**
   * Bybit perpetual funding rate + open interest.
   *
   * Added 2026-09-19 to give SOL/XRP/DOGE the same signal richness as
   * BTC/ETH. Bybit has deep liquidity in the small-caps (XRP OI ~$212M,
   * DOGE OI ~$1.5B) so their funding + OI are meaningful retail-
   * positioning signals for those assets specifically.
   *
   * OI change (delta from prior fetch) is the interesting signal:
   *   - OI RISING with price → new longs entering → potential top
   *   - OI FALLING with stable price → shorts closing → bullish
   *   - OI FALLING with dropping price → longs capitulating → bottom
   */
  private static async fetchBybitPositioning(
    assets: string[],
  ): Promise<Record<string, { funding: number; openInterest: number }>> {
    const out: Record<string, { funding: number; openInterest: number }> = {};
    const symbolFor = (asset: string) => `${asset.toUpperCase()}USDT`;
    await Promise.all(
      assets.map(async (rawAsset) => {
        const asset = rawAsset.toUpperCase();
        const symbol = symbolFor(asset);
        try {
          const resp = await fetch(
            `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
            { signal: AbortSignal.timeout(4000), next: { revalidate: 60 } },
          ).catch(() => null);
          if (!resp?.ok) return;
          const json = (await resp.json()) as {
            result?: { list?: Array<{ fundingRate?: string; openInterest?: string }> };
          };
          const t = json.result?.list?.[0];
          if (!t) return;
          const funding = parseFloat(t.fundingRate ?? '');
          const oi = parseFloat(t.openInterest ?? '');
          if (Number.isFinite(funding) && Number.isFinite(oi) && oi > 0) {
            out[asset] = { funding, openInterest: oi };
          }
        } catch (e) {
          logger.debug('[PredictionAggregator] Bybit fetch failed', {
            asset, error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
    return out;
  }

  /**
   * Fetch the LIVE funding rate per asset from Bluefin's market ticker.
   * Decimal per 8-hour funding interval (e.g. 0.0001 ≈ 11% APR).
   * Returns a sparse map — assets with no data are simply omitted.
   *
   * Uses a public, unsigned ticker endpoint so this works without the
   * Bluefin admin key being initialized in this service.
   */
  private static async fetchBluefinFundingRates(
    assets: string[],
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const network = (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet'
      ? 'testnet' : 'mainnet';
    // Exchange API base (matches BluefinService.NETWORK_CONFIG).
    const base = network === 'mainnet'
      ? 'https://api.sui-prod.bluefin.io'
      : 'https://api.sui-staging.bluefin.io';
    await Promise.all(assets.map(async (rawAsset) => {
      const asset = rawAsset.toUpperCase();
      const symbol = `${asset}-PERP`;
      try {
        // Funding rate ticker: 60s revalidate. BlueFin updates funding
        // every ~1min; more frequent fetches waste requests + risk rate limits.
        const res = await fetch(
          `${base}/v1/exchange/ticker?symbol=${encodeURIComponent(symbol)}`,
          {
            signal: AbortSignal.timeout(4000),
            next: { revalidate: 60, tags: [CACHE_TAG_BLUEFIN_FUNDING] },
          },
        );
        if (!res.ok) return;
        const data = await res.json() as {
          lastFundingRateE9?: string;
          fundingRate?: string;
        };
        let fr = NaN;
        if (data?.lastFundingRateE9) fr = parseFloat(data.lastFundingRateE9) / 1e9;
        else if (data?.fundingRate) fr = parseFloat(data.fundingRate);
        if (Number.isFinite(fr)) out[asset] = fr;
      } catch (e) {
        logger.debug(`[PredictionAggregator] Bluefin funding fetch failed for ${symbol}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }));
    return out;
  }

  /**
   * Approximate funding rate sentiment from existing signals
   * In a real system, this would fetch from perpetual exchanges
   */
  private static approximateFundingRateSentiment(
    existingSources: PredictionSource[]
  ): PredictionSource | null {
    if (existingSources.length < 2) return null;

    // Average direction from short-term sources
    const shortTermSources = existingSources.filter(s => s.type === 'short_term');
    if (shortTermSources.length === 0) return null;

    const avgDirection = shortTermSources.reduce((sum, s) => {
      return sum + (s.direction === 'UP' ? 1 : s.direction === 'DOWN' ? -1 : 0);
    }, 0) / shortTermSources.length;

    // Strong bullish sentiment = likely positive funding (shorts pay longs)
    // Strong bearish sentiment = likely negative funding (longs pay shorts)
    const direction: 'UP' | 'DOWN' | 'NEUTRAL' = 
      avgDirection > 0.3 ? 'UP' : avgDirection < -0.3 ? 'DOWN' : 'NEUTRAL';

    return {
      name: 'Funding Rate Proxy',
      type: 'on_chain',
      direction,
      confidence: 50 + Math.abs(avgDirection) * 30,
      probability: 50 + avgDirection * 25,
      weight: 0.10,
      rawData: { avgDirection, sourceCount: shortTermSources.length },
      fetchedAt: Date.now(),
    };
  }

  // ─── Multi-asset scanning ────────────────────────────────────────
  //
  // Instead of producing a single monolithic signal, scan all relevant
  // Polymarket / Delphi / Crypto.com data sources and bucket evidence
  // PER ASSET. The cron / orchestrator can then pick the asset with the
  // strongest, most-aligned signal — turning the trader from "one BTC
  // bet at a time" into a multi-market scout that selects the best edge
  // across BTC, ETH (and any future asset we wire in).

  /**
   * Compute an aggregated prediction independently for each requested asset.
   * Each asset gets its own source list (Polymarket 5-min only feeds BTC;
   * Delphi predictions are routed by `relatedAssets`; Crypto.com 24h ticker
   * routes to the matching bucket).
   */
  static async getPerAssetPredictions(
    assets: string[] = ['BTC', 'ETH'],
  ): Promise<Record<string, AggregatedPrediction>> {
    const cacheKey = `prediction_per_asset:${assets.slice().sort().join(',')}`;
    const cached = cache.get<Record<string, AggregatedPrediction>>(cacheKey);
    if (cached) {
      const fresh = Object.values(cached).every(
        (p) => Date.now() - p.timestamp < CACHE_TTL_MS,
      );
      if (fresh) return cached;
    }

    // Fetch per-asset 5-min binaries via MultiAssetSignalService (not just
    // BTC) so the synthetic-STRONG fusion has cross-asset data to work
    // with, plus Manifold for source diversity.
    //
    // Alignment universe vs return universe:
    //   - We compute cross-asset ALIGNMENT over the full tracked universe
    //     (BTC, ETH, SOL, XRP, DOGE by default) — even when the caller only
    //     wants per-asset predictions for BTC + ETH. Otherwise a SUI-pool-
    //     style 2-asset call would only have 2 alignment voters and fail
    //     the ≥3 minimum gate, killing synthetic STRONG even on perfectly
    //     clear 5/5 universe agreement.
    //   - We still only RETURN per-asset predictions for the requested
    //     assets — alignment is a side-input, not output.
    const upperAssets = assets.map(a => a.toUpperCase());
    const { getTrackedAssetList } = await import('./MultiAssetSignalService');
    const alignmentUniverse = Array.from(new Set([...getTrackedAssetList(), ...upperAssets]));
    const [polymarketSignal, delphiPredictions, cryptoComData, fundingRates, multiAssetSignals, manifoldMarkets, binancePositioning, bybitPositioning] = await Promise.all([
      this.fetchPolymarketSignal(),
      this.fetchDelphiPredictions(),
      this.fetchCryptoComData(upperAssets),
      this.fetchBluefinFundingRates(assets),
      MultiAssetSignalService.getLatestSignals(alignmentUniverse).catch(() => ({} as Record<string, MultiAssetSignal | null>)),
      ManifoldMarketService.getCryptoMarkets(upperAssets).catch(() => [] as PredictionMarket[]),
      this.fetchBinancePositioning(upperAssets).catch(() => ({} as Record<string, { funding: number; longShortRatio: number }>)),
      this.fetchBybitPositioning(upperAssets).catch(() => ({} as Record<string, { funding: number; openInterest: number }>)),
    ]);

    // Track OI delta from previous fetch to compute change %.
    // Rising OI + rising price = new leveraged longs entering (crowded top signal).
    // Rising OI + falling price = new shorts entering (crowded bottom).
    // Falling OI = positions unwinding (calm signal, no crowd).
    const oiDeltas: Record<string, number> = {};
    for (const [asset, data] of Object.entries(bybitPositioning)) {
      const prev = OI_CACHE.get(asset);
      if (prev !== undefined && prev > 0) {
        oiDeltas[asset] = (data.openInterest - prev) / prev;
      }
      OI_CACHE.set(asset, data.openInterest);
    }

    // Feed real spot prices into the drift fusion's price-history channel.
    // This is the source the price-momentum drift component reads — it
    // lets synthetic STRONG fire on quiet-Polymarket days when binaries
    // are stuck at 50/50 but spot prices are still moving directionally.
    const nowTs = Date.now();
    for (const [asset, t] of Object.entries(cryptoComData.perAsset)) {
      if (t && t.price > 0) {
        SignalDriftFusion.recordPriceTick(asset, t.price, nowTs);
      }
    }

    // Run drift-fusion over the multi-asset signal map. Returns per-asset
    // upgrade decisions: where alignment + (prob-drift OR price-drift) +
    // funding line up, the asset's WEAK/MODERATE signal is treated as STRONG.
    const fusionResult = SignalDriftFusion.fuseAll(multiAssetSignals, fundingRates);

    const out: Record<string, AggregatedPrediction> = {};

    for (const asset of upperAssets) {
      const sources: PredictionSource[] = [];

      // 1a) Per-asset Polymarket 5-min binary (was BTC-only before — this
      //     is the main signal-density unlock).
      const assetSignal = multiAssetSignals[asset];
      const upgrade: FusionUpgrade | undefined = fusionResult.upgrades[asset];
      if (assetSignal) {
        const effectiveConfidence = upgrade?.upgradedToStrong
          ? upgrade.syntheticConfidence
          : assetSignal.confidence;
        sources.push({
          name: upgrade?.upgradedToStrong
            ? `Polymarket 5-Min ${asset} (synthetic STRONG)`
            : `Polymarket 5-Min ${asset}`,
          type: 'short_term',
          direction: assetSignal.direction,
          confidence: effectiveConfidence,
          probability:
            assetSignal.direction === 'UP'
              ? assetSignal.upProbability
              : assetSignal.downProbability,
          weight: upgrade?.upgradedToStrong ? 0.35 : 0.25,
          rawData: { ...assetSignal, fusionUpgrade: upgrade },
          fetchedAt: assetSignal.fetchedAt,
        });
      }

      // 1b) BTC-specific Polymarket5MinService signal (legacy ticker) —
      //     only kept for BTC since RiskAgent/HedgingAgent already subscribe
      //     to it. Lower weight since (1a) covers the same signal now.
      if (asset === 'BTC' && polymarketSignal) {
        sources.push({
          name: 'Polymarket 5-Min BTC (ticker)',
          type: 'short_term',
          direction: polymarketSignal.direction,
          confidence: polymarketSignal.confidence,
          probability:
            polymarketSignal.direction === 'UP'
              ? polymarketSignal.upProbability
              : polymarketSignal.downProbability,
          weight: 0.10,
          rawData: polymarketSignal,
          fetchedAt: polymarketSignal.fetchedAt,
        });
      }

      // 2) Delphi/Polymarket markets that tag this asset
      const assetDelphi = delphiPredictions.filter((p) =>
        (p.relatedAssets || []).map((a) => a.toUpperCase()).includes(asset),
      );
      for (const pred of assetDelphi) {
        const isPositive = pred.probability > 50;
        sources.push({
          name: `Delphi: ${pred.question.substring(0, 40)}...`,
          type: pred.category === 'price' ? 'medium_term' : 'sentiment',
          direction: isPositive ? 'UP' : pred.probability < 45 ? 'DOWN' : 'NEUTRAL',
          confidence: pred.confidence,
          probability: pred.probability,
          weight:
            pred.impact === 'HIGH' ? 0.15 : pred.impact === 'MODERATE' ? 0.10 : 0.05,
          rawData: pred,
          fetchedAt: pred.lastUpdate,
        });
      }

      // 2b) Manifold markets that tag this asset — different bettor base
      //     than Polymarket, picks up markets the others miss. Weight kept
      //     modest until we calibrate Manifold's signal accuracy.
      const assetManifold = manifoldMarkets.filter((p) =>
        (p.relatedAssets || []).map((a) => a.toUpperCase()).includes(asset),
      );
      for (const pred of assetManifold.slice(0, 3)) {
        const isPositive = pred.probability > 50;
        sources.push({
          name: `Manifold: ${pred.question.substring(0, 40)}...`,
          type: 'medium_term',
          direction: isPositive ? 'UP' : pred.probability < 45 ? 'DOWN' : 'NEUTRAL',
          confidence: pred.confidence,
          probability: pred.probability,
          weight: pred.impact === 'HIGH' ? 0.10 : pred.impact === 'MODERATE' ? 0.07 : 0.04,
          rawData: pred,
          fetchedAt: pred.lastUpdate,
        });
      }

      // 3) Crypto.com 24h ticker for this asset
      const ticker =
        asset === 'BTC' ? cryptoComData.btc : asset === 'ETH' ? cryptoComData.eth : null;
      if (ticker) {
        const change = ticker.change24h;
        const dir: 'UP' | 'DOWN' | 'NEUTRAL' =
          change > 1 ? 'UP' : change < -1 ? 'DOWN' : 'NEUTRAL';
        sources.push({
          name: `Crypto.com ${asset} 24h`,
          type: 'medium_term',
          direction: dir,
          confidence: Math.min(50 + Math.abs(change) * 10, 90),
          probability:
            change > 0
              ? 50 + Math.min(change * 5, 30)
              : 50 + Math.max(change * 5, -30),
          weight: 0.20,
          rawData: ticker,
          fetchedAt: Date.now(),
        });
      }

      // 4) REAL Bluefin funding rate for this asset (decimal per 8h).
      //    Positive funding = longs pay shorts → market crowd is long-biased
      //    → contrarian SHORT signal with strength scaled by magnitude.
      const fundingRate = fundingRates[asset];
      if (fundingRate !== undefined && Number.isFinite(fundingRate)) {
        const magnitude = Math.abs(fundingRate);
        // 0.0001/8h ≈ 11% APR. Treat 0.0001 as the "MODERATE" boundary.
        if (magnitude > 0.00002) {
          // Funding > 0 → longs pay → expect mean-reversion DOWN.
          // Funding < 0 → shorts pay → expect mean-reversion UP.
          const fundingDir: 'UP' | 'DOWN' = fundingRate > 0 ? 'DOWN' : 'UP';
          const fundingConfidence = Math.min(40 + magnitude * 200_000, 90);
          sources.push({
            name: `Bluefin ${asset} Funding`,
            type: 'on_chain',
            direction: fundingDir,
            confidence: fundingConfidence,
            probability: 50 + Math.min(magnitude * 100_000, 30) * (fundingDir === 'UP' ? 1 : -1),
            weight: 0.20,
            rawData: { fundingRate, perfectAprPct: magnitude * 3 * 365 * 100 },
            fetchedAt: Date.now(),
          });
        }
      }

      // 5) Funding-rate proxy from this asset's short-term sources (kept as
      //    a low-weight backstop for assets with no live Bluefin funding).
      if (fundingRate === undefined) {
        const funding = this.approximateFundingRateSentiment(sources);
        if (funding) sources.push(funding);
      }

      // 5c) Kalshi ATM-strike direction (2026-09-19). Different user
      //     base than Polymarket (US institutional + retail). Binary
      //     "BTC above $X at time T" markets — we infer direction from
      //     where the ATM strike sits vs spot. Only BTC + ETH have
      //     active Kalshi crypto markets.
      if (asset === 'BTC' || asset === 'ETH') {
        const spotForKalshi = cryptoComData.perAsset?.[asset]?.price ?? 0;
        if (spotForKalshi > 0) {
          const { getKalshiSignal } = await import('./KalshiMarketService');
          const kalshi = await getKalshiSignal(asset, spotForKalshi);
          if (kalshi && kalshi.direction !== 'NEUTRAL') {
            sources.push({
              name: `Kalshi ${asset}`,
              type: 'short_term',
              direction: kalshi.direction,
              confidence: kalshi.confidence,
              probability: 50 + kalshi.impliedMovePct * 5000, // ~0.6% implied move → probability 80
              weight: 0.15,
              rawData: {
                atmStrike: kalshi.atmStrike,
                spotPrice: kalshi.spotPrice,
                impliedMovePct: kalshi.impliedMovePct,
                marketCount: kalshi.marketCount,
              },
              fetchedAt: Date.now(),
            });
          }
        }
      }

      // 5d) Bybit funding + OI change (2026-09-19). Covers ALL 5
      //     assets (BTC/ETH/SOL/XRP/DOGE). Bybit is the #1 venue for
      //     small-cap crypto perps, so signals here are the STRONGEST
      //     retail-positioning read for SOL/XRP/DOGE.
      const bybit = bybitPositioning[asset];
      if (bybit) {
        // Funding (contrarian, same shape as Binance).
        if (Math.abs(bybit.funding) > 0.00005) {
          const fundingDir: 'UP' | 'DOWN' = bybit.funding > 0 ? 'DOWN' : 'UP';
          const conf = Math.min(40 + Math.abs(bybit.funding) * 200_000, 85);
          sources.push({
            name: `Bybit ${asset} Funding`,
            type: 'on_chain',
            direction: fundingDir,
            confidence: conf,
            probability: 50 + Math.min(Math.abs(bybit.funding) * 100_000, 25) * (fundingDir === 'UP' ? 1 : -1),
            weight: 0.12,
            rawData: { funding: bybit.funding, aprPct: bybit.funding * 3 * 365 * 100 },
            fetchedAt: Date.now(),
          });
        }

        // OI delta — new positions entering means fresh leverage in the
        // market. Rising OI is often a top signal (crowded longs
        // entering); falling OI a bottom signal (weak hands out).
        // Only fire when |delta| > 2% (below is noise).
        const oiDelta = oiDeltas[asset];
        if (oiDelta !== undefined && Math.abs(oiDelta) > 0.02) {
          const priceMomentum = cryptoComData.perAsset?.[asset]?.change24h ?? 0;
          // OI rising + price rising = crowded LONG → SHORT signal.
          // OI rising + price falling = crowded SHORT → LONG signal.
          // OI falling = capitulation, weak signal in direction of price.
          const oiRising = oiDelta > 0;
          const priceRising = priceMomentum > 0;
          let oiDir: 'UP' | 'DOWN' | null = null;
          if (oiRising) {
            oiDir = priceRising ? 'DOWN' : 'UP'; // contrarian
          } else {
            // Falling OI — weak signal, only use if the price is also
            // moving decisively (>1% change).
            if (Math.abs(priceMomentum) > 1) {
              oiDir = priceRising ? 'UP' : 'DOWN'; // aligned
            }
          }
          if (oiDir) {
            const conf = Math.min(35 + Math.abs(oiDelta) * 500, 70);
            sources.push({
              name: `Bybit ${asset} OI Change`,
              type: 'on_chain',
              direction: oiDir,
              confidence: conf,
              probability: 50 + Math.min(Math.abs(oiDelta) * 200, 25) * (oiDir === 'UP' ? 1 : -1),
              weight: 0.10,
              rawData: { oiDelta, priceMomentum, oiRising },
              fetchedAt: Date.now(),
            });
          }
        }
      }

      // 5b) Binance retail positioning (2026-09-19). BlueFin funding
      //     covers our own venue's short list; Binance is the biggest
      //     retail-crowded proxy and often shows more extreme readings.
      //     Both contrarian: crowded longs → SHORT signal.
      const binance = binancePositioning[asset];
      if (binance) {
        // Funding rate (per 8h). >0.03% ≈ >30% APR is "crowded". Signal is
        // contrarian: positive funding → longs paying → expect DOWN.
        if (Math.abs(binance.funding) > 0.00005) {
          const fundingDir: 'UP' | 'DOWN' = binance.funding > 0 ? 'DOWN' : 'UP';
          const conf = Math.min(40 + Math.abs(binance.funding) * 200_000, 85);
          sources.push({
            name: `Binance ${asset} Funding`,
            type: 'on_chain',
            direction: fundingDir,
            confidence: conf,
            probability: 50 + Math.min(Math.abs(binance.funding) * 100_000, 25) * (fundingDir === 'UP' ? 1 : -1),
            weight: 0.12,
            rawData: { funding: binance.funding, aprPct: binance.funding * 3 * 365 * 100 },
            fetchedAt: Date.now(),
          });
        }

        // Long/short account ratio. Extreme (>1.5 or <0.67) = crowded retail;
        // contrarian setup. Middle range (0.67-1.5) is uninformative noise.
        const lsr = binance.longShortRatio;
        if (lsr > 1.5 || lsr < 0.67) {
          const crowdedLong = lsr > 1.5;
          const contrarianDir: 'UP' | 'DOWN' = crowdedLong ? 'DOWN' : 'UP';
          // Confidence scales with distance from neutral (1.0). At ratio 2.0
          // or 0.5, we're at extreme conviction; at boundaries (1.5 / 0.67),
          // moderate.
          const deviation = crowdedLong ? lsr - 1.5 : 0.67 - lsr;
          const conf = Math.min(45 + deviation * 60, 80);
          sources.push({
            name: `Binance ${asset} Long/Short`,
            type: 'on_chain',
            direction: contrarianDir,
            confidence: conf,
            probability: 50 + Math.min(deviation * 30, 25) * (contrarianDir === 'UP' ? 1 : -1),
            weight: 0.10,
            rawData: { longShortRatio: lsr, crowdedLong },
            fetchedAt: Date.now(),
          });
        }
      }

      // 6) Cross-asset alignment as its own source. When 3+ assets agree on
      //    direction with ≥67% dominance, that's directional information
      //    independent of any single asset's signal — and the strongest
      //    way to surface signal on quiet days when individual markets
      //    are all flat-ish.
      const alignment = fusionResult.alignment;
      if (
        alignment.totalAssets >= 3
        && alignment.dominancePct >= 67
        && alignment.dominantDirection !== 'NEUTRAL'
        && alignment.dominantDirection === assetSignal?.direction
      ) {
        sources.push({
          name: `Cross-asset alignment (${alignment.upCount}UP/${alignment.downCount}DOWN/${alignment.neutralCount}~)`,
          type: 'sentiment',
          direction: alignment.dominantDirection,
          confidence: Math.min(90, 40 + (alignment.dominancePct - 67) * 1.5 + alignment.meanConfidence * 0.3),
          probability: 50 + (alignment.dominancePct - 50) * (alignment.dominantDirection === 'UP' ? 1 : -1) * 0.5,
          weight: 0.15,
          rawData: alignment,
          fetchedAt: Date.now(),
        });
      }

      // Apply learned per-source weight multipliers BEFORE the final
      // normalization step. When a source has no calibration history the
      // multiplier is 1.0 (identity), so this is safe to enable pre-data.
      // The paper-trader (chain='hedera-testnet') feeds this calibrator
      // from every closed trade — real trader benefits from the learned
      // weights without needing its own recording path.
      try {
        const { applyCalibrationToSources } = await import('@/lib/services/ai/source-calibrator');
        const calibrated = await applyCalibrationToSources(sources);
        // applyCalibrationToSources returns fresh objects with re-normalized
        // weights already; swap the reference for downstream aggregation.
        sources.length = 0;
        sources.push(...calibrated);
      } catch (calErr) {
        // Non-fatal: fall through with hand-coded weights + local normalize.
        const total = sources.reduce((sum, s) => sum + s.weight, 0);
        if (total > 0) {
          for (const s of sources) s.weight = s.weight / total;
        }
        logger.debug('[PredictionAggregator] source calibration skipped', {
          error: calErr instanceof Error ? calErr.message : String(calErr),
        });
      }

      out[asset] = this.calculateAggregation(sources);
    }

    cache.set(cacheKey, out, CACHE_TTL_MS);

    logger.info('[PredictionAggregator] Computed per-asset predictions', {
      assets,
      summary: Object.fromEntries(
        Object.entries(out).map(([a, p]) => [
          a,
          `${p.recommendation} conf=${p.confidence.toFixed(0)} cons=${p.consensus.toFixed(0)} src=${p.sources.length}`,
        ]),
      ),
    });

    return out;
  }

  /**
   * Score how attractive a per-asset prediction is for trading.
   * Higher = better edge. Returns 0 when not actionable.
   */
  static scoreOpportunity(p: AggregatedPrediction): number {
    return scoreTradeOpportunity({
      recommendation: p.recommendation,
      confidence: p.confidence,
      consensus: p.consensus,
      sourceCount: p.sources.length,
    });
  }

  /**
   * Scan multiple assets and return the highest-scoring opportunity that
   * passes the supplied gates. Returns `{ best: null, all }` when nothing
   * qualifies.
   */
  static async scanAndPickBest(
    assets: string[] = ['BTC', 'ETH'],
    gates: { minConfidence?: number; minConsensus?: number; minSources?: number } = {},
  ): Promise<{
    best: { asset: string; prediction: AggregatedPrediction; score: number } | null;
    all: Record<string, AggregatedPrediction>;
  }> {
    const minConfidence = gates.minConfidence ?? 60;
    const minConsensus = gates.minConsensus ?? 60;
    const minSources = gates.minSources ?? 2;

    const all = await this.getPerAssetPredictions(assets);

    let best: { asset: string; prediction: AggregatedPrediction; score: number } | null =
      null;

    for (const [asset, prediction] of Object.entries(all)) {
      const score = this.scoreOpportunity(prediction);
      if (score <= 0) continue;
      if (prediction.confidence < minConfidence) continue;
      if (prediction.consensus < minConsensus) continue;
      if (prediction.sources.length < minSources) continue;
      if (!best || score > best.score) {
        best = { asset, prediction, score };
      }
    }

    if (best) {
      logger.info('[PredictionAggregator] Best opportunity selected', {
        asset: best.asset,
        score: best.score.toFixed(1),
        recommendation: best.prediction.recommendation,
        confidence: best.prediction.confidence.toFixed(0),
        consensus: best.prediction.consensus.toFixed(0),
        sources: best.prediction.sources.length,
      });
    }

    return { best, all };
  }
}

// Export singleton getter
export function getPredictionAggregator(): typeof PredictionAggregatorService {
  return PredictionAggregatorService;
}
