/**
 * Orderbook imbalance signal from Binance perp L2 depth.
 *
 * Signal thesis: when top-of-book bid liquidity meaningfully exceeds ask
 * liquidity (or vice versa), directional pressure is building. The
 * imbalance ratio is the strongest short-term microstructure signal in
 * perps that's still available from a free public endpoint.
 *
 * Formula:
 *   imbalance = (bid_notional - ask_notional) / (bid_notional + ask_notional)
 *
 *   • +0.20 = 60% of top-N book depth is on the bid side (bullish)
 *   • -0.20 = 60% on the ask side (bearish)
 *   • [-0.10, +0.10] = balanced / noise
 *
 * Not a substitute for signal aggregation — one INDEPENDENT input added
 * to the aggregator's source pool. Cache 30s; Binance rate-limits at
 * 2400 req/min so we're safe even at 60s tick × 5 assets.
 */

import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';

export interface OrderbookImbalance {
  imbalance: number;       // [-1, +1] — signed depth ratio
  bidDepthUsd: number;
  askDepthUsd: number;
  midPrice: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30 * 1000;
const TOP_LEVELS = 20; // top 20 bid + 20 ask levels
const cache = new Map<string, OrderbookImbalance>();

/**
 * Fetch orderbook imbalance for a single asset from Binance perp.
 * Returns null on any error — caller falls through, doesn't block.
 */
export async function getOrderbookImbalance(asset: string): Promise<OrderbookImbalance | null> {
  const upper = asset.toUpperCase();
  const cached = cache.get(upper);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;

  try {
    const sym = `${upper}USDT`;
    const resp = await fetch(
      `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=${TOP_LEVELS * 5}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!resp.ok) return null;
    const json = await resp.json() as {
      bids?: [string, string][];
      asks?: [string, string][];
    };
    const bids = (json.bids ?? []).slice(0, TOP_LEVELS);
    const asks = (json.asks ?? []).slice(0, TOP_LEVELS);
    if (bids.length === 0 || asks.length === 0) return null;

    const bidDepthUsd = bids.reduce((sum, [p, q]) => sum + Number(p) * Number(q), 0);
    const askDepthUsd = asks.reduce((sum, [p, q]) => sum + Number(p) * Number(q), 0);
    const total = bidDepthUsd + askDepthUsd;
    if (total <= 0) return null;

    const imbalance = (bidDepthUsd - askDepthUsd) / total;
    // Mid price from top-of-book
    const midPrice = (Number(bids[0][0]) + Number(asks[0][0])) / 2;

    const result: OrderbookImbalance = {
      imbalance,
      bidDepthUsd,
      askDepthUsd,
      midPrice,
      fetchedAt: now,
    };
    cache.set(upper, result);
    return result;
  } catch (e) {
    logger.debug('[OrderbookImbalance] fetch failed (fail-open)', {
      asset, error: errMsg(e),
    });
    return null;
  }
}

/**
 * Batch fetch for the aggregator's parallel Promise.all call. Returns
 * a per-asset map (assets with fetch failures simply omitted).
 */
export async function fetchOrderbookImbalanceBatch(
  assets: string[],
): Promise<Record<string, OrderbookImbalance>> {
  const results = await Promise.all(
    assets.map(async (a) => [a.toUpperCase(), await getOrderbookImbalance(a)] as const),
  );
  const out: Record<string, OrderbookImbalance> = {};
  for (const [asset, data] of results) {
    if (data) out[asset] = data;
  }
  return out;
}
