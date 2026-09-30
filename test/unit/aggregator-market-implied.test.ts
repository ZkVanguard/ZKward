/**
 * Aggregator wiring: every market-derived source (broad 3b, AI 3c, Manifold,
 * themes) takes its direction from the market's odds against spot. Markets
 * that forecast no move must never become votes — on 2026-09-30 a ladder of
 * such markets was voting DOWN at 95% confidence.
 */
import { describe, it, expect, jest } from '@jest/globals';

const SPOT = 84_000;

const market = (slug: string, question: string, upProbability: number, horizon = 'daily') => ({
  id: slug,
  slug,
  question,
  horizon,
  horizonHours: 12,
  marketType: 'price-target',
  upProbability,
  downProbability: 100 - upProbability,
  probability: Math.max(upProbability, 100 - upProbability),
  direction: upProbability > 50 ? 'UP' : 'DOWN', // the old "YES is likely" field
  volume24hr: 50_000,
  liquidity: 5_000,
  assets: ['BTC'],
  targetPrice: null,
  targetDate: null,
  endDate: null,
  sourceUrl: '',
});

const BROAD = [
  market('btc-above-86k', 'Will the price of Bitcoin be above $86,000 on September 30?', 8),
  market('btc-dip-82500', 'Will Bitcoin dip to $82,500 in September?', 10),
  market('btc-above-85k', 'Will the price of Bitcoin be above $85,000 on September 30?', 70),
  market('btc-updown', 'Bitcoin Up or Down on September 30?', 44),
  market('btc-reach-85k', 'Will Bitcoin reach $85,000 by October 3?', 72, 'weekly'),
];

const interp = (slug: string, title: string) => ({
  asset: 'BTC', slug, title, confidence: '0.9', horizon: 'unknown', novelty: '0.5', interpreted_at: new Date(),
});
const AI_ROWS = [
  interp('btc-reach-85k', 'Will Bitcoin reach $85,000 by October 3?'),
  interp('btc-dip-80k', 'Will Bitcoin dip to $80,000 in September?'), // no live odds → skipped
  interp('btc-dip-82500', 'Will Bitcoin dip to $82,500 in September?'), // live, no forecast → skipped
];

const manifold = (id: string, question: string, probability: number) => ({
  id, question, category: 'price', probability, volume: '', impact: 'MODERATE',
  relatedAssets: ['BTC'], lastUpdate: Date.now(), confidence: 70, source: 'manifold',
});
const MANIFOLD = [
  manifold('m1', 'Will bitcoin rise to 105k before the Strategic Bitcoin Reserve is funded?', 21),
  manifold('m2', 'Bitcoin price reaches 75k USD at any point before 2027?', 70),
  manifold('m3', 'Rippling wins its lawsuit against Deel', 55),
];

jest.mock('@/lib/utils/cache', () => ({ cache: { get: () => undefined, set: () => undefined } }));
jest.mock('@/lib/services/market-data/aggregator-fetchers', () => ({
  fetchPolymarketSignal: jest.fn(async () => null),
  fetchDelphiPredictions: jest.fn(async () => []),
  fetchCryptoComData: jest.fn(async () => ({
    btc: null,
    eth: null,
    perAsset: { BTC: { price: SPOT, change24h: 0, volume: 0 } },
  })),
  fetchBinancePositioning: jest.fn(async () => ({})),
  fetchBybitPositioning: jest.fn(async () => ({})),
  fetchBluefinFundingRates: jest.fn(async () => ({})),
  approximateFundingRateSentiment: jest.fn(() => null),
}));
jest.mock('@/lib/services/market-data/MultiAssetSignalService', () => ({
  MultiAssetSignalService: { getLatestSignals: jest.fn(async () => ({})) },
  getTrackedAssetList: () => ['BTC'],
}));
jest.mock('@/lib/services/market-data/ManifoldMarketService', () => ({
  ManifoldMarketService: { getCryptoMarkets: jest.fn(async () => MANIFOLD) },
}));
jest.mock('@/lib/services/market-data/PolymarketBroadMarketsService', () => ({
  fetchBroadCryptoMarkets: jest.fn(async () => BROAD),
}));
jest.mock('@/lib/services/market-data/OrderbookImbalanceService', () => ({
  fetchOrderbookImbalanceBatch: jest.fn(async () => ({})),
}));
jest.mock('@/lib/services/market-data/OptionsSkewService', () => ({
  fetchOptionsSkewBatch: jest.fn(async () => ({})),
}));
jest.mock('@/lib/services/market-data/KalshiMarketService', () => ({
  getKalshiSignal: jest.fn(async () => null),
}));
jest.mock('@/lib/db/postgres', () => ({ query: jest.fn(async () => AI_ROWS) }));
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateOr: jest.fn(async (_key: string, fallback: unknown) => fallback),
  getCronState: jest.fn(async () => null),
}));
jest.mock('@/lib/services/ai/source-calibrator', () => ({
  applyCalibrationToSources: jest.fn(async (s: unknown[]) => [...s]),
}));

import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';

describe('aggregator reads markets by their odds, not their wording', () => {
  it('keeps forecasting markets with the implied direction and drops the rest', async () => {
    const { BTC } = await PredictionAggregatorService.getPerAssetPredictions(['BTC']);
    const dir = (prefix: string) => BTC.sources.find((s) => s.name.startsWith(prefix))?.direction;

    expect(dir('Polymarket daily BTC: Will the price of Bitcoin be above $85')).toBe('UP');
    expect(dir('Polymarket daily BTC: Bitcoin Up or Down')).toBe('DOWN');
    expect(dir('AI: Will Bitcoin reach $85,000')).toBe('UP');
    expect(dir('Manifold: Bitcoin price reaches 75k')).toBe('DOWN');
    expect(dir('Theme: price-target')).toBe('UP');

    const names = BTC.sources.map((s) => s.name).join(' | ');
    for (const silent of ['$86,0', 'dip to $82,500', '105k', 'dip to $80,000', 'Rippling']) {
      expect(names).not.toContain(silent);
    }
  });
});
