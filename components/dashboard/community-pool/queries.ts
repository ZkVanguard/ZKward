import { queryOptions } from '@tanstack/react-query';

export interface SuiPoolVolatility {
  verifiedAth?: { sharePrice?: number } | null;
  range24h: { minSharePrice: number; maxSharePrice: number; minNav: number; maxNav: number } | null;
  since30d: { sharePrice: number; nav: number; at: string } | null;
  latest: { sharePrice: number; nav: number; at: string } | null;
}

/**
 * The SUI pool's volatility read: the verified all-time high the pool card
 * patches in, and the 24 h / 30 d context line. Defined once so both share
 * one request.
 */
export const suiPoolVolatilityQuery = (network: string) =>
  queryOptions({
    queryKey: ['sui-pool-volatility', network],
    queryFn: async (): Promise<SuiPoolVolatility> => {
      const res = await fetch(`/api/sui/community-pool?action=volatility&network=${network}`);
      const json = await res.json();
      if (!json?.success || !json.data) throw new Error('Volatility unavailable');
      return json.data as SuiPoolVolatility;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
