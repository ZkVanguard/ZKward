/**
 * Options-market skew signal from Deribit (BTC + ETH only).
 *
 * Signal thesis: options positioning leads spot moves. When calls
 * consistently trade at higher IV than equidistant puts (positive risk
 * reversal), sophisticated traders are paying up for upside — a bullish
 * lead indicator. Negative risk reversal is the opposite (put demand →
 * bearish lead).
 *
 * Formula:
 *   risk_reversal = weighted_call_IV - weighted_put_IV
 *
 *   Weighted by (bell-curve proximity to spot) × open interest. Only
 *   considers strikes within ±30% of underlying — far-OTM strikes have
 *   distorted IV and irrelevant OI.
 *
 * Also captures put/call OI ratio as a secondary sentiment gauge:
 *   > 0.7 = defensive positioning (bearish tilt)
 *   < 0.5 = risk-on positioning (bullish tilt)
 *
 * Cache 5 min — Deribit IV updates slowly. Available only for BTC + ETH
 * (the only two Deribit crypto option series).
 */

import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';

export interface OptionsSkew {
  callIvAvg: number;       // weighted avg call IV (%)
  putIvAvg: number;        // weighted avg put IV (%)
  riskReversal: number;    // callIv - putIv (positive = bullish skew)
  putCallOiRatio: number;  // total put OI / total call OI
  totalOi: number;         // sum of all OI in the near-money band
  underlying: number;      // spot from Deribit
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const STRIKE_BAND_PCT = 0.30;     // consider strikes ±30% of underlying
const SIGMA_PCT = 0.15;           // bell-curve sigma for weighting
const cache = new Map<'BTC' | 'ETH', OptionsSkew>();

export async function getOptionsSkew(asset: 'BTC' | 'ETH'): Promise<OptionsSkew | null> {
  const cached = cache.get(asset);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;

  try {
    const resp = await fetch(
      `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=option`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!resp.ok) return null;
    const json = await resp.json() as {
      result?: Array<{
        instrument_name: string;
        open_interest: number;
        mark_iv?: number;
        underlying_price?: number;
      }>;
    };
    const results = json.result ?? [];
    if (results.length === 0) return null;

    // Underlying spot from the first entry that has it (Deribit puts it on
    // every book summary; we take the first non-zero).
    const underlying = results.find((r) => r.underlying_price)?.underlying_price ?? 0;
    if (!underlying) return null;

    let callIvSum = 0, callWeight = 0, putIvSum = 0, putWeight = 0;
    let totalCallOi = 0, totalPutOi = 0;

    for (const item of results) {
      // Instrument format: 'BTC-25DEC26-90000-C' | '-P'
      const parts = item.instrument_name.split('-');
      if (parts.length !== 4) continue;
      const strike = Number(parts[2]);
      const type = parts[3];
      const oi = Number(item.open_interest) || 0;
      const iv = Number(item.mark_iv) || 0;
      if (!Number.isFinite(strike) || iv <= 0 || oi <= 0) continue;
      if (type !== 'C' && type !== 'P') continue;

      const distance = Math.abs(strike - underlying) / underlying;
      if (distance > STRIKE_BAND_PCT) continue;

      // Bell-curve weight: near-the-money strikes count most
      const proxWeight = Math.exp(-Math.pow(distance / SIGMA_PCT, 2));
      const weight = proxWeight * oi;

      if (type === 'C') {
        callIvSum += iv * weight;
        callWeight += weight;
        totalCallOi += oi;
      } else {
        putIvSum += iv * weight;
        putWeight += weight;
        totalPutOi += oi;
      }
    }
    if (callWeight === 0 || putWeight === 0) return null;

    const callIvAvg = callIvSum / callWeight;
    const putIvAvg = putIvSum / putWeight;
    const riskReversal = callIvAvg - putIvAvg;
    const putCallOiRatio = totalCallOi > 0 ? totalPutOi / totalCallOi : 0;
    const totalOi = totalCallOi + totalPutOi;

    const result: OptionsSkew = {
      callIvAvg: Math.round(callIvAvg * 10) / 10,
      putIvAvg: Math.round(putIvAvg * 10) / 10,
      riskReversal: Math.round(riskReversal * 10) / 10,
      putCallOiRatio: Math.round(putCallOiRatio * 100) / 100,
      totalOi: Math.round(totalOi),
      underlying: Math.round(underlying),
      fetchedAt: now,
    };
    cache.set(asset, result);
    return result;
  } catch (e) {
    logger.debug('[OptionsSkew] fetch failed (fail-open)', {
      asset, error: errMsg(e),
    });
    return null;
  }
}

export async function fetchOptionsSkewBatch(
  assets: Array<'BTC' | 'ETH'>,
): Promise<Record<string, OptionsSkew>> {
  const results = await Promise.all(
    assets.map(async (a) => [a, await getOptionsSkew(a)] as const),
  );
  const out: Record<string, OptionsSkew> = {};
  for (const [asset, data] of results) {
    if (data) out[asset] = data;
  }
  return out;
}
