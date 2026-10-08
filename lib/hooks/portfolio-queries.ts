import { queryOptions } from '@tanstack/react-query';

/**
 * Per-wallet portfolio reads, defined once so every view that shows them
 * shares one cache entry and one request. Both pause while the tab is
 * hidden and refresh when it is shown again.
 */

export interface WalletPosition {
  symbol: string;
  balance: string;
  balanceUSD: string;
  price: string;
  change24h: number;
  high24h?: number;
  low24h?: number;
  volatility?: number;
}

export interface WalletPositions {
  address: string;
  totalValue: number;
  positions: WalletPosition[];
  lastUpdated: number;
}

export interface UnifiedPortfolio {
  totals?: { unrealizedPnl?: number; unrealizedPnlPct?: number; activeHedgeCount?: number };
  hedgeExposure?: unknown[];
}

export const positionsQuery = (address: string | null | undefined) =>
  queryOptions({
    queryKey: ['positions', address],
    queryFn: async (): Promise<WalletPositions> => {
      const res = await fetch(`/api/positions?address=${encodeURIComponent(address ?? '')}`);
      if (!res.ok) throw new Error(`Failed to fetch positions: ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data as WalletPositions;
    },
    enabled: !!address,
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

export const unifiedPortfolioQuery = (address: string | null | undefined) =>
  queryOptions({
    queryKey: ['unified-portfolio', address],
    queryFn: async ({ signal }): Promise<UnifiedPortfolio> => {
      const res = await fetch(`/api/portfolio/unified?wallet=${encodeURIComponent(address ?? '')}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as UnifiedPortfolio;
    },
    enabled: !!address,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
