'use client';

import { useAccount } from '@/lib/evm-wallet/hooks';
import { useSuiSafe } from '@/app/sui-providers';
import { usePrivyEmbeddedAddress } from '@/lib/evm-wallet/usePrivyEmbeddedAddress';
import { useWalletHubSafe } from '@/contexts/WalletHubContext';

/**
 * The wallet of the user's ACTIVE network (see WalletHubContext): one chain
 * at a time. `address` / `chainType` describe that chain; the per-chain
 * fields are null unless that chain is the active one, so SUI/EVM-only
 * surfaces fall back to their prompt when the user is on another network.
 *
 * Without the hub (marketing routes) it degrades to SUI first, then EVM,
 * where the Hedera sign-in (Privy embedded wallet) is the primary EVM
 * identity and wagmi's injected address the fallback.
 */
export function useWallet() {
  const hub = useWalletHubSafe();
  const privyAddress = usePrivyEmbeddedAddress();
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount();
  const sui = useSuiSafe();

  const evmAddr = privyAddress ?? (wagmiAddress ? wagmiAddress.toString() : null);
  const evmConn = !!privyAddress || wagmiConnected;
  const suiAddr = sui?.address ?? null;
  const suiConn = sui?.isConnected ?? false;
  const suiBalance = sui?.balance ?? '0';
  const suiNetwork = sui?.network ?? 'testnet';

  const activeChain = hub ? hub.activeChain : suiConn ? 'sui' : evmConn ? 'hedera' : null;
  const isSUI = activeChain === 'sui' && suiConn;
  const isEVM = activeChain === 'hedera' && evmConn;
  const isSolana = activeChain === 'solana' && !!hub?.solana.connected;
  const address = isSUI ? suiAddr : isEVM ? evmAddr : isSolana ? hub?.solana.address ?? null : null;
  const chainType: 'sui' | 'evm' | 'solana' | null = isSUI ? 'sui' : isEVM ? 'evm' : isSolana ? 'solana' : null;

  return {
    // Active-chain state
    address,
    isConnected: !!address,
    chainType,

    // Per-chain state, only for the active chain
    evmAddress: isEVM ? evmAddr : null,
    evmConnected: isEVM,
    suiAddress: isSUI ? suiAddr : null,
    suiConnected: isSUI,
    suiBalance,
    suiNetwork,

    // Positions, hedges and risk exist for SUI and EVM wallets. On any other
    // active network these are null/false and the surface shows its guidance.
    portfolioAddress: isSUI ? suiAddr : isEVM ? evmAddr : null,
    hasPortfolioWallet: isSUI || isEVM,

    // Helpers
    isEVM,
    isSUI,
  };
}

/**
 * Type for the useWallet hook return value
 */
export type WalletState = ReturnType<typeof useWallet>;
