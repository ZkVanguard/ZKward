'use client';

// MUST be imported first - sets up BigInt serialization and fetch interceptor
import './api-interceptor';

import { ReactNode, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider as CustomThemeProvider } from '../contexts/ThemeContext';
import { installClientErrorReporter } from '../lib/utils/client-error-reporter';
import { persistQueryClient } from '../lib/utils/query-persist';

// Light-weight providers used across every route (marketing + app).
// Wallet-heavy providers (SuiWalletProviders — ~800 KB of @mysten SDKs)
// live in app/wallet-providers.tsx and only wrap /dashboard/**.
// See dashboard/layout.tsx.

// The one data cache for the whole app, the wallet libraries' queries
// included. A query that is still fresh is served from the cache on mount;
// a stale one (or one restored from the browser after a reload) is shown at
// once and refetched behind it. Polling queries pause while the tab is
// hidden (TanStack's default).
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 600_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

// Concurrency-correct QueryClient factory (Tanstack's recommended SSR
// pattern). On the SERVER, always return a fresh client — a module-level
// singleton would be reused across concurrent SSR renders in the same
// Node process, leaking one user's cached queries into another's HTML.
// On the CLIENT, memoise on the first call so React re-renders share
// the same cache. `typeof window === 'undefined'` is the standard SSR
// branch; safe here because this file is 'use client' and this branch
// executes only during Next's initial server render of the client tree.
let browserQueryClient: QueryClient | undefined;
function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient();
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  useEffect(() => installClientErrorReporter(), []);
  // After hydration, so the first client render matches the server's.
  useEffect(() => persistQueryClient(queryClient), [queryClient]);

  return (
    <CustomThemeProvider>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </CustomThemeProvider>
  );
}
