'use client';

// MUST be imported first - sets up BigInt serialization and fetch interceptor
import './api-interceptor';

import { ReactNode, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider as CustomThemeProvider } from '../contexts/ThemeContext';
import { installClientErrorReporter } from '../lib/utils/client-error-reporter';

// Light-weight providers used across every route (marketing + app).
// Wallet-heavy providers (SuiWalletProviders — ~800 KB of @mysten SDKs)
// live in app/wallet-providers.tsx and only wrap /dashboard/**.
// See dashboard/layout.tsx.

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,                      // Reduced from 2: fail fast for faster UX
        staleTime: 120_000,            // 2 minutes
        gcTime: 600_000,               // 10 minutes
        refetchOnMount: false,
        refetchOnReconnect: false,
        networkMode: 'offlineFirst',   // Use cache while offline, reduces refetches
      },
      mutations: {
        retry: 1,
        networkMode: 'offlineFirst',
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

  return (
    <CustomThemeProvider>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </CustomThemeProvider>
  );
}
