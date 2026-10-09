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
import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider as PrivyWagmiProvider } from '@privy-io/wagmi';
import { getWagmiConfig } from '@/lib/evm-wallet/wagmi-config';
import { isPrivyEnabled, getPrivyAppId } from '@/lib/evm-wallet/privy-config';
import { buildPrivyClientConfig } from '@/lib/evm-wallet/privy-client-config';
import { SuiWalletProviders } from './sui-providers';

export function WalletProviders({ children }: { children: ReactNode }) {
  // Wallet queries use the app's one QueryClient (app/providers.tsx), so a
  // reload restores and dedupes them with everything else.
  const wagmiConfig = getWagmiConfig();
  const privy = isPrivyEnabled();

  // Base tree without Privy — plain wagmi + SUI.
  const baseTree = <SuiWalletProviders>{children}</SuiWalletProviders>;

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
  // PrivyProvider wraps the whole thing so its React context is available
  // to Privy hooks anywhere below.
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
