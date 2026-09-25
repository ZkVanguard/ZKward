/**
 * Composite context tool — `getAssetContext` is the "one call answers
 * everything about an asset" tool that fans out to price, broader-market,
 * signal, and hedge lookups in parallel. Referenced explicitly by the
 * agent so the LLM is nudged toward it over the three sub-tools.
 */

import { HEDGES_REAL_ONLY_SQL } from '@/lib/db/hedges-scope';
import type { AgentTool } from './types';
import { getBroaderMarket } from './market-tools';

/**
 * Unified per-asset context — one tool call returns everything the LLM
 * needs to answer "how is X doing" / "what's happening with X" style
 * questions comprehensively in a single response.
 *
 * Returns (best-effort — each sub-fetch fails independently):
 *   price       — spot from validated multi-source aggregator (BTC/ETH/SOL/XRP/DOGE/CRO/SUI/ATOM)
 *                 OR Crypto.com direct fallback for any other ticker
 *   change24hPct — 24h percent change (Crypto.com)
 *   volume24hUsd — 24h volume in USD (Crypto.com)
 *   signal      — fused prediction-market signal (tracked assets only): direction, confidence, consensus, recommendation, sourceCount
 *   recentHedges — last 3 vault hedges on this asset (real, not paper), most recent first
 *
 * This is THE tool for any single-asset question. LLM should prefer this
 * over calling get_asset_price + get_prediction_signal + query_hedge_history
 * separately. One round-trip instead of three.
 */
export const getAssetContext: AgentTool<
  { asset: string },
  {
    asset: string;
    price: number | null;
    priceConfidence?: string;
    priceSources?: number;
    change24hPct: number | null;
    volume24hUsd: number | null;
    signal: null | {
      direction: 'UP' | 'DOWN' | 'NEUTRAL';
      confidence: number;
      consensus: number;
      recommendation: string;
      sourceCount: number;
      reasoning: string;
      /** Top-5 individual source contributions by weight — lets consumers
       *  cite REAL sources ("Delphi UP@78%, Polymarket DOWN@51%") instead
       *  of inventing generic phrases like "funding rates elevated". */
      topSources: Array<{
        name: string;
        direction: 'UP' | 'DOWN' | 'NEUTRAL';
        confidence: number;
        weight: number;
      }>;
    };
    recentHedges: Array<{
      orderId: string;
      side: string;
      notionalUsd: number;
      status: string;
      realizedPnlUsd: number | null;
      openedAt: string;
      closedAt: string | null;
    }>;
    isTracked: boolean;
  }
> = {
  name: 'get_asset_context',
  description:
    'Return EVERYTHING about one crypto asset in one call: price, 24h change, volume, prediction signal (if tracked), recent vault hedges. Use this for "how is X doing", "what\'s happening with X", "give me an update on X" — never call get_asset_price + get_prediction_signal + query_hedge_history separately when this covers all three.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Asset ticker (BTC, ETH, DOGE, ADA, anything).' },
    },
    required: ['asset'],
    additionalProperties: false,
  },
  async execute({ asset }) {
    const symbol = asset.toUpperCase();
    const TRACKED = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'CRO', 'SUI', 'ATOM'];
    const isTracked = TRACKED.includes(symbol);

    // Fire all sub-fetches in parallel — each fails independently.
    const [priceRes, broaderRes, signalRes, hedgesRes] = await Promise.allSettled([
      isTracked
        ? (async () => {
            const { getMultiSourceValidatedPrice } = await import('@/lib/services/market-data/unified-price-provider');
            return await getMultiSourceValidatedPrice(symbol);
          })()
        : Promise.resolve(null),
      getBroaderMarket.execute({ symbol }),
      isTracked
        ? (async () => {
            const { PredictionAggregatorService } = await import('@/lib/services/market-data/PredictionAggregatorService');
            const preds = await PredictionAggregatorService.getPerAssetPredictions([symbol]);
            return preds[symbol] ?? null;
          })()
        : Promise.resolve(null),
      (async () => {
        const { query } = await import('@/lib/db/postgres');
        const rows = await query<{
          order_id: string; side: string; notional_value: string; status: string;
          realized_pnl: string | null; created_at: Date; closed_at: Date | null;
        }>(
          `SELECT order_id, side, notional_value, status,
                  realized_pnl, created_at, closed_at
           FROM hedges
           WHERE asset = $1 AND ${HEDGES_REAL_ONLY_SQL}
           ORDER BY created_at DESC LIMIT 3`,
          [symbol],
        );
        return rows;
      })(),
    ]);

    // Assemble. Price prefers validated tracked-asset source; falls back to Crypto.com from broader.
    const priceData = priceRes.status === 'fulfilled' && priceRes.value
      ? { price: priceRes.value.price, confidence: priceRes.value.confidence, sources: priceRes.value.sources.length }
      : null;
    const broader = broaderRes.status === 'fulfilled' ? broaderRes.value : null;
    const broaderHit = broader && 'symbol' in broader && broader.symbol && !('error' in broader.symbol)
      ? (broader.symbol as { price: number; change24hPct: number; volume24hUsd: number })
      : null;
    const pred = signalRes.status === 'fulfilled' ? signalRes.value : null;
    const hedges = hedgesRes.status === 'fulfilled' ? hedgesRes.value : [];

    return {
      asset: symbol,
      price: priceData?.price ?? broaderHit?.price ?? null,
      priceConfidence: priceData?.confidence,
      priceSources: priceData?.sources,
      change24hPct: broaderHit?.change24hPct ?? null,
      volume24hUsd: broaderHit?.volume24hUsd ?? null,
      signal: pred
        ? {
            direction: pred.direction,
            confidence: Math.round(pred.confidence),
            consensus: Math.round(pred.consensus),
            recommendation: pred.recommendation,
            sourceCount: pred.sources.length,
            reasoning: pred.reasoning.slice(0, 240),
            topSources: [...pred.sources]
              .sort((a, b) => b.weight - a.weight)
              .slice(0, 5)
              .map((s) => ({
                name: s.name,
                direction: s.direction,
                confidence: Math.round(s.confidence),
                weight: Math.round(s.weight * 100) / 100,
              })),
          }
        : null,
      recentHedges: hedges.map((h) => ({
        orderId: h.order_id,
        side: h.side,
        notionalUsd: Number(h.notional_value),
        status: h.status,
        realizedPnlUsd: h.realized_pnl !== null ? Number(h.realized_pnl) : null,
        openedAt: h.created_at.toISOString(),
        closedAt: h.closed_at?.toISOString() ?? null,
      })),
      isTracked,
    };
  },
};
