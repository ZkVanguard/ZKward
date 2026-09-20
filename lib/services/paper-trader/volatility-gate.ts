/**
 * Volatility gate — refuse trades when realized volatility is too low
 * for the expected move to overcome fees.
 *
 * Diagnosed 2026-09-19: 7 consecutive BTC LONG losses of -$651 during a
 * low-vol grind. Signals correctly predicted UP; BTC did move UP ~$100
 * in most 20-min windows. Round-trip fees on $87k notional (~$105) ate
 * every small win. Root cause: expected move < fee cost.
 *
 * Deribit's historical realized-volatility endpoint gives us annualized
 * vol for BTC/ETH. Convert to expected 20-min move:
 *   expected_pct_20min = annualized_vol / sqrt(365 * 24 * 3)
 *                      = annualized_vol / 161.55
 *
 * At BTC $81,000 with 34% annualized vol:
 *   expected 20-min move ≈ $170
 *   fee cost on 3× levered $87k notional ≈ $105
 *   Marginal — will break-even often, lose to slippage frequently.
 *
 * At BTC $81,000 with 50% annualized vol:
 *   expected 20-min move ≈ $250
 *   fee cost same ≈ $105
 *   Comfortable edge.
 *
 * Threshold defaults to 40% annualized (env: PAPER_TRADER_MIN_ANNUAL_VOL_PCT).
 * Only checks BTC + ETH — other assets fall through without a gate.
 */
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';

const DERIBIT_VOL_URL = 'https://www.deribit.com/api/v2/public/get_historical_volatility';
// RESEARCH MODE (2026-09-20): 40 → 25 so BTC (currently ~32% annualized)
// stops getting rejected at the vol-gate. Cost: some 20-min BTC moves
// will be inside the 13bp fee floor. Mitigation: 45m base max-hold now
// gives moves time to develop; price-anchored stop caps downside.
// Tighten back to 40 once mainnet-readiness gates are green.
const MIN_ANNUAL_VOL_PCT = Number(process.env.PAPER_TRADER_MIN_ANNUAL_VOL_PCT || 25);
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — vol data updates hourly on Deribit

interface CacheEntry {
  vol: number;
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Fetch the latest historical vol reading for BTC or ETH.
 *  Returns null on any error — caller lets the trade through
 *  (fail-open) so an API outage never halts the strategy. */
export async function getRealizedVolPct(currency: 'BTC' | 'ETH'): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(currency);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.vol;
  }
  try {
    const resp = await fetch(`${DERIBIT_VOL_URL}?currency=${currency}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { result?: Array<[number, number]> };
    const arr = json.result;
    if (!arr || arr.length === 0) return null;
    // arr entries are [timestamp_ms, vol_pct] — latest at end.
    const vol = Number(arr[arr.length - 1]?.[1]);
    if (!Number.isFinite(vol) || vol <= 0) return null;
    cache.set(currency, { vol, fetchedAt: now });
    return vol;
  } catch (e) {
    logger.debug('[VolGate] Deribit vol fetch failed (fail-open)', {
      currency, error: errMsg(e),
    });
    return null;
  }
}

/** Realized volatility for SOL/XRP/DOGE — computed from Binance's
 *  1h klines (last 24h). Free public API. Returns annualized vol %.
 *  Cache 5min TTL to match Deribit's cadence. */
async function getBinanceRealizedVolPct(asset: string): Promise<number | null> {
  const now = Date.now();
  const cacheKey = `binance:${asset}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.vol;
  try {
    const resp = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${asset}USDT&interval=1h&limit=24`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!resp.ok) return null;
    const raw = (await resp.json()) as unknown;
    // klines format: [openTime, open, high, low, close, volume, ...]
    if (!Array.isArray(raw) || raw.length < 6) return null;
    const closes = raw.map((k) => parseFloat((k as unknown[])[4] as string)).filter(Number.isFinite);
    if (closes.length < 6) return null;
    // Log returns → stdev × sqrt(365 × 24) for annualized vol
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    const hourlyVol = Math.sqrt(variance);
    const annualVol = hourlyVol * Math.sqrt(365 * 24) * 100;
    if (!Number.isFinite(annualVol) || annualVol <= 0) return null;
    cache.set(cacheKey, { vol: annualVol, fetchedAt: now });
    return annualVol;
  } catch (e) {
    logger.debug('[VolGate] Binance klines fetch failed (fail-open)', {
      asset, error: errMsg(e),
    });
    return null;
  }
}

/** Rejection check: refuse the trade when the asset's annualized realized
 *  vol is below MIN_ANNUAL_VOL_PCT.
 *
 *  Coverage:
 *    - BTC + ETH: Deribit's implied vol index (most reliable, options-implied)
 *    - SOL, XRP, DOGE + others: Binance 1h klines → realized vol
 *
 *  Fail-open on any error. */
export async function lowVolatilityRejection(asset: string): Promise<string | null> {
  const upper = asset.toUpperCase();
  let vol: number | null = null;
  if (upper === 'BTC' || upper === 'ETH') {
    vol = await getRealizedVolPct(upper);
  } else {
    vol = await getBinanceRealizedVolPct(upper);
  }
  if (vol == null) return null; // fail-open on fetch failure
  if (vol >= MIN_ANNUAL_VOL_PCT) return null;
  return `low-vol: ${asset} realized vol ${vol.toFixed(1)}% < min ${MIN_ANNUAL_VOL_PCT}% — 20min move likely below fee floor`;
}
