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
import { scoreTradeOpportunity } from '@/lib/services/market-data/opportunity-scoring';
import type { PredictionMarket } from './DelphiMarketService';
import type { MultiAssetSignal } from './MultiAssetSignalService';
import { MultiAssetSignalService } from './MultiAssetSignalService';
import { ManifoldMarketService } from './ManifoldMarketService';
import { SignalDriftFusion, type FusionUpgrade } from './SignalDriftFusion';
import {
  fetchOrderbookImbalanceBatch,
  type OrderbookImbalance,
} from './OrderbookImbalanceService';
import {
  fetchOptionsSkewBatch,
  type OptionsSkew,
} from './OptionsSkewService';
import {
  fetchBroadCryptoMarkets,
  type BroadMarket,
  type BroadHorizon,
} from './PolymarketBroadMarketsService';
import {
  computeMomentum,
  detectThemes,
  type MarketSnapshot,
  type MarketMomentum,
  type ThemeCluster,
} from './PolymarketMomentumService';
import { getCronStateOr } from '@/lib/db/cron-state';
import { query as dbQuery } from '@/lib/db/postgres';
import {
  fetchPolymarketSignal,
  fetchDelphiPredictions,
  fetchCryptoComData,
  fetchBinancePositioning,
  fetchBybitPositioning,
  fetchBluefinFundingRates,
  approximateFundingRateSentiment,
} from './aggregator-fetchers';
import { calculateAggregation, crowdedFundingDirection } from './aggregator-math';
import { marketImpliedDirection } from './market-implied';
import { LEDGER_WEIGHT_HORIZON_MIN } from './ledger-cells';

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
    const rawCacheKey = PredictionAggregatorService.rawSourcesCacheKey(assets);
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
    // Options skew: Deribit series only exist for BTC + ETH.
    const optionsAssets = upperAssets.filter((a): a is 'BTC' | 'ETH' => a === 'BTC' || a === 'ETH');
    const [polymarketSignal, delphiPredictions, cryptoComData, fundingRates, multiAssetSignals, manifoldMarkets, binancePositioning, bybitPositioning, broadMarkets, orderbookImbalance, optionsSkew] = await Promise.all([
      fetchPolymarketSignal(),
      fetchDelphiPredictions(),
      fetchCryptoComData(upperAssets),
      fetchBluefinFundingRates(assets),
      MultiAssetSignalService.getLatestSignals(alignmentUniverse).catch(() => ({} as Record<string, MultiAssetSignal | null>)),
      ManifoldMarketService.getCryptoMarkets(upperAssets).catch(() => [] as PredictionMarket[]),
      fetchBinancePositioning(upperAssets).catch(() => ({} as Record<string, { funding: number }>)),
      fetchBybitPositioning(upperAssets).catch(() => ({} as Record<string, { funding: number; openInterest: number }>)),
      fetchBroadCryptoMarkets({}).catch(() => [] as BroadMarket[]),
      // NEW 2026-09-23: orderbook microstructure — top-20 L2 depth imbalance
      // from Binance perp. Independent short-term signal beyond prediction
      // markets. Free public endpoint, 30s cache. Fail-open.
      fetchOrderbookImbalanceBatch(upperAssets).catch(() => ({} as Record<string, OrderbookImbalance>)),
      // NEW 2026-09-23: options-market skew — 25-delta risk reversal from
      // Deribit (BTC + ETH only). Positive = calls > puts IV (bullish).
      // Options positioning leads spot; smart money paying up for upside.
      fetchOptionsSkewBatch(optionsAssets).catch(() => ({} as Record<string, OptionsSkew>)),
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

    // Pre-loop: theme clusters + AI interpretations. Both are all-asset
    // queries done once per aggregator call rather than per-asset in the
    // loop below — saves N-1 duplicate reads.
    //
    // Theme clusters: detectThemes() groups the broad markets by keyword
    // theme (etf-approval, fed-rates, regulation, etc.). A theme with 3+
    // markets pointing bearish for BTC is a stronger meta-signal than any
    // single market. Applied per-asset via the theme's `affects` list.
    //
    // A market's direction is what its odds imply against spot
    // (market-implied.ts), never "YES is likely": a likely "hack" is not
    // bullish and a ladder of far strikes is not a forecast. Markets that
    // imply no move are NEUTRAL, so 3b skips them and themes don't count them.
    const spotOf = (m: BroadMarket) => cryptoComData.perAsset[m.assets[0]]?.price;
    const impliedBroad: BroadMarket[] = broadMarkets.map((m) => ({
      ...m,
      direction: marketImpliedDirection(m.question, m.upProbability / 100, spotOf(m)) ?? 'NEUTRAL',
    }));
    const themeClusters: ThemeCluster[] = impliedBroad.length > 0 ? detectThemes(impliedBroad) : [];
    const liveYesBySlug = new Map(broadMarkets.map((m) => [m.slug, m.upProbability / 100]));

    // AI-selected markets. The fine-tuned interpreter runs in the
    // poly-discover cron on every new broad market and extracts asset,
    // strike, horizon, confidence, novelty. Fresh (24h), horizon-matched,
    // confident (≥0.7), not-yet-expired rows; one query for the whole
    // asset set, grouped in memory. Direction is decided per asset below
    // from each market's LIVE odds.
    let aiInterpretationsByAsset: Record<string, Array<{
      slug: string;
      title: string;
      confidence: number;
      horizon: string;
      novelty: number;
      interpretedAt: Date;
    }>> = {};
    try {
      const rows = await dbQuery<{
        asset: string;
        slug: string;
        title: string;
        confidence: string;
        horizon: string;
        novelty: string;
        interpreted_at: Date;
      }>(
        // Horizon filter is deliberately permissive: the interpreter tags
        // most markets as 'unknown' because the title alone often doesn't
        // carry the resolution window. Live prod (2026-09-21): 31 BTC UP
        // interpretations at horizon='unknown' vs 3 at 'daily' + 0 at
        // 'hourly'. Filtering to the two known-good horizons discarded 91%
        // of the AI-selected markets.
        // Skip 'weekly' + 'monthly' — those DO extract reliably and are
        // too slow for a 45min-hold trader.
        `SELECT asset, slug, title, confidence, horizon, novelty, interpreted_at
         FROM signal_interpretations
         WHERE asset = ANY($1::text[])
           AND direction IN ('UP', 'DOWN')
           AND confidence >= 0.7
           AND horizon NOT IN ('weekly', 'monthly')
           AND interpreted_at > NOW() - INTERVAL '24 hours'
           AND (horizon_end IS NULL OR horizon_end > NOW())
         ORDER BY (confidence * COALESCE(novelty, 0.5)) DESC
         LIMIT 30`,
        [upperAssets],
      );
      for (const r of rows) {
        const list = aiInterpretationsByAsset[r.asset] ??= [];
        list.push({
          slug: r.slug,
          title: r.title,
          confidence: Number(r.confidence),
          horizon: r.horizon,
          novelty: Number(r.novelty || 0.5),
          interpretedAt: r.interpreted_at,
        });
      }
    } catch (e) {
      logger.debug('[Aggregator] AI interpretations fetch failed (non-fatal)', {
        error: e instanceof Error ? e.message : String(e),
      });
      aiInterpretationsByAsset = {};
    }

    const out: Record<string, AggregatedPrediction> = {};
    const rawSources: Record<string, PredictionSource[]> = {};

    // The assets share only read-only inputs, so they run together: the scan
    // waits for the slowest asset, not the sum of every asset's state reads.
    const perAsset = await Promise.all(upperAssets.map(async (asset) => {
      const sources: PredictionSource[] = [];
      const spot = cryptoComData.perAsset[asset]?.price;

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
      //     to it. Kept at 0.10 weight: source-calibrator data (2026-09-21)
      //     shows n=75, 56.5% hit rate — it's the highest-N and one of the
      //     best-performing base sources. Different Polymarket query than
      //     (1a) so not truly redundant. Calibrator boosts to ~1.13× on top.
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

      // 2) Delphi/Polymarket markets that tag this asset — counted only
      //    when their odds imply a move from spot.
      const assetDelphi = delphiPredictions.filter((p) =>
        (p.relatedAssets || []).map((a) => a.toUpperCase()).includes(asset),
      );
      for (const pred of assetDelphi) {
        const direction = marketImpliedDirection(pred.question, pred.probability / 100, spot);
        if (!direction) continue;
        sources.push({
          name: `Delphi: ${pred.question.substring(0, 40)}...`,
          type: pred.category === 'price' ? 'medium_term' : 'sentiment',
          direction,
          confidence: pred.confidence,
          probability: Math.max(pred.probability, 100 - pred.probability),
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
      let manifoldCount = 0;
      for (const pred of assetManifold) {
        if (manifoldCount >= 3) break;
        const direction = marketImpliedDirection(pred.question, pred.probability / 100, spot);
        if (!direction) continue;
        manifoldCount++;
        sources.push({
          name: `Manifold: ${pred.question.substring(0, 40)}...`,
          type: 'medium_term',
          direction,
          confidence: pred.confidence,
          probability: Math.max(pred.probability, 100 - pred.probability),
          weight: pred.impact === 'HIGH' ? 0.10 : pred.impact === 'MODERATE' ? 0.07 : 0.04,
          rawData: pred,
          fetchedAt: pred.lastUpdate,
        });
      }

      // 3) Crypto.com 24h ticker for this asset. Weight dropped 0.20 → 0.10
      //    (2026-09-21): 24h price change is a technical/momentum indicator,
      //    not a prediction-market signal. At 0.20 it was contributing a
      //    third of total signal weight for BTC/ETH — masking the true
      //    prediction sources. See PolymarketBroadMarkets (block 3b)
      //    which now carries proper hourly/daily binary weight.
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
          weight: 0.10,
          rawData: ticker,
          fetchedAt: Date.now(),
        });
      }

      // 3b) Polymarket broad markets — hourly/daily binary + price-target
      //     markets tagged with this asset. These are the horizon-matched
      //     prediction-market signals the earlier code was leaving on the
      //     table. `PolymarketBroadMarketsService` already runs a 4× fan-out
      //     across sort orders and classifies horizon; we filter to hourly
      //     and daily (paper-trader holds 45min; the sweet spot is
      //     30min-24h resolution). Top 3 by 24h volume per asset, weighted
      //     0.06/0.05/0.04 — sums to ~0.15 for a well-covered asset,
      //     comparable to the Delphi/Manifold budget.
      const assetBroad = impliedBroad
        .filter((m) => m.assets.includes(asset))
        .filter((m) => (['hourly', 'daily'] as BroadHorizon[]).includes(m.horizon))
        .filter((m) => m.direction !== 'NEUTRAL')
        .filter((m) => m.liquidity >= 500)
        .sort((a, b) => b.volume24hr - a.volume24hr)
        .slice(0, 3);
      const broadWeights = [0.06, 0.05, 0.04];
      // Momentum boost — a market whose probability + volume have moved
      // sharply in the last 15+ min carries more information than a
      // static one. poly-discover cron snapshots per-market history to
      // poly-momentum:history:<slug>. If we have enough samples, compute
      // hotness (0-100 composite score) and boost weight up to 1.5×.
      // No history → no boost (weight stays base). Failures silently
      // no-op — momentum is a bonus, not a requirement.
      await Promise.all(
        assetBroad.map(async (m, i) => {
          let momentum: MarketMomentum | null = null;
          try {
            const hist = await getCronStateOr<MarketSnapshot[]>(
              `poly-momentum:history:${m.slug}`,
              [],
            );
            if (hist.length >= 2) momentum = computeMomentum(m, hist);
          } catch { /* no-op */ }
          const boost = momentum ? 1 + Math.min(0.5, momentum.hotness / 200) : 1;
          sources.push({
            name: `Polymarket ${m.horizon} ${asset}: ${m.question.substring(0, 40)}…`,
            type: m.horizon === 'hourly' ? 'short_term' : 'medium_term',
            direction: m.direction,
            confidence: Math.min(60 + Math.abs(m.probability - 50), 95),
            probability: m.probability,
            weight: broadWeights[i] * boost,
            rawData: {
              slug: m.slug,
              horizonHours: m.horizonHours,
              volume24hr: m.volume24hr,
              liquidity: m.liquidity,
              marketType: m.marketType,
              targetPrice: m.targetPrice,
              momentum: momentum
                ? {
                    hotness: momentum.hotness,
                    probabilityDelta: momentum.probabilityDelta,
                    volumeRatio: momentum.volumeRatio,
                    windowMinutes: momentum.windowMinutes,
                  }
                : null,
              momentumBoost: boost,
            },
            fetchedAt: Date.now(),
          });
        }),
      );

      // 3c) AI-selected prediction markets. The interpreter picks and parses
      //     the market; the direction is the market's own forecast — its
      //     live odds against spot — never the title's wording. The
      //     wording-era "81% accuracy" (and the 3x weight it justified)
      //     measured BTC drift, so these weigh the same as 3b's markets.
      //     Markets already counted in 3b, closed, or silent are skipped.
      const usableHorizons = new Set(['hourly', 'daily', 'unknown']);
      const countedSlugs = new Set(assetBroad.map((m) => m.slug));
      let aiCount = 0;
      for (const interp of aiInterpretationsByAsset[asset] ?? []) {
        if (aiCount >= 4) break;
        if (interp.horizon && !usableHorizons.has(interp.horizon)) continue;
        if (countedSlugs.has(interp.slug)) continue;
        const yes = liveYesBySlug.get(interp.slug);
        if (yes === undefined) continue;
        const direction = marketImpliedDirection(interp.title, yes, spot);
        if (!direction) continue;
        aiCount++;
        const conviction = Math.max(yes, 1 - yes) * 100;
        sources.push({
          name: `AI: ${interp.title.substring(0, 45)}…`,
          type: interp.horizon === 'hourly' || interp.horizon === 'unknown' ? 'short_term' : 'medium_term',
          direction,
          confidence: Math.min(60 + Math.abs(conviction - 50), 95),
          probability: conviction,
          weight: 0.05 * interp.confidence * (0.5 + interp.novelty * 0.5),
          rawData: {
            slug: interp.slug,
            yesPrice: yes,
            horizon: interp.horizon,
            novelty: interp.novelty,
            interpretedAt: interp.interpretedAt,
          },
          fetchedAt: interp.interpretedAt.getTime(),
        });
      }

      // 3d) Theme cluster meta-signals. A theme (etf-approval, fed-rates,
      //     regulation, etc.) with 3+ markets and volume-weighted
      //     directional consensus is a stronger meta-signal than any
      //     single market. affectsAssets scopes theme influence — a Fed
      //     theme applies to BTC + ETH + USDC; a halving theme only to
      //     BTC. Weight 0.04 per applicable theme with |consensus| ≥ 0.3.
      for (const theme of themeClusters) {
        if (theme.marketCount < 3) continue;
        if (Math.abs(theme.weightedDirection) < 0.3) continue;
        if (!theme.affectsAssets.includes(asset)) continue;
        const themeDir: 'UP' | 'DOWN' = theme.weightedDirection > 0 ? 'UP' : 'DOWN';
        const consensusStrength = Math.min(Math.abs(theme.weightedDirection), 1);
        sources.push({
          name: `Theme: ${theme.theme}`,
          type: 'sentiment',
          direction: themeDir,
          confidence: 50 + consensusStrength * 40,
          probability: 50 + consensusStrength * (themeDir === 'UP' ? 25 : -25),
          weight: 0.04,
          rawData: {
            theme: theme.theme,
            marketCount: theme.marketCount,
            weightedDirection: theme.weightedDirection,
            totalVolume24hr: theme.totalVolume24hr,
          },
          fetchedAt: Date.now(),
        });
      }

      // 4) REAL Bluefin funding rate for this asset (decimal per 8h).
      //    Positive funding = longs pay shorts → market crowd is long-biased
      //    → contrarian SHORT signal with strength scaled by magnitude.
      const fundingRate = fundingRates[asset];
      if (fundingRate !== undefined && Number.isFinite(fundingRate)) {
        const magnitude = Math.abs(fundingRate);
        const fundingDir = crowdedFundingDirection(fundingRate);
        if (fundingDir) {
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
        const funding = approximateFundingRateSentiment(sources);
        if (funding) sources.push(funding);
      }

      // 5c) Kalshi ATM-strike direction. Different user base than
      //     Polymarket (US institutional + retail). Binary "ASSET above
      //     $X at time T" markets — we infer direction from where the
      //     ATM strike sits vs spot. Extended 2026-09-21 to SOL/XRP/DOGE
      //     (was BTC/ETH-only) after direct API check confirmed all 5
      //     KX*D series tickers exist. Live-priced bracket varies by hour
      //     across assets (XRP had 10 live, BTC/ETH some, SOL/DOGE
      //     between-resolution at the time of check). The resolved-market
      //     filter in getKalshiSignal drops brackets whose yes-prices are
      //     all clustered near 0 or 1 → source silently skipped when the
      //     hourly bracket has just resolved, added when live.
      if (asset === 'BTC' || asset === 'ETH' || asset === 'SOL' || asset === 'XRP' || asset === 'DOGE') {
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
              // ~0.6% implied move → 80. Bounded: a 1.9% move once reported 143%.
              probability: Math.min(100, Math.max(0, 50 + kalshi.impliedMovePct * 5000)),
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
        const fundingDir = crowdedFundingDirection(bybit.funding);
        if (fundingDir) {
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
        // Contrarian, and only when the market is actually crowded.
        const fundingDir = crowdedFundingDirection(binance.funding);
        if (fundingDir) {
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
        // No long/short account-ratio vote: its fixed thresholds (above 1.5
        // or below 0.67) sat under the normal level of every asset but BTC
        // (medians 1.8 to 2.7), so it voted DOWN in 83% of hours over 30
        // days and never UP, with no timing edge (-0.2 ± 1.4 bp at 60 min).
      }

      // 5c) NEW 2026-09-23 — Orderbook microstructure (Binance perp L2).
      //     Top-20 bid vs ask depth ratio. Independent of prediction
      //     markets, captures near-term directional pressure that
      //     leaks into prices before it shows up in binaries.
      //     Signal: bid-heavy = UP (bullish demand), ask-heavy = DOWN.
      //     Only fires above |0.15| — sub-noise otherwise.
      const orderbook = orderbookImbalance[asset];
      if (orderbook && Math.abs(orderbook.imbalance) > 0.15) {
        const obDir: 'UP' | 'DOWN' = orderbook.imbalance > 0 ? 'UP' : 'DOWN';
        const magnitude = Math.abs(orderbook.imbalance);
        // Confidence scales with magnitude but caps at 78 — orderbook can
        // be spoofed at times, so we don't let it dominate.
        const conf = Math.min(45 + magnitude * 60, 78);
        sources.push({
          name: `Orderbook ${asset} depth-imbalance`,
          type: 'short_term',
          direction: obDir,
          confidence: conf,
          probability: 50 + Math.min(magnitude * 40, 25) * (obDir === 'UP' ? 1 : -1),
          weight: 0.13,
          rawData: {
            imbalancePct: Math.round(orderbook.imbalance * 100),
            bidDepthUsd: Math.round(orderbook.bidDepthUsd),
            askDepthUsd: Math.round(orderbook.askDepthUsd),
          },
          fetchedAt: Date.now(),
        });
      }

      // 5d) NEW 2026-09-23 — Options-market skew (Deribit BTC + ETH only).
      //     Weighted 25-delta risk reversal: positive = calls > puts IV
      //     (bullish, market paying up for upside). Also uses put/call
      //     OI ratio as a secondary confirm. Options positioning leads
      //     spot, so this is a leading indicator when it fires.
      const skew = optionsSkew[asset];
      if (skew && Math.abs(skew.riskReversal) > 2) {
        const skewDir: 'UP' | 'DOWN' = skew.riskReversal > 0 ? 'UP' : 'DOWN';
        // Confidence: risk-reversal magnitude in IV points, capped at 75.
        const conf = Math.min(45 + Math.abs(skew.riskReversal) * 3, 75);
        sources.push({
          name: `Options-skew ${asset} risk-reversal`,
          type: 'medium_term',
          direction: skewDir,
          confidence: conf,
          probability: 50 + Math.min(Math.abs(skew.riskReversal) * 2, 25) * (skewDir === 'UP' ? 1 : -1),
          weight: 0.11,
          rawData: {
            riskReversal: skew.riskReversal,
            callIv: skew.callIvAvg,
            putIv: skew.putIvAvg,
            putCallOiRatio: skew.putCallOiRatio,
          },
          fetchedAt: Date.now(),
        });
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

      // Kept as they stand before any is weighted or removed: the ledger
      // records these, so a removed source keeps being measured and can
      // earn its way back.
      const assetRawSources = sources.map((s) => ({ ...s }));

      // Apply learned per-source weight multipliers BEFORE the final
      // normalization step. When a source has no calibration history the
      // multiplier is 1.0 (identity), so this is safe to enable pre-data.
      // The paper-trader (chain='hedera-testnet') feeds this calibrator
      // from every closed trade — real trader benefits from the learned
      // weights without needing its own recording path.
      try {
        const { applyCalibrationToSources } = await import('@/lib/services/ai/source-calibrator');
        const calibrated = await applyCalibrationToSources(sources, { asset, horizonMin: LEDGER_WEIGHT_HORIZON_MIN });
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

      return { asset, assetRawSources, aggregated: calculateAggregation(sources) };
    }));
    for (const r of perAsset) {
      rawSources[r.asset] = r.assetRawSources;
      out[r.asset] = r.aggregated;
    }

    // Stored first and for the same time, so a cached scan always has its votes.
    cache.set(rawCacheKey, rawSources, CACHE_TTL_MS);
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

  private static rawSourcesCacheKey(assets: string[]): string {
    return `prediction_per_asset_raw:${assets.slice().sort().join(',')}`;
  }

  /**
   * Every source's vote and base weight for the scan
   * `getPerAssetPredictions(assets)` serves, before the feedback loop
   * weighted or removed any. A coin is absent when that scan's votes are
   * no longer held; the caller then has only the weighted list.
   */
  static async getPerAssetRawSources(assets: string[]): Promise<Record<string, PredictionSource[]>> {
    await this.getPerAssetPredictions(assets);
    return cache.get<Record<string, PredictionSource[]>>(PredictionAggregatorService.rawSourcesCacheKey(assets)) ?? {};
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
