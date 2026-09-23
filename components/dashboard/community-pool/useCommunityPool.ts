/**
 * useCommunityPool Hook
 * Centralized state management and data fetching for CommunityPool
 * Uses useReducer for complex state to minimize re-renders
 *
 * OPTIMIZATIONS:
 * - useReducer for batched state updates (minimizes re-renders)
 * - useMemo for expensive derived values
 * - useCallback for stable function references
 * - startTransition for non-urgent state updates
 * - Optimistic UI updates for better perceived performance
 * - Debounced input handlers
 *
 * NOTE: Now uses Tether WDK natively
 */

'use client';

import { useReducer, useCallback, useRef, useEffect, useMemo, startTransition } from 'react'; // WDK hooks
import {
  useAccount,
  useChainId,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSignMessage,
  useReadContract,
  useSwitchChain,
  useSignTypedData,
} from '@/lib/evm-wallet/hooks';
import { useSmartAccount } from '@/lib/evm-wallet/smart-account';
import { parseUnits, formatUnits } from 'viem';
import { ethers } from 'ethers';
import { logger } from '@/lib/utils/logger';
import { usePolling } from '@/lib/hooks';
import { useSuiSafe } from '@/app/sui-providers';
import { useWdkSafe } from '@/lib/evm-wallet/context';
import {
  POOL_CHAIN_CONFIGS,
  getCommunityPoolAddress,
  getUsdtAddress,
  isPoolDeployed,
  COMMUNITY_POOL_ABI,
} from '@/lib/contracts/community-pool-config';
import { getNetworkFromChainId, getValidChainIds } from './utils';
import type { ChainKey, TxStatus } from './types';
import { poolReducer, txReducer, initialPoolState, initialTxState } from './reducers';
import { mapApiToPoolSummary, mapApiToUserPosition } from './mappers'; // ============================================================================
// HOOK
// ============================================================================

