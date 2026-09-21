/**
 * Kalshi prediction market — CFTC-regulated US venue.
 *
 * Added 2026-09-19 to diversify beyond Polymarket. Different user base
 * (US institutional + retail vs Polymarket's global crypto-native crowd)
 * means signals are genuinely orthogonal. Read-only public API — no
 * auth needed for market data.
 *
 * ## Signal extraction
 *
 * Kalshi's crypto markets are strike-based: "Will BTC be above $X at
 * time T?" Each hourly bracket has 20-30 strikes spanning ±5-10% of spot.
 *
 * We infer directional bias from the ATM strike (where yes_price ≈ 0.5):
 *   - ATM strike ABOVE current spot → market expects UP move
 *   - ATM strike BELOW current spot → market expects DOWN move
 *   - Magnitude of (ATM - spot) / spot ≈ implied expected move
 *
 * ## Series tickers
 *
 * - KXBTCD  = BTC hourly binary (Bitcoin Daily/hourly buckets)
 * - KXETHD  = ETH hourly binary
 * - KXSOLD  = SOL hourly binary
 * - KXXRPD  = XRP hourly binary (2026-09-21: verified 10 live markets)
 * - KXDOGED = DOGE hourly binary
 *
 * SOL and DOGE brackets are frequently between-resolution (all yes-prices
 * near 0 or 1); the RESOLVED_LO/RESOLVED_HI filter drops those and the
 * caller gets null → source silently skipped, no fake signal. Adding them
 * as first-class supported assets means when their brackets ARE live we
 * light up automatically without a code release.
 *
 * ## Failure handling
 *
 * Fail-open on any error. Kalshi occasionally rate-limits or returns
 * empty during market close (US hours). Signal-source diversity should
 * never halt the strategy.
 */
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min — hourly markets settle every hour

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  status: string;
  floor_strike?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  close_time?: string;
}

export interface KalshiSignal {
  /** ATM strike price (where yes_price ≈ 0.5) */
  atmStrike: number;
  /** Current spot for the underlying asset */
  spotPrice: number;
  /** Implied direction: ATM > spot means "market expects UP" */
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  /** Expected move as fraction: (ATM - spot) / spot */
  impliedMovePct: number;
  /** How many markets were sampled */
  marketCount: number;
  /** Confidence 0-100 based on strike-price spread + market count */
  confidence: number;
}

const cache = new Map<string, { signal: KalshiSignal | null; at: number }>();

export type KalshiAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE';

const SERIES_TICKER: Record<KalshiAsset, string> = {
  BTC: 'KXBTCD',
  ETH: 'KXETHD',
  SOL: 'KXSOLD',
  XRP: 'KXXRPD',
  DOGE: 'KXDOGED',
};

/**
 * Cache-key spot-bucket sizing per asset. Same-bucket spot movements hit
 * cache; big movements refetch. BTC $100 bucket = ~0.1% at $100K. Adapt
 * per asset so we don't cache a stale signal across a real move on lower-
 * priced coins.
 */
const SPOT_BUCKET: Record<KalshiAsset, number> = {
  BTC: 100,     // ~0.1% at $100K
  ETH: 10,      // ~0.3% at $3K
  SOL: 1,       // ~0.5% at $200
  XRP: 0.05,    // ~2.5% at $2 (thin, so refetch more)
  DOGE: 0.005,  // ~2% at $0.25
};

/** Fetch Kalshi crypto binary markets for the current 1-hour bracket and
 *  return an ATM-implied direction signal. Returns null when no active
 *  markets found or on any error (fail-open). */
