import { queryOptions } from '@tanstack/react-query';

/** The paper books' status, shared by the dashboard panel and the paper page. */
export const paperStatusQuery = <T>() =>
  queryOptions({
    queryKey: ['paper-trader-status'],
    queryFn: async (): Promise<T> => {
      const r = await fetch('/api/paper-trader/status');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as T;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