export function useCommunityPool(propAddress?: string) {
  const [poolState, dispatchPool] = useReducer(poolReducer, initialPoolState);
  const [txState, dispatchTx] = useReducer(txReducer, initialTxState);

  const mountedRef = useRef(true);
  const lastFetchRef = useRef<number>(0);
  const userSelectedChainRef = useRef(false);
  // Track pending action after chain switch (auto-retry)
  const pendingChainSwitchRef = useRef<{
    action: 'deposit' | 'withdraw';
    targetChainId: number;
  } | null>(null);
  // Skip chain check after successful wallet switch (WDK may not sync immediately)
  const skipChainCheckRef = useRef(false);
  // Preserve deposit amount during chain switch (UI state may be lost)
  const pendingDepositAmountRef = useRef<string>('');

  // WDK hooks
  const { address: connectedAddress, isConnected, chain } = useAccount();
  // propAddress may be an EVM address supplied by the parent (e.g. Privy's
  // embedded-wallet address when the user signed in with email/Google).
  // Falling back to the wagmi-connected address keeps external-wallet users
  // (MetaMask etc.) working unchanged.
  const address = (propAddress || connectedAddress) as `0x${string}` | undefined;
  const wdkChainId = useChainId();
  const chainId = chain?.id ?? wdkChainId;
  const { signMessageAsync } = useSignMessage();
  const {
    writeContract,
    writeContractAsync,
    data: txHash,
    isPending,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  });
  const { switchChainAsync } = useSwitchChain();

  // Debug: Track transaction state changes (only log when values actually matter)
  useEffect(() => {
    if (txHash || isPending || isConfirming || txState.txStatus !== 'idle') {
      console.log('[TX STATE]', {
        txHash: txHash ? `${txHash.slice(0, 10)}...` : null,
        isPending,
        isConfirming,
        isConfirmed,
        txStatus: txState.txStatus,
        writeError: writeError?.message || null,
      });
    }
  }, [txHash, isPending, isConfirming, isConfirmed, txState.txStatus, writeError]);

  // SUI hooks
  const suiContext = useSuiSafe();
  const suiAddress = suiContext?.address ?? null;
  const suiIsConnected = suiContext?.isConnected ?? false;
  const suiBalance = suiContext?.balance ?? '0';
  const suiExecuteTransaction = suiContext?.executeTransaction;
  const suiSponsoredExecute = suiContext?.sponsoredExecute;
  const suiNetwork = suiContext?.network ?? 'testnet';
  const suiIsWrongNetwork = suiContext?.isWrongNetwork ?? false;
  const _suiSetNetwork = suiContext?.setNetwork;

  // WDK chain support check (treasury wallet is server-side)
  const wdkContext = useWdkSafe();
  const _isWdkChainSupported = wdkContext?.isChainSupported;

  // Derived values
  const { selectedChain } = poolState;
  const chainConfig = POOL_CHAIN_CONFIGS[selectedChain];
  // For SUI, network comes from SuiContext (defaults to mainnet via env). For EVM,
  // derive from wallet chainId; fall back to mainnet for SUI-only deployments.
  const detectedNetwork: 'mainnet' | 'testnet' =
    selectedChain === 'sui'
      ? suiNetwork === 'mainnet'
        ? 'mainnet'
        : 'testnet'
      : chainId
        ? getNetworkFromChainId(chainId)
        : 'mainnet';
  const network: 'mainnet' | 'testnet' = isPoolDeployed(selectedChain, detectedNetwork)
    ? detectedNetwork
    : detectedNetwork;
  const USDT_ADDRESS = getUsdtAddress(selectedChain, network);
  const COMMUNITY_POOL_ADDRESS = getCommunityPoolAddress(selectedChain, network);
  const poolDeployed = isPoolDeployed(selectedChain, network);

  // Determine active wallet type: 'evm' | 'sui' | null
  // Note: WDK treasury is server-side, users connect via WDK self-custodial wallet
  const activeWalletType = useMemo((): 'evm' | 'sui' | null => {
    if (selectedChain === 'sui' && suiIsConnected) return 'sui';
    if (isConnected && address) return 'evm';
    return null;
  }, [selectedChain, suiIsConnected, isConnected, address]);

  // Effective address based on active wallet
  const _effectiveAddress = useMemo(() => {
    if (activeWalletType === 'sui') return suiAddress;
    return address;
  }, [activeWalletType, suiAddress, address]);

  // User's USDT balance (show how much they can deposit) - keep this for UI
  const { data: userUsdtBalance } = useReadContract({
    address: USDT_ADDRESS,
    abi: [
      {
        name: 'balanceOf',
        type: 'function',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
      },
    ],
    functionName: 'balanceOf',
    args: address ? [address as `0x${string}`] : undefined,
    query: {
      // Skip when the token contract isn't deployed on this chain
      // (Hedera testnet USDT is 0x0000... today. A balanceOf call
      // there is a wasted network round-trip that also spams the
      // console with revert errors from wagmi's ReadContractError).
      enabled: !!address
        && !!USDT_ADDRESS
        && USDT_ADDRESS !== '0x0000000000000000000000000000000000000000'
        && selectedChain !== 'sui',
    },
  });

  // Typed data signing hook for EIP-2612 permit
  const { signTypedDataAsync } = useSignTypedData();

  // Account Abstraction (Gasless) support
  const { depositWithGasless } = useSmartAccount();

  // First-deposit gate: assumed false. API enforces the $100 inflation-attack
  // minimum server-side, so the client can render without an extra RPC round-trip.
  const isFirstDeposit = false;

  // Helper to lazily fetch permit details only when needed
  const getPermitDetails = useCallback(
    async (tokenAddress: string, walletAddress: string, _chainId: number) => {
      try {
        const { ethers } = await import('ethers');
        const chainConfig = POOL_CHAIN_CONFIGS[selectedChain];
        const rpcUrl = chainConfig?.rpcUrls[network] || 'https://rpc.sepolia.org';
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        const erc20 = new ethers.Contract(
          tokenAddress,
          [
            'function nonces(address) view returns (uint256)',
            'function name() view returns (string)',
            'function DOMAIN_SEPARATOR() view returns (bytes32)',
          ],
          provider
        );

        const [nonce, name, domainSeparator] = await Promise.all([
          erc20.nonces(walletAddress).catch(() => null),
          erc20.name().catch(() => null),
          erc20.DOMAIN_SEPARATOR().catch(() => null),
        ]);

        return {
          nonce: nonce ? BigInt(nonce) : undefined,
          name,
          domainSeparator,
          supported: !!nonce && !!domainSeparator,
        };
      } catch (e) {
        console.warn('Failed to fetch permit details', e);
        return { supported: false };
      }
    },
    [selectedChain, network]
  );

  // Helper to lazily fetch allowance
  const getAllowance = useCallback(
    async (tokenAddress: string, owner: string, spender: string) => {
      try {
        const { ethers } = await import('ethers');
        const chainConfig = POOL_CHAIN_CONFIGS[selectedChain];
        const rpcUrl = chainConfig?.rpcUrls[network] || 'https://rpc.sepolia.org';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const erc20 = new ethers.Contract(
          tokenAddress,
          ['function allowance(address,address) view returns (uint256)'],
          provider
        );
        const allowance = await erc20.allowance(owner, spender);
        return BigInt(allowance);
      } catch (e) {
        console.warn('Failed to fetch allowance', e);
        return BigInt(0);
      }
    },
    [selectedChain, network]
  );

  // Derived: Check if wallet chain matches selected chain (for EVM only)
  const validChainIds = useMemo(() => getValidChainIds(selectedChain), [selectedChain]);
  const isChainMismatch = useMemo(() => {
    if (selectedChain === 'sui') return false; // SUI has its own network check
    if (!isConnected || !chainId) return false;
    return !validChainIds.includes(chainId);
  }, [selectedChain, isConnected, chainId, validChainIds]);

  // ============================================================================
  // CHAIN SELECTION
  // ============================================================================

  // Auto-detect chain based on connected wallet
  // Priority: Connected wallet chain > SUI default
  useEffect(() => {
    // Skip if user has manually selected a chain
    if (userSelectedChainRef.current) return;

    // Check which wallet is connected
    const suiWalletConnected = suiIsConnected && suiAddress;
    const evmWalletConnected = isConnected && address;

    if (suiWalletConnected && !evmWalletConnected) {
      // Only SUI wallet connected - use SUI
      if (selectedChain !== 'sui') {
        dispatchPool({ type: 'SET_CHAIN', payload: 'sui' });
      }
    } else if (evmWalletConnected && !suiWalletConnected) {
      // Only EVM wallet connected - prefer Sepolia (WDK USDT) demo
      // Only switch if user is actually on Sepolia, otherwise keep default
      if (chainId === 11155111 && selectedChain !== 'sepolia') {
        dispatchPool({ type: 'SET_CHAIN', payload: 'sepolia' });
      }
      // Don't auto-switch away from Sepolia if user is on another chain
    } else if (suiWalletConnected && evmWalletConnected) {
      // Both wallets connected. Prefer Sepolia (official WDK USDT)
      if (selectedChain !== 'sepolia') {
        dispatchPool({ type: 'SET_CHAIN', payload: 'sepolia' });
      }
    }
    // If no wallet connected, keep current selection (defaults to 'sepolia' for WDK)
  }, [chainId, selectedChain, suiIsConnected, suiAddress, isConnected, address]);

  const handleChainSelect = useCallback((key: ChainKey) => {
    userSelectedChainRef.current = true;
    // Use startTransition for non-urgent chain switch (keeps UI responsive)
    startTransition(() => {
      dispatchPool({ type: 'SET_CHAIN', payload: key });
    });
  }, []);

  // Reset state on chain change
  useEffect(() => {
    mountedRef.current = true;
    dispatchPool({ type: 'RESET_FOR_CHAIN_CHANGE' });
    dispatchTx({ type: 'RESET_TX_STATE' });

    return () => {
      mountedRef.current = false;
    };
  }, [selectedChain]);

  // Auto-retry pending action after successful chain switch
  // This creates a seamless UX where deposit continues automatically
  // Note: We just mark the action as ready - the actual execution happens
  // in a separate effect after the handlers are defined
  useEffect(() => {
    if (!pendingChainSwitchRef.current) return;
    if (!chainId) return;

    const { action, targetChainId } = pendingChainSwitchRef.current;

    // Check if we're now on the target chain
    if (chainId === targetChainId) {
      logger.info('[CommunityPool] Chain switch completed, preparing to auto-continue', {
        action,
        chainId,
      });
      // Keep the pending info - it will be executed by the post-handler effect
      dispatchPool({ type: 'SET_ERROR', payload: null });
      dispatchPool({
        type: 'SET_SUCCESS',
        payload: `Switched to ${chainConfig?.name}! Starting ${action}...`,
      });
    }
  }, [chainId, chainConfig?.name]);

  // ============================================================================
  // DATA FETCHING
  // ============================================================================

  const fetchPoolData = useCallback(
    async (force = false) => {
      const now = Date.now();
      if (!force && now - lastFetchRef.current < 5000) return;
      lastFetchRef.current = now;

      // Paper is a virtual pool — its data lives in cron_state via
      // /api/paper-trader/status, not in the multi-chain community-pool
      // endpoint. Short-circuit the fetcher entirely (CommunityPool.tsx
      // renders PaperPoolPanel which fetches from its own endpoint).
      if (selectedChain === 'paper') {
        dispatchPool({ type: 'SET_LOADING', payload: false });
        return;
      }

      if (selectedChain === 'sui') {
        const userAddress = suiAddress; // Only use SUI address for SUI chain
        try {
          const [poolRes, userRes] = await Promise.all([
            fetch(`/api/sui/community-pool?network=${suiNetwork}`),
            userAddress
              ? fetch(`/api/sui/community-pool?user=${userAddress}&network=${suiNetwork}`)
              : null,
          ]);

          const [poolJson, userJson] = await Promise.all([
            poolRes.json(),
            userRes ? userRes.json() : null,
          ]);

          if (!mountedRef.current) return;

          if (poolJson.success) {
            if (poolJson.data.poolStateId) {
              dispatchPool({ type: 'SET_SUI_POOL_STATE_ID', payload: poolJson.data.poolStateId });
            }

            dispatchPool({ type: 'SET_POOL_DATA', payload: mapApiToPoolSummary(poolJson.data) });
          }

          if (userJson?.success) {
            dispatchPool({
              type: 'SET_USER_POSITION',
              payload: mapApiToUserPosition(userJson.data, userAddress),
            });
          }

          // Stop the spinner as soon as pool+user data land — leaderboard
          // is enrichment, not critical path.
          dispatchPool({ type: 'SET_LOADING', payload: false });

          // Override the on-chain ATH with the DB-verified peak.
          // Why: Move's all_time_high_nav_per_share is a monotonic
          // ratchet — once set high, it can never come down. A jittery
          // NAV read pre-stabilizer (12h ago) baked a phantom peak of
          // $2.32 into on-chain state even though the DB never persisted
          // any share_price above $1.97. That phantom makes every
          // "off ATH" display look 12+ percentage points worse than
          // reality. Volatility endpoint returns the true verified peak
          // computed from non-clamped DB snapshots. Non-blocking so a
          // slow lookup can't stall the rest of the UI.
          fetch(`/api/sui/community-pool?action=volatility&network=${suiNetwork}`)
            .then((res) => res.json())
            .then((volJson) => {
              if (!mountedRef.current) return;
              const verifiedAthSp = Number(volJson?.data?.verifiedAth?.sharePrice) || 0;
              if (verifiedAthSp > 0) {
                dispatchPool({
                  type: 'PATCH_POOL_DATA',
                  payload: { allTimeHighNav: verifiedAthSp },
                });
              }
            })
            .catch((err) => logger.warn('[CommunityPool] SUI verified-ATH fetch warning:', err));

          // Fetch SUI members and map to the shared LeaderboardEntry shape.
          // Was previously hardcoded to []; the members action is served by
          // /api/sui/community-pool (not the EVM /api/community-pool route,
          // which returns 400 for SUI). Non-blocking so a slow member scan
          // can't stall the rest of the UI.
          fetch(`/api/sui/community-pool?action=members&network=${suiNetwork}`)
            .then((res) => res.json())
            .then((memJson) => {
              if (!mountedRef.current) return;
              const raw = memJson?.data?.members;
              if (!memJson?.success || !Array.isArray(raw)) {
                dispatchPool({ type: 'SET_LEADERBOARD', payload: [] });
                return;
              }
              const entries = raw
                .filter(
                  (m: { isMember?: boolean; shares?: number }) =>
                    m?.isMember && Number(m?.shares) > 0
                )
                .map(
                  (m: {
                    address: string;
                    shares: number;
                    percentage: number;
                    valueUsd?: number;
                  }) => ({
                    walletAddress: m.address,
                    shares: Number(m.shares) || 0,
                    percentage: Number(m.percentage) || 0,
                    valueUSD: Number(m.valueUsd) || undefined,
                  })
                )
                .sort((a: { shares: number }, b: { shares: number }) => b.shares - a.shares)
                .slice(0, 10);
              dispatchPool({ type: 'SET_LEADERBOARD', payload: entries });
            })
            .catch((err) => logger.warn('[CommunityPool] SUI members fetch warning:', err));
        } catch (err: any) {
          logger.error('[CommunityPool] SUI fetch error:', err);
          if (mountedRef.current) {
            dispatchPool({ type: 'SET_ERROR', payload: err.message });
            dispatchPool({ type: 'SET_LOADING', payload: false });
          }
        }
        return;
      }

      // EVM chains
      const chainParam = `&chain=${selectedChain}&network=${network}`;

      try {
        // Fetch pool and user data first (critical for UI)
        const [poolRes, userRes] = await Promise.all([
          fetch(`/api/community-pool?${chainParam.substring(1)}`),
          address ? fetch(`/api/community-pool?user=${address}${chainParam}`) : null,
        ]);

        const [poolJson, userJson] = await Promise.all([
          poolRes.json(),
          userRes ? userRes.json() : null,
        ]);

        if (!mountedRef.current) return;

        if (poolJson.success) {
          dispatchPool({ type: 'SET_POOL_DATA', payload: poolJson.pool });
        }
        if (userJson?.success) {
          dispatchPool({ type: 'SET_USER_POSITION', payload: userJson.user });
        }

        // Stop loading spinner as soon as critical data is ready
        dispatchPool({ type: 'SET_LOADING', payload: false });

        // Fetch leaderboard separately (non-blocking)
        // This heavy operation iterates all members on-chain
        fetch(`/api/community-pool?action=leaderboard&limit=5${chainParam}`)
          .then((res) => res.json())
          .then((leaderJson) => {
            if (mountedRef.current && leaderJson.success) {
              dispatchPool({ type: 'SET_LEADERBOARD', payload: leaderJson.leaderboard });
            }
          })
          .catch((err) => logger.warn('[CommunityPool] Leaderboard fetch warning:', err));
      } catch (err: any) {
        logger.error('[CommunityPool] Fetch error:', err);
        if (mountedRef.current) {
          dispatchPool({ type: 'SET_ERROR', payload: err.message });
          dispatchPool({ type: 'SET_LOADING', payload: false });
        }
      }
    },
    [address, suiAddress, selectedChain, network, suiNetwork]
  );

  const fetchAIRecommendation = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/community-pool/ai-decision?chain=${selectedChain}&network=${network}`
      );
      const json = await res.json();

      if (json.success && mountedRef.current) {
        dispatchPool({ type: 'SET_AI_RECOMMENDATION', payload: json.recommendation });
      }
    } catch (err: any) {
      logger.error('[CommunityPool] AI fetch error:', err);
    }
  }, [selectedChain, network]);

  // Initial fetch
  useEffect(() => {
    fetchPoolData(true);
  }, [fetchPoolData]);

  // Polling. 15s so deposit stats + share price feel alive on the demo.
  // Every hit is a same-origin cached API call; Vercel edge cache absorbs
  // the extra load. If it turns out to be too aggressive at scale, bump
  // to 30-45s.
  usePolling(fetchPoolData, 15000);

  // ============================================================================
  // TRANSACTION HANDLERS
  // ============================================================================

  // Track processed transaction hashes to prevent duplicate handling
  const processedHashRef = useRef<string | null>(null);
  const pendingDepositRef = useRef<{ amount: string } | null>(null);

  // Handle USDT reset approval confirmation -> trigger actual approval
  useEffect(() => {
    if (!txHash || !isConfirmed) return;
    if (processedHashRef.current === txHash) return; // Already processed

    const depositAmountStr = pendingDepositAmountRef.current || txState.depositAmount;
    if (txState.txStatus === 'resetting_approval' && depositAmountStr) {
      processedHashRef.current = txHash; // Mark as processed
      logger.info('[CommunityPool] USDT allowance reset confirmed, proceeding with approval');

      const amount = parseFloat(depositAmountStr);
      if (!isNaN(amount) && COMMUNITY_POOL_ADDRESS && USDT_ADDRESS) {
        resetWrite();

        // Get target chain for approval
        const validChainIds = getValidChainIds(selectedChain);
        const targetChainId = validChainIds[0];
        logger.info('[CommunityPool] Reset confirmed, scheduling approval', { targetChainId });

        setTimeout(() => {
          dispatchTx({ type: 'SET_TX_STATUS', payload: 'approving' });
          const amountInUnits = parseUnits(amount.toString(), 6);

          writeContract({
            chainId: targetChainId,
            address: USDT_ADDRESS,
            abi: [
              {
                name: 'approve',
                type: 'function',
                inputs: [
                  { name: 'spender', type: 'address' },
                  { name: 'amount', type: 'uint256' },
                ],
                outputs: [{ type: 'bool' }],
                stateMutability: 'nonpayable',
              },
            ],
            functionName: 'approve',
            args: [COMMUNITY_POOL_ADDRESS, amountInUnits],
          });
        }, 1000);
      }
    }
  }, [
    txHash,
    isConfirmed,
    txState.txStatus,
    txState.depositAmount,
    COMMUNITY_POOL_ADDRESS,
    USDT_ADDRESS,
    writeContract,
    resetWrite,
    selectedChain,
  ]);

  // Handle EVM approval confirmation -> trigger deposit
  useEffect(() => {
    if (!txHash || !isConfirmed) return;
    if (processedHashRef.current === txHash) return; // Already processed

    const depositAmountStr = pendingDepositAmountRef.current || txState.depositAmount;
    if (txState.txStatus === 'approving' && depositAmountStr) {
      processedHashRef.current = txHash; // Mark as processed

      const amount = parseFloat(depositAmountStr);
      if (!isNaN(amount) && COMMUNITY_POOL_ADDRESS) {
        // Store the deposit amount for the next transaction
        pendingDepositRef.current = { amount: depositAmountStr };

        // Set status to approved (intermediate state)
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'approved' });

        // Reset write state and trigger deposit after a delay
        resetWrite();

        // Get target chain for deposit
        const validChainIds = getValidChainIds(selectedChain);
        const targetChainId = validChainIds[0];
        logger.info('[CommunityPool] Approval confirmed, scheduling deposit', { targetChainId });

        setTimeout(() => {
          if (pendingDepositRef.current && COMMUNITY_POOL_ADDRESS) {
            dispatchTx({ type: 'SET_TX_STATUS', payload: 'depositing' });
            const depositAmount = parseFloat(pendingDepositRef.current.amount);
            const amountInUnits = parseUnits(depositAmount.toString(), 6);

            writeContract({
              chainId: targetChainId,
              address: COMMUNITY_POOL_ADDRESS,
              abi: [
                {
                  name: 'deposit',
                  type: 'function',
                  inputs: [{ name: 'amount', type: 'uint256' }],
                  outputs: [{ type: 'uint256' }],
                  stateMutability: 'nonpayable',
                },
              ],
              functionName: 'deposit',
              args: [amountInUnits],
            });
          }
        }, 1000);
      }
    }
  }, [
    txHash,
    isConfirmed,
    txState.txStatus,
    txState.depositAmount,
    COMMUNITY_POOL_ADDRESS,
    writeContract,
    resetWrite,
    selectedChain,
  ]);

  // Handle EVM deposit confirmation -> success
  useEffect(() => {
    if (!txHash || !isConfirmed) return;
    if (processedHashRef.current === txHash) return; // Already processed

    if (txState.txStatus === 'depositing') {
      processedHashRef.current = txHash; // Mark as processed
      pendingDepositRef.current = null; // Clear pending deposit
      pendingDepositAmountRef.current = ''; // Clear preserved amount from chain switch

      dispatchTx({ type: 'SET_TX_STATUS', payload: 'complete' });
      dispatchPool({
        type: 'SET_SUCCESS',
        payload: `Deposit successful! Tx: ${txHash?.slice(0, 10)}...`,
      });
      dispatchTx({ type: 'SET_DEPOSIT_AMOUNT', payload: '' });
      dispatchTx({ type: 'SET_SHOW_DEPOSIT', payload: false });
      dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });

      // Refresh pool data after short delay
      setTimeout(() => {
        fetchPoolData(true);
        dispatchPool({ type: 'SET_SUCCESS', payload: null });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
      }, 3000);
    }
  }, [txHash, isConfirmed, txState.txStatus, fetchPoolData]);

  // Handle EVM withdraw confirmation -> success
  useEffect(() => {
    if (!txHash || !isConfirmed) return;
    if (processedHashRef.current === txHash) return; // Already processed

    if (txState.txStatus === 'withdrawing') {
      processedHashRef.current = txHash; // Mark as processed

      dispatchTx({ type: 'SET_TX_STATUS', payload: 'complete' });
      dispatchPool({
        type: 'SET_SUCCESS',
        payload: `Withdrawal successful! Tx: ${txHash?.slice(0, 10)}...`,
      });
      dispatchTx({ type: 'SET_WITHDRAW_SHARES', payload: '' });
      dispatchTx({ type: 'SET_SHOW_WITHDRAW', payload: false });
      dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });

      setTimeout(() => {
        fetchPoolData(true);
        dispatchPool({ type: 'SET_SUCCESS', payload: null });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
      }, 3000);
    }
  }, [txHash, isConfirmed, txState.txStatus, fetchPoolData]);

  // Handle transaction errors
  useEffect(() => {
    if (writeError && txState.txStatus !== 'idle' && txState.txStatus !== 'complete') {
      const errorMsg = writeError.message?.includes('User rejected')
        ? 'Transaction cancelled by user'
        : writeError.message || 'Transaction failed';
      dispatchPool({ type: 'SET_ERROR', payload: errorMsg });
      dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
      dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
      pendingDepositRef.current = null;
    }
  }, [writeError, txState.txStatus]);

  const signForApi = useCallback(
    async (action: 'deposit' | 'withdraw', amount: string) => {
      if (!address) return null;
      const timestamp = Math.floor(Date.now() / 1000);
      const message = `ZkWard Community Pool\n\nAction: ${action.toUpperCase()}\nAmount: $${amount}\nWallet: ${address}\ntimestamp:${timestamp}`;
      try {
        const signature = await signMessageAsync({ message });
        return { signature, message };
      } catch {
        return null;
      }
    },
    [address, signMessageAsync]
  );

  const handleDeposit = useCallback(async () => {
    dispatchPool({ type: 'SET_ERROR', payload: null });

    if (!isConnected || !address) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Please connect your wallet first' });
      return;
    }

    // Use preserved amount from ref if available (survives chain switch), else use UI state
    const depositAmountStr = pendingDepositAmountRef.current || txState.depositAmount;
    const amount = parseFloat(depositAmountStr);

    // Check minimum deposit amount (first deposit requires $100 for inflation attack protection)
    const minDeposit = isFirstDeposit ? 100 : 10;
    if (isNaN(amount) || amount < minDeposit) {
      dispatchPool({
        type: 'SET_ERROR',
        payload: `Minimum deposit is $${minDeposit}${isFirstDeposit ? ' (first deposit)' : ''}`,
      });
      return;
    }

    const validChainIds = getValidChainIds(selectedChain);

    // Skip chain check if we just did a successful wallet switch (WDK lags behind native API)
    if (skipChainCheckRef.current) {
      logger.info('[CommunityPool] Chain check skipped (recent switch)', { chainId });
      skipChainCheckRef.current = false;
      // Fall through to actual deposit logic below
    } else if (!validChainIds.includes(chainId as number)) {
      const targetChainId = validChainIds[0];
      logger.info('[CommunityPool] Chain mismatch, initiating switch', {
        current: chainId,
        target: targetChainId,
      });

      // Preserve the deposit amount in ref before chain switch (UI state may be lost during switch)
      pendingDepositAmountRef.current = txState.depositAmount;

      dispatchPool({ type: 'SET_ERROR', payload: `Switching to ${chainConfig?.name}...` });
      pendingChainSwitchRef.current = { action: 'deposit', targetChainId };

      // Chain parameters for adding to wallet
      const chainParams: Record<
        number,
        {
          chainId: string;
          chainName: string;
          rpcUrls: string[];
          blockExplorerUrls: string[];
          nativeCurrency: { name: string; symbol: string; decimals: number };
        }
      > = {
        11155111: {
          // Sepolia
          chainId: '0xaa36a7',
          chainName: 'Sepolia',
          rpcUrls: ['https://sepolia.drpc.org', 'https://rpc.sepolia.org'],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        },
        338: {
          // Cronos Testnet
          chainId: '0x152',
          chainName: 'Cronos Testnet',
          rpcUrls: ['https://evm-t3.cronos.org'],
          blockExplorerUrls: ['https://explorer.cronos.org/testnet'],
          nativeCurrency: { name: 'Test Cronos', symbol: 'tCRO', decimals: 18 },
        },
        421614: {
          // Arbitrum Sepolia
          chainId: '0x66eee',
          chainName: 'Arbitrum Sepolia',
          rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
          blockExplorerUrls: ['https://sepolia.arbiscan.io'],
          nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
        },
      };

      // Use WDK switchChainAsync - this properly syncs state
      logger.info('[CommunityPool] Switching chain (WDK)', { targetChainId });

      // Set timeout for user feedback
      const timeoutId = setTimeout(() => {
        if (pendingChainSwitchRef.current?.action === 'deposit') {
          console.log('[CommunityPool] Switch timeout');
          dispatchPool({
            type: 'SET_ERROR',
            payload: `Please switch to ${chainConfig?.name} in your wallet, then click Deposit again.`,
          });
          pendingChainSwitchRef.current = null;
        }
      }, 20000);

      // Try WDK switchChainAsync (syncs state properly)
      switchChainAsync({ chainId: targetChainId })
        .then(() => {
          logger.info('[CommunityPool] Chain switch success (WDK)');
          clearTimeout(timeoutId);
          pendingChainSwitchRef.current = null;
          dispatchPool({ type: 'SET_ERROR', payload: null });

          // State is now synced, proceed immediately
          logger.info('[CommunityPool] Proceeding with deposit (synced)');
          setTimeout(() => {
            handleDeposit();
          }, 100);
        })
        .catch(async (switchError: any) => {
          logger.warn('[CommunityPool] WDK switch failed, trying native', {
            error: switchError?.message,
          });
          // Fallback to native API if WDK fails (e.g., chain not in config)
          const ethereum = (window as any).ethereum;
          if (!ethereum) {
            clearTimeout(timeoutId);
            dispatchPool({ type: 'SET_ERROR', payload: 'No wallet detected.' });
            return;
          }

          const params = chainParams[targetChainId];
          if (!params) {
            clearTimeout(timeoutId);
            dispatchPool({ type: 'SET_ERROR', payload: `Chain ${targetChainId} not supported` });
            return;
          }

          try {
            logger.info('[CommunityPool] Falling back to native API');
            await ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: params.chainId }],
            });

            logger.info('[CommunityPool] Native switch success');
            clearTimeout(timeoutId);
            skipChainCheckRef.current = true;
            pendingChainSwitchRef.current = null;
            dispatchPool({ type: 'SET_ERROR', payload: null });

            // Wait a bit longer for WDK to sync via chainChanged event
            setTimeout(() => {
              logger.info('[CommunityPool] Retrying deposit after native switch');
              handleDeposit();
            }, 1000);
          } catch (nativeError: any) {
            logger.error('[CommunityPool] Native switch failed', {
              code: nativeError?.code,
              message: nativeError?.message,
            });
            if (nativeError?.code === 4902) {
              // Chain not added - try to add it
              try {
                await ethereum.request({
                  method: 'wallet_addEthereumChain',
                  params: [params],
                });
                logger.info('[CommunityPool] Chain added');
                clearTimeout(timeoutId);
                skipChainCheckRef.current = true;
                pendingChainSwitchRef.current = null;
                dispatchPool({ type: 'SET_ERROR', payload: null });
                setTimeout(() => handleDeposit(), 1000);
              } catch (addError: any) {
                clearTimeout(timeoutId);
                pendingChainSwitchRef.current = null;
                dispatchPool({
                  type: 'SET_ERROR',
                  payload: `Please add ${chainConfig?.name} to your wallet manually.`,
                });
              }
            } else if (nativeError?.code === 4001) {
              clearTimeout(timeoutId);
              pendingChainSwitchRef.current = null;
              dispatchPool({
                type: 'SET_ERROR',
                payload: 'Chain switch rejected. Please switch manually.',
              });
            } else {
              clearTimeout(timeoutId);
              pendingChainSwitchRef.current = null;
              dispatchPool({
                type: 'SET_ERROR',
                payload: nativeError?.message || 'Chain switch failed',
              });
            }
          }
        });
      return;
    }

    if (!poolDeployed) {
      dispatchPool({
        type: 'SET_ERROR',
        payload: `Pool not deployed on ${chainConfig?.name} ${network}`,
      });
      return;
    }

    // Get the target chain ID for this deposit (use selected chain, not WDK's stale value)
    const targetChainId = validChainIds[0];
    console.error('🔴🔴🔴 DEPOSIT - Proceeding with deposit', {
      amount,
      targetChainId,
      wdkChainId: chainId,
      USDT_ADDRESS,
      COMMUNITY_POOL_ADDRESS,
      poolDeployed,
    });

    dispatchTx({ type: 'SET_ACTION_LOADING', payload: true });

    // =========================================
    // TRY GASLESS (AA) FLOW
    // =========================================
    // Sepolia supports AA/Gasless. Try this first if available to save gas (USDT paid).
    if (validChainIds.includes(11155111)) {
      console.log('Attempting Gasless (Account Abstraction) flow...');
      try {
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'signing_permit' }); // Reusing status for signing
        const tx = await depositWithGasless(amount.toString());

        console.log('Gasless Deposit Success:', tx);
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'depositing' }); // Show depositing spinner

        // Wait a bit for indexing/propagation (simplified for now)
        await new Promise((r) => setTimeout(r, 5000));

        dispatchTx({ type: 'SET_TX_STATUS', payload: 'complete' });
        dispatchPool({
          type: 'SET_SUCCESS',
          payload: `Gasless Deposit Submitted! Tx: ${tx.slice(0, 10)}...`,
        });
        dispatchTx({ type: 'SET_DEPOSIT_AMOUNT', payload: '' });
        dispatchTx({ type: 'SET_SHOW_DEPOSIT', payload: false });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });

        // Refresh
        setTimeout(() => {
          fetchPoolData(true);
          dispatchPool({ type: 'SET_SUCCESS', payload: null });
          dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
        }, 3000);
        return;
      } catch (err: any) {
        console.warn('Gasless flow failed/skipped:', err.message);
        // Only fall back if it wasn't a user rejection or if it's explicitly "Not a smart account"
        if (err.message?.includes('User rejected')) {
          dispatchPool({ type: 'SET_ERROR', payload: 'Transaction cancelled' });
          dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
          dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
          return;
        }

        // If failed because not a smart account, fall back to EOA flow
        // Otherwise, show error?
        // For now, let's assume we fall back to EOA flow for robustness.
        console.log('Falling back to standard EOA deposit...');
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' }); // Reset for standard flow
      }
    }

    // =========================================
    // CHECK & FUND GAS FOR WDK EOA WALLETS
    // =========================================
    // WDK wallets may have USDT but no ETH for gas. Request server-side gas funding if needed.
    try {
      const rpcUrl = chainConfig.rpcUrls[network];
      const gasCheckProvider = new ethers.JsonRpcProvider(rpcUrl);
      const ethBalance = await gasCheckProvider.getBalance(address as string);
      const minGas = ethers.parseEther('0.001');

      if (ethBalance < minGas) {
        logger.info('[CommunityPool] Insufficient ETH, requesting gas funding...');
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'signing_permit' }); // reuse status for "preparing"

        const fundResp = await fetch('/api/community-pool/deposit-usdt?action=fund-gas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: address,
            chainId: targetChainId,
          }),
        });

        const fundResult = await fundResp.json();

        if (!fundResp.ok) {
          logger.error('[CommunityPool] Gas funding failed', { error: fundResult.error });
          dispatchPool({
            type: 'SET_ERROR',
            payload:
              fundResult.error ||
              'Failed to obtain gas funding. Please get Sepolia ETH from a faucet.',
          });
          dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
          dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
          return;
        }

        if (fundResult.funded && fundResult.txHash) {
          logger.info('[CommunityPool] Gas funded', { txHash: fundResult.txHash });
          // Brief wait for balance to propagate
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          logger.info('[CommunityPool] Gas already funded', { message: fundResult.message });
        }
      }
    } catch (fundErr: any) {
      console.warn('Gas funding check failed, proceeding anyway:', fundErr.message);
    }

    // =========================================
    // TRY EIP-2612 PERMIT FLOW (Single TX!)
    // =========================================
    // Fetch permit details ON CLICK - no eager loading!
    let permitDetails: {
      supported: boolean;
      nonce?: bigint;
      name?: string;
      domainSeparator?: string;
    } = { supported: false, nonce: BigInt(0), name: '', domainSeparator: '' };
    try {
      permitDetails = await getPermitDetails(USDT_ADDRESS, address, targetChainId);
    } catch (e) {
      console.warn('Failed to fetch permit details', e);
    }

    const {
      supported: permitSupported,
      nonce: permitNonce,
      name: tokenName,
      domainSeparator: domainSep,
    } = permitDetails;

    if (
      permitSupported &&
      permitNonce !== undefined &&
      tokenName &&
      signTypedDataAsync &&
      domainSep
    ) {
      logger.info('[CommunityPool] Using EIP-2612 Permit flow');

      try {
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'signing_permit' });

        const amountInUnits = parseUnits(amount.toString(), 6);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
        const nonce = BigInt(permitNonce.toString());

        // EIP-712 Permit typed data
        const domain = {
          name: tokenName as string,
          version: '1',
          chainId: targetChainId,
          verifyingContract: USDT_ADDRESS as `0x${string}`,
        };

        const types = {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        };

        const message = {
          owner: address as `0x${string}`,
          spender: COMMUNITY_POOL_ADDRESS as `0x${string}`,
          value: amountInUnits,
          nonce: nonce,
          deadline: deadline,
        };

        logger.debug('[CommunityPool] Signing permit', { domain, message });

        // Sign the permit (gasless - just a signature!)
        const signature = await signTypedDataAsync({
          domain,
          types,
          primaryType: 'Permit',
          message,
        });

        if (!signature) throw new Error('Failed to obtain signature');

        logger.debug('[CommunityPool] Signature obtained');

        // Parse signature into v, r, s
        const r = signature.slice(0, 66) as `0x${string}`;
        const s = ('0x' + signature.slice(66, 130)) as `0x${string}`;
        const v = parseInt(signature.slice(130, 132), 16);

        logger.info('[CommunityPool] Executing depositWithPermit');

        dispatchTx({ type: 'SET_TX_STATUS', payload: 'depositing' });

        // Call depositWithPermit - single transaction using async/await!
        const permitDepositTxHash = await writeContractAsync({
          chainId: targetChainId,
          address: COMMUNITY_POOL_ADDRESS,
          abi: [
            {
              name: 'depositWithPermit',
              type: 'function',
              inputs: [
                { name: 'amount', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'v', type: 'uint8' },
                { name: 'r', type: 'bytes32' },
                { name: 's', type: 'bytes32' },
              ],
              outputs: [{ type: 'uint256' }],
              stateMutability: 'nonpayable',
            },
          ],
          functionName: 'depositWithPermit',
          args: [amountInUnits, deadline, v, r, s],
        });

        logger.info('[CommunityPool] Permit tx submitted', { txHash: permitDepositTxHash });
        {
          const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrls[network]);
          await provider.waitForTransaction(permitDepositTxHash, 1, 60000);
        }
        logger.info('[CommunityPool] Permit deposit confirmed');

        // SUCCESS!
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'complete' });
        dispatchTx({ type: 'SET_LAST_TX_HASH', payload: permitDepositTxHash });
        dispatchPool({
          type: 'SET_SUCCESS',
          payload: `Deposit successful (gasless)! Tx: ${permitDepositTxHash.slice(0, 10)}...`,
        });
        dispatchTx({ type: 'SET_DEPOSIT_AMOUNT', payload: '' });
        dispatchTx({ type: 'SET_SHOW_DEPOSIT', payload: false });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });

        // Refresh pool data
        fetchPoolData(true);
        return; // Done with permit flow
      } catch (permitError: any) {
        // If it's an insufficient funds error, don't bother falling back. The wallet has no gas
        const code = permitError?.code || permitError?.info?.error?.code;
        const msg = permitError?.shortMessage || permitError?.message || '';
        if (code === 'INSUFFICIENT_FUNDS' || msg.includes('insufficient funds')) {
          dispatchPool({
            type: 'SET_ERROR',
            payload:
              'Insufficient ETH for gas. Please get Sepolia ETH from a faucet (e.g. Google Cloud faucet or Alchemy faucet).',
          });
          dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
          dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
          return;
        }
        logger.warn('[CommunityPool] Permit flow failed, falling back', { error: msg });
        // Fall through to regular approve+deposit flow
      }
    }

    // =========================================
    // FALLBACK: Regular Approve + Deposit (2 TXs)
    // Using async/await for reliable sequencing
    // =========================================
    logger.info('[CommunityPool] Using standard Approve+Deposit flow');

    try {
      // Refetch current allowance interactively (lazy)
      const currentAllowance = await getAllowance(USDT_ADDRESS, address, COMMUNITY_POOL_ADDRESS);
      const allowance = BigInt(currentAllowance.toString());
      const amountInUnits = parseUnits(amount.toString(), 6);
      logger.info(
        `[Deposit] Allowance: ${allowance.toString()}, needed: ${amountInUnits.toString()}`
      );

      // STEP 1: Reset allowance if needed (USDT non-standard requirement)
      if (allowance > BigInt(0) && allowance < amountInUnits) {
        logger.info('[CommunityPool] USDT: Resetting allowance to 0 first', {
          currentAllowance: allowance.toString(),
        });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'resetting_approval' });
        logger.info('[CommunityPool] Step 1: Resetting allowance');

        const resetTxHash = await writeContractAsync({
          chainId: targetChainId,
          address: USDT_ADDRESS,
          abi: [
            {
              name: 'approve',
              type: 'function',
              inputs: [
                { name: 'spender', type: 'address' },
                { name: 'amount', type: 'uint256' },
              ],
              outputs: [{ type: 'bool' }],
              stateMutability: 'nonpayable',
            },
          ],
          functionName: 'approve',
          args: [COMMUNITY_POOL_ADDRESS, BigInt(0)],
        });

        logger.info('[CommunityPool] Reset tx submitted', { txHash: resetTxHash });
        {
          const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrls[network]);
          await provider.waitForTransaction(resetTxHash, 1, 60000);
        }
        logger.info('[CommunityPool] Reset confirmed');
      }

      // STEP 2: Approve the deposit amount (only if needed)
      if (allowance < amountInUnits) {
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'approving' });
        logger.info('[CommunityPool] Step 2: Approving tokens', {
          amount: amountInUnits.toString(),
        });

        const approveTxHash = await writeContractAsync({
          chainId: targetChainId,
          address: USDT_ADDRESS,
          abi: [
            {
              name: 'approve',
              type: 'function',
              inputs: [
                { name: 'spender', type: 'address' },
                { name: 'amount', type: 'uint256' },
              ],
              outputs: [{ type: 'bool' }],
              stateMutability: 'nonpayable',
            },
          ],
          functionName: 'approve',
          args: [COMMUNITY_POOL_ADDRESS, amountInUnits],
        });

        logger.info('[CommunityPool] Approve tx submitted', { txHash: approveTxHash });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'approved' });
        {
          const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrls[network]);
          await provider.waitForTransaction(approveTxHash, 1, 60000);
        }
        logger.info('[CommunityPool] Approve confirmed');
      } else {
        logger.info('[CommunityPool] Step 2 Skipped: Allowance sufficient', {
          allowance: allowance.toString(),
        });
      }

      // STEP 3: Deposit to pool
      dispatchTx({ type: 'SET_TX_STATUS', payload: 'depositing' });
      logger.info('[CommunityPool] Step 3: Depositing tokens');

      const depositTxHash = await writeContractAsync({
        chainId: targetChainId,
        address: COMMUNITY_POOL_ADDRESS,
        abi: [
          {
            name: 'deposit',
            type: 'function',
            inputs: [{ name: 'amount', type: 'uint256' }],
            outputs: [{ type: 'uint256' }],
            stateMutability: 'nonpayable',
          },
        ],
        functionName: 'deposit',
        args: [amountInUnits],
      });

      logger.info('[CommunityPool] Deposit tx submitted', { txHash: depositTxHash });
      {
        const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrls[network]);
        await provider.waitForTransaction(depositTxHash, 1, 60000);
      }
      logger.info('[CommunityPool] Deposit confirmed');

      // SUCCESS!
      dispatchTx({ type: 'SET_TX_STATUS', payload: 'complete' });
      dispatchTx({ type: 'SET_LAST_TX_HASH', payload: depositTxHash });
      dispatchPool({
        type: 'SET_SUCCESS',
        payload: `Deposit successful! Tx: ${depositTxHash.slice(0, 10)}...`,
      });
      dispatchTx({ type: 'SET_DEPOSIT_AMOUNT', payload: '' });
      dispatchTx({ type: 'SET_SHOW_DEPOSIT', payload: false });

      // Refresh pool data
      fetchPoolData(true);
    } catch (err: any) {
      console.error('🔴🔴🔴 DEPOSIT - Error:', err);
      pendingDepositAmountRef.current = ''; // Clear on error
      // Detect insufficient ETH for gas and show helpful message
      const code = err?.code || err?.info?.error?.code;
      const msg = err?.shortMessage || err?.message || '';
      if (code === 'INSUFFICIENT_FUNDS' || msg.includes('insufficient funds')) {
        dispatchPool({
          type: 'SET_ERROR',
          payload:
            'Insufficient ETH for gas. Please get Sepolia ETH from a faucet (e.g. Google Cloud faucet or Alchemy faucet).',
        });
      } else {
        dispatchPool({ type: 'SET_ERROR', payload: msg });
      }
      dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
    } finally {
      dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
    }
  }, [
    isConnected,
    address,
    txState.depositAmount,
    selectedChain,
    chainId,
    chainConfig,
    network,
    poolDeployed,
    writeContractAsync,
    USDT_ADDRESS,
    COMMUNITY_POOL_ADDRESS,
    isFirstDeposit,
    signTypedDataAsync,
    switchChainAsync,
    fetchPoolData,
  ]);

  const handleWithdraw = useCallback(async () => {
    dispatchPool({ type: 'SET_ERROR', payload: null });

    if (!isConnected || !address) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Please connect your wallet first' });
      return;
    }

    const shares = parseFloat(txState.withdrawShares);
    if (isNaN(shares) || shares <= 0) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Please enter shares to withdraw' });
      return;
    }

    // Validate chain ID (same as handleDeposit)
    const validChainIds = getValidChainIds(selectedChain);
    if (!validChainIds.includes(chainId as number)) {
      const targetChainId = validChainIds[0];
      console.log(
        `[CommunityPool] Withdraw chain mismatch - wallet chainId: ${chainId}, target: ${targetChainId}`
      );
      dispatchPool({ type: 'SET_ERROR', payload: `Switching to ${chainConfig?.name}...` });
      pendingChainSwitchRef.current = { action: 'withdraw', targetChainId };

      // Chain parameters for adding to wallet (same as deposit)
      const chainParams: Record<
        number,
        {
          chainId: string;
          chainName: string;
          rpcUrls: string[];
          blockExplorerUrls: string[];
          nativeCurrency: { name: string; symbol: string; decimals: number };
        }
      > = {
        11155111: {
          // Sepolia
          chainId: '0xaa36a7',
          chainName: 'Sepolia',
          rpcUrls: ['https://sepolia.drpc.org', 'https://rpc.sepolia.org'],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        },
        338: {
          // Cronos Testnet
          chainId: '0x152',
          chainName: 'Cronos Testnet',
          rpcUrls: ['https://evm-t3.cronos.org'],
          blockExplorerUrls: ['https://explorer.cronos.org/testnet'],
          nativeCurrency: { name: 'Test Cronos', symbol: 'tCRO', decimals: 18 },
        },
        421614: {
          // Arbitrum Sepolia
          chainId: '0x66eee',
          chainName: 'Arbitrum Sepolia',
          rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
          blockExplorerUrls: ['https://sepolia.arbiscan.io'],
          nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
        },
      };

      // Try to add and switch chain using native wallet API
      const addAndSwitchChain = async () => {
        const ethereum = (window as any).ethereum;
        if (!ethereum) {
          throw new Error('No wallet detected');
        }

        const params = chainParams[targetChainId];
        if (!params) {
          throw new Error(`Chain ${targetChainId} not configured`);
        }

        try {
          // First try to just switch (chain might already be added)
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: params.chainId }],
          });
        } catch (switchError: any) {
          // 4902 = Chain not added, try to add it
          if (switchError.code === 4902) {
            await ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [params],
            });
            // After adding, switch to it
            await ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: params.chainId }],
            });
          } else {
            throw switchError;
          }
        }
      };

      // Set a timeout to show manual switch message if wallet doesn't respond
      const timeoutId = setTimeout(() => {
        if (pendingChainSwitchRef.current?.action === 'withdraw') {
          console.log('[CommunityPool] Switch timeout - showing manual message');
          dispatchPool({
            type: 'SET_ERROR',
            payload: `Please add ${chainConfig?.name} to your wallet and switch to it, then click Withdraw again.`,
          });
          pendingChainSwitchRef.current = null;
        }
      }, 15000);

      console.log('[CommunityPool] Adding and switching chain for withdraw...');
      addAndSwitchChain()
        .then(() => {
          console.log('[CommunityPool] Chain switch successful for withdraw!');
          clearTimeout(timeoutId);
        })
        .catch((err: any) => {
          console.error('[CommunityPool] Chain switch failed:', err);
          clearTimeout(timeoutId);
          pendingChainSwitchRef.current = null;
          if (err?.code === 4001 || err?.message?.includes('rejected')) {
            dispatchPool({
              type: 'SET_ERROR',
              payload: 'Chain switch rejected. Please add the chain manually in your wallet.',
            });
          } else {
            dispatchPool({
              type: 'SET_ERROR',
              payload: `Please add ${chainConfig?.name} to your wallet and switch to it manually.`,
            });
          }
        });
      return;
    }

    if (!poolDeployed) {
      dispatchPool({
        type: 'SET_ERROR',
        payload: `Pool not deployed on ${chainConfig?.name} ${network}`,
      });
      return;
    }

    dispatchTx({ type: 'SET_ACTION_LOADING', payload: true });
    dispatchTx({ type: 'SET_TX_STATUS', payload: 'withdrawing' });

    try {
      const sharesWei = parseUnits(shares.toFixed(6), 18);

      writeContract({
        address: COMMUNITY_POOL_ADDRESS,
        abi: COMMUNITY_POOL_ABI,
        functionName: 'withdraw',
        args: [sharesWei, BigInt(0)],
      });
    } catch (err: any) {
      dispatchPool({ type: 'SET_ERROR', payload: err.message });
      dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
      dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
    }
  }, [
    isConnected,
    address,
    txState.withdrawShares,
    selectedChain,
    chainId,
    chainConfig,
    network,
    poolDeployed,
    writeContract,
    COMMUNITY_POOL_ADDRESS,
  ]);

  // SUI handlers - Accept USDC (USD) and convert to SUI for deposit
  const handleSuiDeposit = useCallback(async () => {
    dispatchPool({ type: 'SET_ERROR', payload: null });

    if (!suiIsConnected || !suiAddress) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Please connect your SUI wallet' });
      return;
    }

    if (!suiExecuteTransaction) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Wallet transaction signing not available' });
      return;
    }

    const usdAmount = parseFloat(txState.suiDepositAmount);
    if (isNaN(usdAmount) || usdAmount <= 0) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Invalid deposit amount' });
      return;
    }

    // Minimum deposit: $10 USDC
    if (usdAmount < 10) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Minimum deposit is $10 USDC' });
      return;
    }

    dispatchTx({ type: 'SET_ACTION_LOADING', payload: true });
    dispatchTx({ type: 'SET_TX_STATUS', payload: 'depositing' });

    try {
      // USDC has 6 decimals on SUI mainnet
      const amountRaw = BigInt(Math.floor(usdAmount * 1_000_000));

      // Sanity-check the connected wallet has enough SUI for gas (not for the deposit itself!)
      const GAS_RESERVE_SUI = 0.05;
      const userSuiBalance = parseFloat(suiBalance);
      if (userSuiBalance < GAS_RESERVE_SUI) {
        dispatchPool({
          type: 'SET_ERROR',
          payload: `Insufficient SUI for gas. Need ~${GAS_RESERVE_SUI} SUI. You have ${suiBalance} SUI.`,
        });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
        return;
      }

      // Step 1: Get transaction params from API (USDC pool — amount in atomic units, 6 decimals)
      const res = await fetch(`/api/sui/community-pool?action=deposit&network=${suiNetwork}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amountRaw.toString() }),
      });

      const json = await res.json();
      if (!json.success) {
        dispatchPool({ type: 'SET_ERROR', payload: json.error });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
        return;
      }

      const { target, poolStateId, clockId, usdcCoinType, typeArg } = json.data;

      if (!poolStateId) {
        dispatchPool({ type: 'SET_ERROR', payload: 'Pool state not found. Try refreshing.' });
        return;
      }

      const usdcType: string = typeArg || usdcCoinType;
      if (!usdcType) {
        dispatchPool({ type: 'SET_ERROR', payload: 'USDC coin type missing from API response.' });
        return;
      }

      // Step 2: Fetch the user's USDC coin objects on-chain via same-origin
      // proxy. fullnode.mainnet.sui.io killed JSON-RPC 2026-07 AND has no
      // CORS headers — every direct browser hit fails 'net::ERR_FAILED'.
      // /api/rpc/sui applies the same BlockVision failover the server uses.
      const { SuiClient } = await import('@mysten/sui/client');
      const { Transaction } = await import('@mysten/sui/transactions');
      const rpcUrl = suiNetwork === 'testnet' ? '/api/rpc/sui-testnet' : '/api/rpc/sui';
      const client = new SuiClient({ url: rpcUrl });

      const usdcCoins = await client.getCoins({ owner: suiAddress, coinType: usdcType });
      const totalUsdcRaw = usdcCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
      if (totalUsdcRaw < amountRaw) {
        const have = (Number(totalUsdcRaw) / 1_000_000).toFixed(2);
        dispatchPool({
          type: 'SET_ERROR',
          payload: `Insufficient USDC. Need $${usdAmount.toFixed(2)} USDC. You have $${have} USDC.`,
        });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
        return;
      }

      // Step 3: Build transaction — merge USDC coins, split exact deposit amount, call deposit<USDC>
      const tx = new Transaction();
      const primary = tx.object(usdcCoins.data[0].coinObjectId);
      if (usdcCoins.data.length > 1) {
        tx.mergeCoins(
          primary,
          usdcCoins.data.slice(1).map((c) => tx.object(c.coinObjectId))
        );
      }
      const [depositCoin] = tx.splitCoins(primary, [tx.pure.u64(amountRaw)]);

      // Call the deposit function: deposit<T>(state, payment: Coin<T>, clock)
      tx.moveCall({
        target,
        typeArguments: [usdcType],
        arguments: [tx.object(poolStateId), depositCoin, tx.object(clockId)],
      });

      // Step 3: Execute transaction
      const result = await suiExecuteTransaction(tx);

      if (result.success) {
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'complete' });
        dispatchPool({
          type: 'SET_SUCCESS',
          payload: `Deposited $${usdAmount.toFixed(2)} USDC! Tx: ${result.digest.slice(0, 10)}...`,
        });
        dispatchTx({ type: 'SET_SUI_DEPOSIT_AMOUNT', payload: '' });
        dispatchTx({ type: 'SET_SHOW_DEPOSIT', payload: false });

        // Step 4: Record the deposit server-side (idempotent by txDigest) so the
        // dashboard history + per-wallet share cache stays in sync. Fire-and-forget;
        // failure here doesn't affect the on-chain deposit which has already settled.
        fetch(`/api/sui/community-pool?action=record-deposit&network=${suiNetwork}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: suiAddress,
            amountUsdc: usdAmount,
            txDigest: result.digest,
          }),
        }).catch((err) => logger.warn('record-deposit failed (non-fatal)', err));

        // Refresh pool data after a short delay
        setTimeout(() => {
          fetchPoolData(true);
          dispatchPool({ type: 'SET_SUCCESS', payload: null });
        }, 3000);
      } else {
        dispatchPool({
          type: 'SET_ERROR',
          payload: result.error || 'Transaction failed. Please try again.',
        });
      }
    } catch (err: any) {
      logger.error('SUI deposit error', err);
      dispatchPool({ type: 'SET_ERROR', payload: err.message || 'Deposit failed' });
    } finally {
      dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
      dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
    }
  }, [
    suiIsConnected,
    suiAddress,
    suiExecuteTransaction,
    txState.suiDepositAmount,
    suiNetwork,
    suiBalance,
    fetchPoolData,
  ]);

  const handleSuiWithdraw = useCallback(async () => {
    dispatchPool({ type: 'SET_ERROR', payload: null });

    if (!suiIsConnected || !suiAddress) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Please connect your SUI wallet' });
      return;
    }

    if (!suiExecuteTransaction) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Wallet transaction signing not available' });
      return;
    }

    const shares = parseFloat(txState.suiWithdrawShares);
    if (isNaN(shares) || shares <= 0) {
      dispatchPool({ type: 'SET_ERROR', payload: 'Invalid share amount' });
      return;
    }

    // Calculate estimated USD value
    const sharePrice =
      Number(poolState.poolData?.sharePriceUSD || poolState.poolData?.sharePrice) || 1;
    const estimatedUsd = shares * sharePrice;

    dispatchTx({ type: 'SET_ACTION_LOADING', payload: true });
    dispatchTx({ type: 'SET_TX_STATUS', payload: 'withdrawing' });

    try {
      // USDC pool shares use 6 decimals (matching USDC). API divides input by 1e6.
      const sharesRaw = BigInt(Math.floor(shares * 1_000_000));

      // Step 1: Get transaction params from API.
      //
      // The server preflight tops up the on-chain pool balance when the
      // contract is short. That round-trip (open_hedge + close_hedge, both
      // awaiting finality) can take 10-20s and — on a Vercel cold-start —
      // occasionally exceed the serverless timeout, returning a 504. In that
      // case the top-up txs have almost certainly already been submitted and
      // will land shortly, so we retry once after a delay: the second call
      // hits the "already liquid" branch and returns fast.
      const fetchWithdrawParams = async () =>
        fetch(`/api/sui/community-pool?action=withdraw&network=${suiNetwork}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shares: sharesRaw.toString() }),
        });

      let res = await fetchWithdrawParams();
      if (res.status === 504) {
        logger.warn('Withdraw preflight timed out (504) — retrying after top-up settles');
        await new Promise((r) => setTimeout(r, 15000));
        res = await fetchWithdrawParams();
      }

      if (res.status === 504) {
        dispatchPool({
          type: 'SET_ERROR',
          payload:
            'Pool liquidity is being prepared on-chain. Please wait ~30 seconds and try again.',
        });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
        return;
      }

      const json = await res
        .json()
        .catch(() => ({
          success: false,
          error: `Withdraw API returned ${res.status} with an unparseable response`,
        }));
      if (!json.success) {
        // On POOL_LIQUIDITY_INSUFFICIENT the API returns maxWithdrawableShares —
        // auto-fill the input so the user can retry immediately at the size
        // that will actually clear. Preserves the informational error message
        // above the input.
        const suggestedShares = json.data?.maxWithdrawableShares;
        if (
          json.data?.code === 'POOL_LIQUIDITY_INSUFFICIENT' &&
          typeof suggestedShares === 'number' &&
          suggestedShares > 0.001
        ) {
          dispatchTx({ type: 'SET_SUI_WITHDRAW_SHARES', payload: suggestedShares.toFixed(4) });
        }
        dispatchPool({ type: 'SET_ERROR', payload: json.error });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
        return;
      }

      const { target, poolStateId, sharesScaled, clockId, typeArg } = json.data;

      if (!poolStateId) {
        dispatchPool({ type: 'SET_ERROR', payload: 'Pool state not found. Try refreshing.' });
        dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
        return;
      }

      // Step 2: Build transaction using @mysten/sui/transactions
      const { Transaction } = await import('@mysten/sui/transactions');
      const tx = new Transaction();

      // Call the withdraw function: withdraw<T>(state, shares_to_burn, clock)
      tx.moveCall({
        target,
        typeArguments: typeArg ? [typeArg] : undefined,
        arguments: [tx.object(poolStateId), tx.pure.u64(sharesScaled), tx.object(clockId)],
      });

      // Step 3: Execute transaction. Prefer sponsored execution so users don't
      // need to hold SUI just to redeem shares. The withdraw payload IS USDC,
      // so it's weird UX to require a separate token for gas. Fall back to
      // wallet-paid gas if sponsorship fails (server unreachable, admin low
      // on SUI, etc.).
      let result;
      if (suiSponsoredExecute) {
        try {
          result = await suiSponsoredExecute(tx);
        } catch (sponsorErr) {
          logger.warn('Sponsored withdraw failed, falling back to wallet-paid gas', sponsorErr);
          result = await suiExecuteTransaction(tx);
        }
      } else {
        result = await suiExecuteTransaction(tx);
      }

      if (result.success) {
        dispatchTx({ type: 'SET_TX_STATUS', payload: 'complete' });
        dispatchPool({
          type: 'SET_SUCCESS',
          payload: `Withdrew ~$${estimatedUsd.toFixed(2)} USD! Tx: ${result.digest.slice(0, 10)}...`,
        });
        dispatchTx({ type: 'SET_SUI_WITHDRAW_SHARES', payload: '' });
        dispatchTx({ type: 'SET_SHOW_WITHDRAW', payload: false });

        // Persist the withdrawal to community_pool_transactions so
        // lifetime analytics stay accurate. Prior code never called
        // record-withdraw after a successful on-chain tx, so every
        // mainnet withdrawal was invisible to the DB. Total withdrawn
        // read as \$0 in analyze-pool-pnl and the dashboard forever.
        // Non-critical: DB write failure doesn't undo the on-chain
        // withdraw; the reconciler will pick it up later. Fire-and-forget.
        void fetch(`/api/sui/community-pool?action=record-withdraw&network=${suiNetwork}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: suiAddress,
            sharesToBurn: Number(sharesRaw) / 1e6,
            txDigest: result.digest,
          }),
        }).catch((err) => {
          logger.warn('Record-withdraw failed (non-critical, reconciler will retry)', err);
        });

        // Refresh pool data after a short delay
        setTimeout(() => {
          fetchPoolData(true);
          dispatchPool({ type: 'SET_SUCCESS', payload: null });
        }, 3000);
      } else {
        // Surface the actual wallet/on-chain error so users understand what went wrong
        // (e.g. E_INSUFFICIENT_BALANCE when the pool is short of USDC).
        dispatchPool({
          type: 'SET_ERROR',
          payload: result.error || 'Transaction failed. Please try again.',
        });
      }
    } catch (err: any) {
      logger.error('SUI withdraw error', err);
      dispatchPool({ type: 'SET_ERROR', payload: err.message || 'Withdrawal failed' });
    } finally {
      dispatchTx({ type: 'SET_ACTION_LOADING', payload: false });
      dispatchTx({ type: 'SET_TX_STATUS', payload: 'idle' });
    }
  }, [
    suiIsConnected,
    suiAddress,
    suiExecuteTransaction,
    suiSponsoredExecute,
    txState.suiWithdrawShares,
    suiNetwork,
    poolState.poolData,
    fetchPoolData,
  ]);

  // ============================================================================
  // AUTO-EXECUTE AFTER CHAIN SWITCH
  // This effect runs when chainId changes and checks for pending actions
  // ============================================================================
  useEffect(() => {
    const pending = pendingChainSwitchRef.current;
    if (!pending) return;
    if (!chainId) return;

    const { action, targetChainId } = pending;

    // Execute only when we're on the target chain
    if (chainId === targetChainId) {
      // Clear pending action BEFORE executing to prevent re-triggering
      pendingChainSwitchRef.current = null;

      logger.info(`[CommunityPool] Chain match! Auto-executing: ${action}, chainId: ${chainId}`);
      logger.info(
        `[CommunityPool] Chain switch completed! Auto-executing: ${action}, chainId: ${chainId}`
      );
      dispatchPool({ type: 'SET_ERROR', payload: null });
      dispatchPool({ type: 'SET_SUCCESS', payload: `Switched to chain! Processing ${action}...` });

      // Delay to let state settle, then execute
      const timer = setTimeout(() => {
        dispatchPool({ type: 'SET_SUCCESS', payload: null });
        if (action === 'deposit') {
          handleDeposit();
        } else if (action === 'withdraw') {
          handleWithdraw();
        }
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [chainId]); // Only depend on chainId - handlers are stable enough

  // ============================================================================
  // Stable dispatcher callbacks (avoid re-creating on every render)
  const setShowDeposit = useCallback(
    (show: boolean) => dispatchTx({ type: 'SET_SHOW_DEPOSIT', payload: show }),
    []
  );
  const setShowWithdraw = useCallback(
    (show: boolean) => dispatchTx({ type: 'SET_SHOW_WITHDRAW', payload: show }),
    []
  );
  const setDepositAmount = useCallback(
    (amount: string) => dispatchTx({ type: 'SET_DEPOSIT_AMOUNT', payload: amount }),
    []
  );
  const setWithdrawShares = useCallback(
    (shares: string) => dispatchTx({ type: 'SET_WITHDRAW_SHARES', payload: shares }),
    []
  );
  const setSuiDepositAmount = useCallback(
    (amount: string) => dispatchTx({ type: 'SET_SUI_DEPOSIT_AMOUNT', payload: amount }),
    []
  );
  const setSuiWithdrawShares = useCallback(
    (shares: string) => dispatchTx({ type: 'SET_SUI_WITHDRAW_SHARES', payload: shares }),
    []
  );
  const setError = useCallback(
    (error: string | null) => dispatchPool({ type: 'SET_ERROR', payload: error }),
    []
  );
  const setSuccess = useCallback(
    (msg: string | null) => dispatchPool({ type: 'SET_SUCCESS', payload: msg }),
    []
  );
  const setTxStatus = useCallback(
    (status: TxStatus) => dispatchTx({ type: 'SET_TX_STATUS', payload: status }),
    []
  );
  const setActionLoading = useCallback(
    (loading: boolean) => dispatchTx({ type: 'SET_ACTION_LOADING', payload: loading }),
    []
  );
  const setLastTxHash = useCallback(
    (hash: string | null) => dispatchTx({ type: 'SET_LAST_TX_HASH', payload: hash }),
    []
  );

  // ============================================================================
  // MEMOIZED RETURN VALUE (prevents re-renders when unchanged)
  // ============================================================================

  // Memoize pool-related values
  const poolValues = useMemo(
    () => ({
      poolData: poolState.poolData,
      userPosition: poolState.userPosition,
      aiRecommendation: poolState.aiRecommendation,
      leaderboard: poolState.leaderboard,
      loading: poolState.loading,
      error: poolState.error,
      successMessage: poolState.successMessage,
      selectedChain: poolState.selectedChain,
      suiPoolStateId: poolState.suiPoolStateId,
    }),
    [poolState]
  );

  // Memoize transaction-related values
  const txValues = useMemo(
    () => ({
      txStatus: txState.txStatus,
      actionLoading: txState.actionLoading,
      showDeposit: txState.showDeposit,
      showWithdraw: txState.showWithdraw,
      depositAmount: txState.depositAmount,
      withdrawShares: txState.withdrawShares,
      suiDepositAmount: txState.suiDepositAmount,
      suiWithdrawShares: txState.suiWithdrawShares,
      lastTxHash: txState.lastTxHash,
    }),
    [txState]
  );

  // Memoize wallet-related values with chain-aware active address
  const walletValues = useMemo(() => {
    const isSui = selectedChain === 'sui';

    // Determine active address based on wallet type
    // Priority: SUI (for sui chain) > EVM
    // Note: WDK treasury is server-side, users connect via WDK self-custodial wallet
    let activeAddress: string | null = null;
    let isActiveWalletConnected = false;

    if (isSui) {
      activeAddress = suiAddress;
      isActiveWalletConnected = suiIsConnected;
    } else {
      activeAddress = address ?? null;
      isActiveWalletConnected = isConnected;
    }

    return {
      address,
      isConnected,
      chainId,
      suiAddress,
      suiIsConnected,
      suiBalance,
      suiNetwork,
      suiIsWrongNetwork,
      activeWalletType,
      // Chain-aware helpers
      activeAddress,
      isActiveWalletConnected,
    };
  }, [
    address,
    isConnected,
    chainId,
    suiAddress,
    suiIsConnected,
    suiBalance,
    suiNetwork,
    suiIsWrongNetwork,
    selectedChain,
    activeWalletType,
  ]);

  // Memoize derived configuration values
  const configValues = useMemo(() => {
    // Format user's USDT balance (6 decimals)
    const userBalance = userUsdtBalance
      ? parseFloat(formatUnits(BigInt(userUsdtBalance.toString()), 6))
      : 0;

    return {
      chainConfig,
      network,
      poolDeployed,
      COMMUNITY_POOL_ADDRESS,
      isFirstDeposit,
      isChainMismatch,
      userUsdtBalance: userBalance,
    };
  }, [
    chainConfig,
    network,
    poolDeployed,
    COMMUNITY_POOL_ADDRESS,
    isFirstDeposit,
    isChainMismatch,
    userUsdtBalance,
  ]);

  // RETURN
  // ============================================================================

  return useMemo(
    () => ({
      // Pool state (memoized)
      ...poolValues,

      // Transaction state (memoized)
      ...txValues,
      isPending,
      isConfirming,
      isConfirmed,
      writeError,

      // Wallet state (memoized)
      ...walletValues,

      // Derived config (memoized)
      ...configValues,

      // Actions (stable callbacks)
      handleChainSelect,
      fetchPoolData,
      fetchAIRecommendation,
      handleDeposit,
      handleWithdraw,
      handleSuiDeposit,
      handleSuiWithdraw,
      resetWrite,
      signForApi,

      // Stable dispatchers
      setShowDeposit,
      setShowWithdraw,
      setDepositAmount,
      setWithdrawShares,
      setSuiDepositAmount,
      setSuiWithdrawShares,
      setError,
      setSuccess,
      setTxStatus,
      setActionLoading,
      setLastTxHash,
    }),
    [
      poolValues,
      txValues,
      isPending,
      isConfirming,
      isConfirmed,
      writeError,
      walletValues,
      configValues,
      handleChainSelect,
      fetchPoolData,
      fetchAIRecommendation,
      handleDeposit,
      handleWithdraw,
      handleSuiDeposit,
      handleSuiWithdraw,
      resetWrite,
      signForApi,
      setShowDeposit,
      setShowWithdraw,
      setDepositAmount,
      setWithdrawShares,
      setSuiDepositAmount,
      setSuiWithdrawShares,
      setError,
      setSuccess,
      setTxStatus,
      setActionLoading,
      setLastTxHash,
    ]
  );
}