export async function getKalshiSignal(
  asset: KalshiAsset,
  spotPrice: number,
): Promise<KalshiSignal | null> {
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  const bucket = SPOT_BUCKET[asset];
  const cacheKey = `${asset}:${Math.floor(spotPrice / bucket)}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.signal;

  const seriesTicker = SERIES_TICKER[asset];
  try {
    const resp = await fetch(
      `${KALSHI_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=100`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) {
      cache.set(cacheKey, { signal: null, at: now });
      return null;
    }
    const json = (await resp.json()) as { markets?: KalshiMarket[] };
    const markets = (json.markets ?? []).filter(
      (m) => m.floor_strike != null && m.status === 'active',
    );
    if (markets.length < 3) {
      cache.set(cacheKey, { signal: null, at: now });
      return null;
    }

    // Sort by strike ascending. For each market, compute the mid-price
    // between yes_bid and yes_ask. Find the strike whose yes-price is
    // closest to 0.5 — that's the ATM strike where the market is
    // roughly indifferent about above/below.
    //
    // 2026-09-21: filter effectively-resolved markets before ATM search.
    // Kalshi returns hourly brackets as `status='active'` for a short
    // window after resolution, with yes_bid=0 / yes_ask=$0.01 (below the
    // minimum tick). Direct API check at 12:57 UTC-4 for KXBTCD returned
    // 5 markets all at 0.00/0.01 — no live pricing, they'd resolved 3
    // min prior. Trusting these produced spurious `direction=DOWN` on
    // BTC because 89K strikes were far below $113K spot. Skip anything
    // with yes-price outside [0.02, 0.98] — that's "market has decided".
    // If the next hourly bracket is also in the payload (typical),
    // filtering leaves ~10-20 fresh markets for the ATM search.
    const RESOLVED_LO = 0.02;
    const RESOLVED_HI = 0.98;
    const sorted = markets
      .map((m) => {
        const bid = parseFloat(m.yes_bid_dollars ?? '0');
        const ask = parseFloat(m.yes_ask_dollars ?? '0');
        const mid = (bid + ask) / 2;
        return { strike: Number(m.floor_strike), yesPrice: mid };
      })
      .filter((m) => Number.isFinite(m.strike) && Number.isFinite(m.yesPrice))
      .filter((m) => m.yesPrice > RESOLVED_LO && m.yesPrice < RESOLVED_HI)
      .sort((a, b) => a.strike - b.strike);

    if (sorted.length < 3) {
      cache.set(cacheKey, { signal: null, at: now });
      return null;
    }

    // Find strike whose yes-price is closest to 0.5.
    let atmStrike = sorted[0].strike;
    let bestDist = Math.abs(sorted[0].yesPrice - 0.5);
    for (const m of sorted) {
      const d = Math.abs(m.yesPrice - 0.5);
      if (d < bestDist) {
        bestDist = d;
        atmStrike = m.strike;
      }
    }

    const impliedMovePct = (atmStrike - spotPrice) / spotPrice;
    const direction: 'UP' | 'DOWN' | 'NEUTRAL' =
      Math.abs(impliedMovePct) < 0.001
        ? 'NEUTRAL'
        : impliedMovePct > 0
          ? 'UP'
          : 'DOWN';

    // Confidence: higher when we have more markets sampled and when the
    // ATM strike is clearly above/below (not right at spot).
    const magnitudeScore = Math.min(Math.abs(impliedMovePct) * 500, 40); // caps at 8% move
    const sampleScore = Math.min(sorted.length * 2, 40);
    // ATM must be reasonably close to spot for the read to be reliable;
    // if all strikes are way off (e.g. spot $81k, strikes all $87k+),
    // we're not really measuring ATM — dampen confidence.
    const atmDistancePct = Math.abs(atmStrike - spotPrice) / spotPrice;
    const distancePenalty = atmDistancePct > 0.05 ? 20 : 0;
    const confidence = Math.max(20, Math.min(85, 40 + magnitudeScore + sampleScore - distancePenalty));

    const signal: KalshiSignal = {
      atmStrike,
      spotPrice,
      direction,
      impliedMovePct,
      marketCount: sorted.length,
      confidence,
    };
    cache.set(cacheKey, { signal, at: now });
    return signal;
  } catch (e) {
    logger.debug('[KalshiMarket] fetch failed (fail-open)', {
      asset, error: errMsg(e),
    });
    cache.set(cacheKey, { signal: null, at: now });
    return null;
  }
}
