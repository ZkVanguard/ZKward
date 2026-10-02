'use client';

import { useAccount } from '@/lib/evm-wallet/hooks';
import { useSuiSafe } from '@/app/sui-providers';
import { usePrivyEmbeddedAddress } from '@/lib/evm-wallet/usePrivyEmbeddedAddress';

/**
 * Unified wallet hook that works with both EVM (Cronos) and SUI wallets.
 * Use this hook when you need to support both chains.
 * 
 * Priority: SUI wallet takes precedence if connected, otherwise falls back to EVM.
 */
export function useWallet() {
  // EVM wallet state. The Hedera sign-in (Privy embedded wallet) is the
  // primary EVM identity; wagmi's injected address is the fallback for the
  // few surfaces that sign with it.
  const privyAddress = usePrivyEmbeddedAddress();
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount();
  const evmAddress = privyAddress ?? wagmiAddress;
  const evmConnected = !!privyAddress || wagmiConnected;
  
  // SUI wallet state (safely handle if not in provider - returns null)
  const sui = useSuiSafe();
  const suiAddress = sui?.address ?? null;
  const suiConnected = sui?.isConnected ?? false;
  const suiBalance = sui?.balance ?? '0';
  const suiNetwork = sui?.network ?? 'testnet';
  
  // Combined state - SUI takes priority if connected
  const isConnected = suiConnected || evmConnected;
  const address = suiConnected ? suiAddress : (evmAddress ? evmAddress.toString() : null);
  const chainType = suiConnected ? 'sui' : (evmConnected ? 'evm' : null);
  
  return {
    // Combined state
    address,
    isConnected,
    chainType,
    
    // Individual chain states
    evmAddress: evmAddress ? evmAddress.toString() : null,
    evmConnected,
    suiAddress,
    suiConnected,
    suiBalance,
    suiNetwork,
    
    // Helpers
    isEVM: evmConnected && !suiConnected,
    isSUI: suiConnected,
  };
}

/**
 * Type for the useWallet hook return value
 */
export type WalletState = ReturnType<typeof useWallet>;
