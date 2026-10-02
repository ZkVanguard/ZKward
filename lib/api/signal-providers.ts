/**
 * The providers the signal stack reads, for the UI: their logos under
 * `public/logos/sources/`, their role, and a mapping from a source's name in
 * a prediction payload to the provider behind it. Shared by the landing
 * strip and the dashboard's market board so the two never drift apart.
 */
export type ProviderRole = 'predictionMarket' | 'perpetuals' | 'options' | 'spot' | 'venue';

export interface SignalProvider {
  name: string;
  slug: string;
  role: ProviderRole;
  href: string;
  /** Intrinsic aspect ratio of the wordmark (width / height). */
  ratio: number;
  /** A mark-only logo gets the brand name set beside it. */
  markOnly?: boolean;
}

/** Markets first, then the exchanges behind the microstructure sources. */
export const SIGNAL_PROVIDERS: readonly SignalProvider[] = [
  { name: 'Polymarket', slug: 'polymarket', role: 'predictionMarket', href: 'https://polymarket.com', ratio: 911 / 168 },
  { name: 'Kalshi', slug: 'kalshi', role: 'predictionMarket', href: 'https://kalshi.com', ratio: 772 / 226 },
  { name: 'Manifold', slug: 'manifold', role: 'predictionMarket', href: 'https://manifold.markets', ratio: 1, markOnly: true },
  { name: 'Binance', slug: 'binance', role: 'perpetuals', href: 'https://www.binance.com', ratio: 632 / 127 },
  { name: 'Bybit', slug: 'bybit', role: 'perpetuals', href: 'https://www.bybit.com', ratio: 13547 / 4513 },
  { name: 'Deribit', slug: 'deribit', role: 'options', href: 'https://www.deribit.com', ratio: 4000 / 1201 },
  { name: 'Crypto.com', slug: 'crypto-com', role: 'spot', href: 'https://crypto.com/exchange', ratio: 120 / 24 },
  { name: 'BlueFin', slug: 'bluefin', role: 'venue', href: 'https://bluefin.io', ratio: 83 / 18 },
];

export const logoPath = (p: SignalProvider): string => `/logos/sources/${p.slug}.svg`;

/** Source names are set in the aggregator (`Polymarket 5-Min BTC`, `Orderbook ETH depth-imbalance`, `Options-skew BTC …`). */
const BY_NAME: Array<[RegExp, string]> = [
  [/^polymarket/i, 'polymarket'],
  [/^kalshi/i, 'kalshi'],
  [/^manifold/i, 'manifold'],
  [/^(binance|orderbook)/i, 'binance'],
  [/^bybit/i, 'bybit'],
  [/^options-skew/i, 'deribit'],
  [/^crypto\.com/i, 'crypto-com'],
  [/^bluefin/i, 'bluefin'],
];

/** The provider behind a source name, or null for derived sources (AI readings, themes, cross-asset alignment). */
export function providerForSource(sourceName: string): SignalProvider | null {
  const hit = BY_NAME.find(([re]) => re.test(sourceName));
  return hit ? SIGNAL_PROVIDERS.find((p) => p.slug === hit[1]) ?? null : null;
}
