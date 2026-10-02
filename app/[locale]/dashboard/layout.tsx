'use client';

// Provider wrapping for /dashboard. WalletProviders (SuiWalletProviders
// — ~800 KB of @mysten/dapp-kit + @mysten/sui) live here instead of
// root providers so marketing routes (/, /agents, /zk, /rwa,
// /whitepaper) don't pay the bundle cost.

import type { ReactNode } from 'react';
import { PositionsProvider } from '@/contexts/PositionsContext';
import { AIDecisionsProvider } from '@/contexts/AIDecisionsContext';
import { WalletProviders } from '@/app/wallet-providers';
import { WalletHubProvider } from '@/contexts/WalletHubContext';
import { Navbar } from '@/components/Navbar';

// Navbar rendered here (not in the parent locale layout) so ConnectButton's
// wagmi hooks find WalletProviders in the tree. NavbarSwitch hides the
// parent Navbar on /dashboard to keep only one navbar visible.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProviders>
      <WalletHubProvider>
        <Navbar />
        <PositionsProvider>
          <AIDecisionsProvider>
            {children}
          </AIDecisionsProvider>
        </PositionsProvider>
      </WalletHubProvider>
    </WalletProviders>
  );
}
