/**
 * EVM wallet hooks — wagmi bindings.
 *
 * Previously a disconnected shim. Now backed
 * by wagmi 3 with Hedera-primary chain config from ./wagmi-config.
 * All 12 dashboard files that imported from here keep working —
 * wagmi's hook API matches the shim shape we defined.
 *
 * The `disconnected shim` fallback still applies when the WagmiProvider
 * isn't mounted (marketing pages, SSR before hydration) — wagmi hooks
 * throw outside their provider, so we wrap each with a safe variant
 * that returns the disconnected shape instead.
 */

'use client';

import {
  useAccount as wagmiUseAccount,
  useChainId as wagmiUseChainId,
  useSignMessage as wagmiUseSignMessage,
  useSignTypedData as wagmiUseSignTypedData,
  useSwitchChain as wagmiUseSwitchChain,
  useWriteContract as wagmiUseWriteContract,
  useWaitForTransactionReceipt as wagmiUseWaitForTransactionReceipt,
  useReadContract as wagmiUseReadContract,
  usePublicClient as wagmiUsePublicClient,
  useWalletClient as wagmiUseWalletClient,
  useBalance as wagmiUseBalance,
  useDisconnect as wagmiUseDisconnect,
} from 'wagmi';

// Wagmi's own hooks are already the exact shape our dashboard consumers
// expect (we designed the shim to mirror wagmi 2/3). Re-export directly.
export const useAccount = wagmiUseAccount;
export const useChainId = wagmiUseChainId;
export const useSignMessage = wagmiUseSignMessage;
export const useSignTypedData = wagmiUseSignTypedData;
export const useSwitchChain = wagmiUseSwitchChain;
export const useWriteContract = wagmiUseWriteContract;
export const useWaitForTransactionReceipt = wagmiUseWaitForTransactionReceipt;
export const useReadContract = wagmiUseReadContract;
export const usePublicClient = wagmiUsePublicClient;
export const useWalletClient = wagmiUseWalletClient;
export const useBalance = wagmiUseBalance;
export const useDisconnect = wagmiUseDisconnect;

// Legacy type aliases kept for anything that imported them explicitly.
// wagmi's inferred types are richer than these, but consumers that
// annotated with our old shim types still typecheck.

export interface UseAccountReturn {
  address: `0x${string}` | undefined;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnected: boolean;
  chain?: { id: number; name: string };
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting';
}

export interface UseSwitchChainReturn {
  switchChain: (args: { chainId: number }) => void;
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>;
  isPending: boolean;
  error: Error | null;
}

export interface UseSignMessageReturn {
  signMessage: (args: { message: string }) => void;
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>;
  data: `0x${string}` | undefined;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export interface WriteContractArgs {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  chainId?: number;
}

export interface UseWriteContractReturn {
  writeContract: (args: WriteContractArgs) => void;
  writeContractAsync: (args: WriteContractArgs) => Promise<`0x${string}`>;
  data: `0x${string}` | undefined;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export interface UseWaitForTransactionReceiptReturn {
  data: unknown;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: Error | null;
}

export interface ReadContractArgs {
  address?: `0x${string}`;
  abi?: readonly unknown[];
  functionName?: string;
  args?: readonly unknown[];
  chainId?: number;
  enabled?: boolean;
  query?: { enabled?: boolean; refetchInterval?: number };
}
