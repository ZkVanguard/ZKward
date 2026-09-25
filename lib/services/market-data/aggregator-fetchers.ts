/**
 * Pure fetchers for PredictionAggregatorService. Extracted 2026-09-25
 * to shrink the aggregator monolith — no `this`, no static class state.
 * Each returns a sparse result on any error; caller must fail-open.
 */

import { logger } from '@/lib/utils/logger';
import type { FiveMinBTCSignal } from './Polymarket5MinService';
import type { PredictionMarket } from './DelphiMarketService';
import { CACHE_TAG_CRYPTOCOM_TICKER, CACHE_TAG_BLUEFIN_FUNDING } from './cache-tags';
import type { PredictionSource } from './PredictionAggregatorService';

export async function fetchPolymarketSignal(): Promise<FiveMinBTCSignal | null> {
  try {
    const { Polymarket5MinService } = await import('./Polymarket5MinService');
    return await Polymarket5MinService.getLatest5MinSignal();
  } catch (error) {
    logger.debug('[PredictionAggregator] Polymarket fetch failed', { error });
    return null;
  }
}

export async function fetchDelphiPredictions(): Promise<PredictionMarket[]> {
  try {
    const { DelphiMarketService } = await import('./DelphiMarketService');
    const { resolveAgentUniverse } = await import('@/lib/config/agent-universe');
    const assets = await resolveAgentUniverse();
    const predictions = await DelphiMarketService.getRelevantMarkets(assets);
    return predictions.filter((p) => p.impact === 'HIGH' || p.impact === 'MODERATE').slice(0, 5);
  } catch (error) {
    logger.debug('[PredictionAggregator] Delphi fetch failed', { error });
    return [];
  }
}

export async function fetchCryptoComData(assets: string[] = ['BTC', 'ETH']): Promise<{
  btc: { price: number; change24h: number; volume: number } | null;
  eth: { price: number; change24h: number; volume: number } | null;
  perAsset: Record<string, { price: number; change24h: number; volume: number }>;
}> {
  try {
    const response = await fetch('https://api.crypto.com/exchange/v1/public/get-tickers', {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 30, tags: [CACHE_TAG_CRYPTOCOM_TICKER] },
    });
    if (!response.ok) throw new Error('Crypto.com API unavailable');

    const data = await response.json();
    const tickers: Array<Record<string, string>> = data.result?.data || [];
    const perAsset: Record<string, { price: number; change24h: number; volume: number }> = {};
    const tickerMap: Record<string, Record<string, string>> = {};
    for (const t of tickers) tickerMap[String(t.i || '')] = t;

    for (const rawAsset of assets) {
      const asset = rawAsset.toUpperCase();
      const t = tickerMap[`${asset}_USDT`];
      if (!t) continue;
      // Bid+ask MID for drift tracking — ask alone goes stale between updates on
      // quiet pairs and produces zero-delta samples. Midpoint catches any real move.
      const ask = parseFloat(t.a || '0');
      const bid = parseFloat(t.b || '0');
      const price = ask > 0 && bid > 0 ? (ask + bid) / 2 : ask || bid;
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
      btc: btcTicker
        ? {
            price: parseFloat(btcTicker.a || '0'),
            change24h: parseFloat(btcTicker.c || '0') * 100,
            volume: parseFloat(btcTicker.v || '0') * parseFloat(btcTicker.a || '0'),
          }
        : null,
      eth: ethTicker
        ? {
            price: parseFloat(ethTicker.a || '0'),
            change24h: parseFloat(ethTicker.c || '0') * 100,
            volume: parseFloat(ethTicker.v || '0') * parseFloat(ethTicker.a || '0'),
          }
        : null,
      perAsset,
    };
  } catch (error) {
    logger.debug('[PredictionAggregator] Crypto.com fetch failed', { error });
    return { btc: null, eth: null, perAsset: {} };
  }
}

/**
 * Binance perpetual funding + long/short account ratio.
 * Contrarian signals: funding > +0.03%/8h (~30% APR) → longs crowded → SHORT;
 * long/short ratio > 1.5 or < 0.67 → extreme retail positioning.
 */
export async function fetchBinancePositioning(
  assets: string[],
): Promise<Record<string, { funding: number; longShortRatio: number }>> {
  const out: Record<string, { funding: number; longShortRatio: number }> = {};
  await Promise.all(
    assets.map(async (rawAsset) => {
      const asset = rawAsset.toUpperCase();
      const symbol = `${asset}USDT`;
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
          asset,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
  return out;
}

/**
 * Bybit perpetual funding + open-interest for SOL/XRP/DOGE parity with BTC/ETH.
 * OI-change is the interesting signal (rising OI + rising price = crowded top,
 * etc.); caller computes delta from prior fetch.
 */
export async function fetchBybitPositioning(
  assets: string[],
): Promise<Record<string, { funding: number; openInterest: number }>> {
  const out: Record<string, { funding: number; openInterest: number }> = {};
  await Promise.all(
    assets.map(async (rawAsset) => {
      const asset = rawAsset.toUpperCase();
      const symbol = `${asset}USDT`;
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
          asset,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
  return out;
}

/**
 * Live per-asset funding rate from BlueFin's public ticker (decimal per 8h
 * interval; e.g. 0.0001 ≈ 11% APR). Public endpoint, no admin key needed.
 */
export async function fetchBluefinFundingRates(
  assets: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const network =
    (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet' ? 'testnet' : 'mainnet';
  const base =
    network === 'mainnet'
      ? 'https://api.sui-prod.bluefin.io'
      : 'https://api.sui-staging.bluefin.io';
  await Promise.all(
    assets.map(async (rawAsset) => {
      const asset = rawAsset.toUpperCase();
      const symbol = `${asset}-PERP`;
      try {
        const res = await fetch(
          `${base}/v1/exchange/ticker?symbol=${encodeURIComponent(symbol)}`,
          {
            signal: AbortSignal.timeout(4000),
            next: { revalidate: 60, tags: [CACHE_TAG_BLUEFIN_FUNDING] },
          },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
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
    }),
  );
  return out;
}

/**
 * Fallback funding-rate proxy derived from the short-term source mix when
 * direct venue funding isn't available. Bullish short-term consensus implies
 * positive funding (shorts pay longs) and vice versa.
 */
export function approximateFundingRateSentiment(
  existingSources: PredictionSource[],
): PredictionSource | null {
  if (existingSources.length < 2) return null;
  const shortTermSources = existingSources.filter((s) => s.type === 'short_term');
  if (shortTermSources.length === 0) return null;

  const avgDirection =
    shortTermSources.reduce((sum, s) => {
      return sum + (s.direction === 'UP' ? 1 : s.direction === 'DOWN' ? -1 : 0);
    }, 0) / shortTermSources.length;

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
