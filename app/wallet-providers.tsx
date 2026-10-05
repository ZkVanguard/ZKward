'use client';

// Wallet providers — Privy → WagmiProvider → SuiWalletProviders.
// Extracted from app/providers.tsx so the wallet SDK bundle only mounts
// inside /dashboard, not on marketing routes.
//
// Hackathon pivot (2026-09-04): Hedera is now the primary chain. Wagmi
// config in lib/evm-wallet/wagmi-config.ts orders Hedera Testnet first.
// SUI stays live as the secondary optional path.
//
// Privy layer (2026-09-05, hackathon Priority 3): when NEXT_PUBLIC_PRIVY_APP_ID
// is set, Privy wraps wagmi with email/social login + embedded EVM wallets.
// When unset, we skip the wrapper and use wagmi's injected connectors alone
// (identical behavior to what we shipped last commit).

import type { ReactNode } from 'react';
import { WagmiProvider as WagmiProviderRaw } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider as PrivyWagmiProvider } from '@privy-io/wagmi';
import { getWagmiConfig } from '@/lib/evm-wallet/wagmi-config';
import { isPrivyEnabled, getPrivyAppId } from '@/lib/evm-wallet/privy-config';
import { buildPrivyClientConfig } from '@/lib/evm-wallet/privy-client-config';
import { SuiWalletProviders } from './sui-providers';
import { persistQueryClient } from '@/lib/utils/query-persist';

export function WalletProviders({ children }: { children: ReactNode }) {
  // React Query client for wagmi — separate from the app-level one to
  // isolate wallet queries from dashboard data queries.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
    },
  }));

  // After hydration, so the first client render matches the server's.
  useEffect(() => persistQueryClient(queryClient), [queryClient]);

  const wagmiConfig = getWagmiConfig();
  const privy = isPrivyEnabled();

  // Base tree without Privy — plain wagmi + query client + SUI.
  const baseTree = (
    <QueryClientProvider client={queryClient}>
      <SuiWalletProviders>{children}</SuiWalletProviders>
    </QueryClientProvider>
  );

  if (!privy) {
    // No Privy configured — mount wagmi directly (previous behavior).
    return (
      <WagmiProviderRaw config={wagmiConfig}>
        {baseTree}
      </WagmiProviderRaw>
    );
  }

  // Privy layered on top of wagmi. @privy-io/wagmi's WagmiProvider is
  // a drop-in for wagmi's own — it exposes the same hooks but the
  // signer can now be a Privy embedded wallet (email/social login).
  //
  // The QueryClientProvider still lives INSIDE the wagmi provider so
  // wagmi's built-in queries pick it up; PrivyProvider wraps the whole
  // thing so its React context is available to Privy hooks anywhere
  // below.
  return (
    <PrivyProvider
      appId={getPrivyAppId()}
      config={buildPrivyClientConfig() as never}
    >
      <PrivyWagmiProvider config={wagmiConfig}>
        {baseTree}
      </PrivyWagmiProvider>
    </PrivyProvider>
  );
}
