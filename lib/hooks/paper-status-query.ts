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

/** Every paper book from its rows (`/api/paper-trader/books`). A failed answer is an error, never an empty table. */
export const paperBooksQuery = <T>() =>
  queryOptions({
    queryKey: ['paper-trader-books'],
    queryFn: async (): Promise<T> => {
      const r = await fetch('/api/paper-trader/books');
      const body = (await r.json().catch(() => null)) as (T & { success?: boolean; error?: string }) | null;
      if (!r.ok || !body || body.success === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      return body;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
