/**
 * Network Hooks
 * React hooks for network-aware utilities
 */

'use client';

import { useChainId } from '@/lib/evm-wallet/hooks';
import { useMemo } from 'react';

// ============================================
// CONSTANTS
// ============================================

export const CHAIN_IDS = {
  CRONOS_MAINNET: 25,
  CRONOS_TESTNET: 338,
  CRONOS_ZKEVM: 388,
} as const;

export const EXPLORER_URLS: Record<number, string> = {
  [CHAIN_IDS.CRONOS_MAINNET]: 'https://explorer.cronos.org',
  [CHAIN_IDS.CRONOS_TESTNET]: 'https://explorer.cronos.org/testnet',
  [CHAIN_IDS.CRONOS_ZKEVM]: 'https://explorer.zkevm.cronos.org',
};

// ============================================
// HOOKS
// ============================================

/**
 * Hook to get the explorer base URL for the current chain
 */
export function useExplorerUrl(): string {
  const chainId = useChainId();
  return useMemo(() => {
    return EXPLORER_URLS[chainId] || EXPLORER_URLS[CHAIN_IDS.CRONOS_TESTNET];
  }, [chainId]);
}
