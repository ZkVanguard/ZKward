'use client';

/**
 * Whether the SUI pool contract accepts deposits and withdrawals right now
 * (`/api/sui/community-pool?action=availability`). A failed read leaves it
 * unknown: the page then says nothing rather than guess either way.
 */
import { useQuery } from '@tanstack/react-query';

export interface PoolAvailability {
  blocked: boolean;
  /** Minutes since the pool's value was last confirmed on chain; null when it never was. */
  ageMin: number | null;
}

async function fetchPoolAvailability(network: string): Promise<PoolAvailability> {
  const res = await fetch(`/api/sui/community-pool?action=availability&network=${encodeURIComponent(network)}`);
  if (!res.ok) throw new Error(`pool availability returned ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: PoolAvailability };
  if (!json.success || !json.data) throw new Error('pool availability unavailable');
  return json.data;
}

export function usePoolAvailability(network: string | null) {
  return useQuery({
    queryKey: ['sui-pool-availability', network],
    queryFn: () => fetchPoolAvailability(network as string),
    enabled: !!network,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
