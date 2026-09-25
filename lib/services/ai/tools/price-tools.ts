/**
 * Price + prediction-signal tools — validated spot from our multi-source
 * aggregator, market snapshots, and the fused prediction-market signal
 * that the trader actually consumes.
 */

import type { AgentTool } from './types';

export const getAssetPrice: AgentTool<
  { asset: string },
  { asset: string; price: number; confidence: string; sources: number }
> = {
  name: 'get_asset_price',
  description:
    'Fetch validated spot price for an asset across multiple sources. Returns median with confidence and source count.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Asset ticker: BTC, ETH, SOL, SUI, etc.' },
    },
    required: ['asset'],
    additionalProperties: false,
  },
  async execute({ asset }) {
    const { getMultiSourceValidatedPrice } = await import(
      '@/lib/services/market-data/unified-price-provider'
    );
    const v = await getMultiSourceValidatedPrice(asset.toUpperCase());
    return { asset: asset.toUpperCase(), price: v.price, confidence: v.confidence, sources: v.sources.length };
  },
};

export const getMarketSnapshot: AgentTool<
  { assets?: string[] },
  Record<string, { price: number; confidence: string; sources: number } | { error: string }>
> = {
  name: 'get_market_snapshot',
  description:
    'Get validated spot prices for multiple crypto assets in one call. Use for "how is the market today?"-style questions. Defaults to BTC + ETH + SOL + SUI when no assets specified.',
  parameters: {
    type: 'object',
    properties: {
      assets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tickers to snapshot (max 8). Default: BTC, ETH, SOL, SUI.',
      },
    },
    additionalProperties: false,
  },
  async execute({ assets }) {
    const { getMultiSourceValidatedPrice } = await import(
      '@/lib/services/market-data/unified-price-provider'
    );
    const list = (assets && assets.length ? assets : ['BTC', 'ETH', 'SOL', 'SUI'])
      .slice(0, 8)
      .map((a) => a.toUpperCase());
    const entries = await Promise.all(
      list.map(async (a) => {
        try {
          const v = await getMultiSourceValidatedPrice(a);
          return [a, { price: v.price, confidence: v.confidence, sources: v.sources.length }] as const;
        } catch (e) {
          return [a, { error: e instanceof Error ? e.message : 'lookup failed' }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  },
};

export const getPredictionSignal: AgentTool<
  { asset?: string; assets?: string[] },
  Record<
    string,
    {
      direction: 'UP' | 'DOWN' | 'NEUTRAL';
      confidence: number;
      probability: number;
      consensus: number;
      recommendation: string;
      reasoning: string;
    }
  >
> = {
  name: 'get_prediction_signal',
  description:
    'Get the fused prediction-market signal for one or more crypto assets — direction (UP/DOWN/NEUTRAL), confidence 0-100, consensus across sources, and the current trader recommendation. This is what the trading agents actually see. Use for "what does the market think about X?" or "should we be long/short?" questions.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Single asset ticker, e.g. "BTC". Ignored if `assets` is given.' },
      assets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple tickers. Max 6. Defaults to BTC + ETH if neither given.',
      },
    },
    additionalProperties: false,
  },
  async execute({ asset, assets }) {
    const { PredictionAggregatorService } = await import(
      '@/lib/services/market-data/PredictionAggregatorService'
    );
    const list = (assets && assets.length ? assets : asset ? [asset] : ['BTC', 'ETH'])
      .slice(0, 6)
      .map((a) => a.toUpperCase());
    const raw = await PredictionAggregatorService.getPerAssetPredictions(list);
    const out: Record<string, ReturnType<typeof shape>> = {};
    function shape(p: (typeof raw)[string]) {
      return {
        direction: p.direction,
        confidence: Math.round(p.confidence),
        probability: Math.round(p.probability),
        consensus: Math.round(p.consensus),
        recommendation: p.recommendation,
        reasoning: p.reasoning,
      };
    }
    for (const a of list) if (raw[a]) out[a] = shape(raw[a]);
    return out;
  },
};
