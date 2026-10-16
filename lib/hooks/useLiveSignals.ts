'use client';

/**
 * The per-asset aggregate signal for every browser view: one React Query
 * entry over /api/predictions/per-asset with no query string, so the page
 * makes one request and the CDN keeps one entry. Views that asked for their
 * own asset list each paid a separate cold aggregator scan of about 10 s.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchExpectedMoves, fetchPerAssetSignals } from '@/lib/api/market-signals';
import type { PerAssetSignal, Scorecard } from '@/lib/types/market-signals';

type SignalsMap = Record<string, PerAssetSignal>;

export function usePerAssetSignals() {
  return useQuery({
    queryKey: ['per-asset-signals'],
    queryFn: () => fetchPerAssetSignals(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** The move the prediction market prices per coin. It changes slowly, so it is read far less often than the signals. */
export function useExpectedMoves() {
  return useQuery({
    queryKey: ['expected-moves'],
    queryFn: () => fetchExpectedMoves(),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/** The daily ladder's forecasts against what happened. New results arrive once a day. */
export function useLadderScorecard() {
  return useQuery({
    queryKey: ['ladder-scorecard'],
    queryFn: async (): Promise<Scorecard> => {
      const res = await fetch('/api/predictions/ladder-scorecard');
      if (!res.ok) throw new Error(`ladder scorecard returned ${res.status}`);
      const json = (await res.json()) as { success?: boolean; scorecard?: Scorecard };
      if (!json.success || !json.scorecard) throw new Error('ladder scorecard unavailable');
      return json.scorecard;
    },
    staleTime: 10 * 60_000,
  });
}

/** The same read narrowed to `assets`; an asset the aggregator does not track is absent (no signal). */
export function useLiveSignals(assets: readonly string[]) {
  const q = usePerAssetSignals();
  const data = q.data
    ? (Object.fromEntries(assets.map((a) => a.toUpperCase()).filter((a) => q.data[a]).map((a) => [a, q.data[a]])) as SignalsMap)
    : undefined;
  return { ...q, data };
}
