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
const MIN_ANNUAL_VOL_PCT = Number(process.env.PAPER_TRADER_MIN_ANNUAL_VOL_PCT || 40);
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

/** Rejection check: refuse the trade when the asset's annualized realized
 *  vol is below MIN_ANNUAL_VOL_PCT. Only fires for BTC + ETH (Deribit's
 *  vol index only covers those). Fail-open on any error. */
export async function lowVolatilityRejection(asset: string): Promise<string | null> {
  const currency = asset === 'BTC' ? 'BTC' : asset === 'ETH' ? 'ETH' : null;
  if (!currency) return null; // no gate for SOL/XRP/DOGE
  const vol = await getRealizedVolPct(currency);
  if (vol == null) return null; // fail-open on fetch failure
  if (vol >= MIN_ANNUAL_VOL_PCT) return null;
  return `low-vol: ${asset} realized vol ${vol.toFixed(1)}% < min ${MIN_ANNUAL_VOL_PCT}% — 20min move likely below fee floor`;
}
