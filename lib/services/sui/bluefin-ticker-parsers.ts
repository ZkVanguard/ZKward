/**
 * Pure parsers for BlueFin Pro `/v1/exchange/ticker` response fields.
 *
 * Extracted from BluefinService so the encoding logic — which has bitten
 * us twice (E9 vs base × 1e9 vs USD × 1e9 confusion) — has a golden-test
 * net independent of the heavy BluefinService class (which needs SUI auth
 * + wallet to instantiate).
 */

export interface TickerOiSnapshot {
  /** USD value, undefined when unavailable or sanity-checked away */
  openInterestUsd?: number;
  /** Diagnostic — populated when the sanity check rejected the value */
  rejectedReason?: string;
}

/**
 * Parse open interest from a BlueFin ticker response.
 *
 * BlueFin Pro SDK type docs (api.d.ts:4981) document openInterestE9 as
 * "Open interest VALUE (e9 format)" — i.e. USD × 1e9, NOT base-asset
 * count × 1e9. Earlier code (pre-2026-06-01) divided by 1e9 then
 * multiplied by price, inflating BTC OI ~71,000× (real $1.66M reported
 * as $117B).
 *
 * The non-E9 fallback `openInterest` is assumed to already be a USD
 * value (rare on Pro; included for forward compatibility).
 *
 * Sanity check: if parsed OI > 10,000× the 24h quote volume, treat as
 * unreliable (likely test data or schema drift) and return undefined
 * + a diagnostic reason. The T3-B OI guard will then skip that symbol
 * rather than approve any hedge size.
 */
export function parseTickerOpenInterest(
  ticker: {
    openInterestE9?: string;
    openInterest?: string;
    quoteVolume24hrE9?: string;
  },
  price: number
): TickerOiSnapshot {
  if (!ticker || !(price > 0)) return {};
  const oiRaw = ticker.openInterestE9 ?? ticker.openInterest;
  if (!oiRaw) return {};
  const oiHasE9Suffix = !!ticker.openInterestE9;
  const parsed = parseFloat(oiRaw);
  if (!Number.isFinite(parsed) || parsed <= 0) return {};
  const openInterestUsd = oiHasE9Suffix ? parsed / 1e9 : parsed;

  // Sanity floor against 24h quote volume (USD × 1e9).
  const rawQuoteVol = ticker.quoteVolume24hrE9;
  if (typeof rawQuoteVol === 'string') {
    const quoteVol24Usd = parseFloat(rawQuoteVol) / 1e9;
    if (
      Number.isFinite(quoteVol24Usd) &&
      quoteVol24Usd > 0 &&
      openInterestUsd > quoteVol24Usd * 10_000
    ) {
      return {
        openInterestUsd: undefined,
        rejectedReason: `OI $${openInterestUsd.toFixed(0)} is ${(openInterestUsd / quoteVol24Usd).toFixed(0)}× 24h volume $${quoteVol24Usd.toFixed(2)} — implausibly large`,
      };
    }
  }

  return { openInterestUsd };
}

export interface AccountPositionFields {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  margin: number;
  marginRatio: number;
}

/**
 * Parse one position from the BlueFin Pro account response.
 *
 * Size comes from the venue's own `sizeE9`. It used to be derived as
 * margin x leverage / entry price, but the venue marks margin to the
 * CURRENT price, so that figure drifts with every move away from entry:
 * a 0.01 ETH short entered at $2,016 read as 0.0136 ETH at a $2,756 mark
 * (36% over), and it would read under the order step, and so unclosable,
 * on a move the other way. The derivation is kept only for a response
 * without the field, against the mark price.
 */
export function parseAccountPosition(p: Record<string, unknown>): AccountPositionFields {
  const e9 = (v: unknown): number => {
    const n = parseFloat(String(v ?? '0'));
    return Number.isFinite(n) ? n / 1e9 : 0;
  };
  const entryPrice = e9(p.avgEntryPriceE9);
  const markPrice = e9(p.markPriceE9);
  const leverage = e9(p.leverageE9) || 1;
  const margin = e9(p.initialMarginE9);
  const refPrice = markPrice > 0 ? markPrice : entryPrice;
  const size = Math.abs(e9(p.sizeE9)) || (refPrice > 0 ? (margin * leverage) / refPrice : 0);
  const maintMargin = e9(p.maintenanceMarginE9);
  return {
    symbol: String(p.symbol ?? ''),
    side: String(p.side ?? '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
    size,
    leverage,
    entryPrice,
    markPrice,
    liquidationPrice: e9(p.liquidationPriceE9 ?? p.estimatedLiquidationPriceE9),
    unrealizedPnl: e9(p.unrealizedPnlE9),
    margin,
    marginRatio: margin > 0 ? maintMargin / margin : 0,
  };
}
