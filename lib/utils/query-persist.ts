/**
 * Keeps the dashboard's pool-wide reads across a reload.
 *
 * Why: fetched data lived in memory only, so every reload started from
 * skeletons and waited for each endpoint again. With this a reload paints
 * the numbers the visitor last saw and refreshes behind them.
 *
 * Limits, on purpose:
 *   - only the query keys listed here: pool-wide, public reads. Nothing
 *     keyed by a wallet, nothing about a visitor's own positions;
 *   - nothing older than MAX_AGE_MS is restored: an old number shown as
 *     current is worse than a skeleton;
 *   - a restored query keeps its real fetch time, so it counts as stale and
 *     is refetched as soon as a view mounts it.
 */
import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';

const STORAGE_KEY = 'zkward.queryCache.v1';
export const MAX_AGE_MS = 60 * 60_000;
export const PERSISTED_KEYS: readonly string[] = [
  'per-asset-signals',
  'solana-pool-status',
  'platform-risk-overview',
  'paper-trader-status',
  'dashboard-autonomy-status',
  'nav-history',
  'leaderboard',
  'health-gates',
  'spot-prices',
  'sui-pool',
  'community-pool',
];

const isPersisted = (queryKey: readonly unknown[]): boolean => typeof queryKey[0] === 'string' && PERSISTED_KEYS.includes(queryKey[0]);

export function saveQueries(client: QueryClient, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    const state = dehydrate(client, { shouldDehydrateQuery: (q) => q.state.status === 'success' && isPersisted(q.queryKey) });
    storage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), state }));
  } catch {
    /* storage full or blocked: the page works without it */
  }
}

export function restoreQueries(client: QueryClient, storage: Pick<Storage, 'getItem'> = localStorage, now: number = Date.now()): number {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const saved = JSON.parse(raw) as { state?: Partial<DehydratedState> };
    const queries = (saved.state?.queries ?? []).filter(
      (q) => Array.isArray(q.queryKey) && isPersisted(q.queryKey) && now - q.state.dataUpdatedAt <= MAX_AGE_MS && !client.getQueryData(q.queryKey),
    );
    hydrate(client, { queries, mutations: [] });
    return queries.length;
  } catch {
    return 0;
  }
}

/**
 * Restore once, then save when the tab is hidden or closed and every
 * minute. Call after hydration (in an effect): restoring before the first
 * render would make the client's HTML differ from the server's.
 */
export function persistQueryClient(client: QueryClient): () => void {
  restoreQueries(client);
  const save = () => saveQueries(client);
  const onHide = () => {
    if (document.visibilityState === 'hidden') save();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', save);
  const timer = setInterval(save, 60_000);
  return () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', save);
    clearInterval(timer);
  };
}
