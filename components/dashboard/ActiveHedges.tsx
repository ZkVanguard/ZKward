'use client';

import { useState, memo, useMemo, useRef, useEffect, useCallback } from 'react';
import { Shield, TrendingUp, TrendingDown, CheckCircle, ExternalLink, RefreshCw, Wallet, Lock, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { usePolling, useToggle } from '@/lib/hooks';
import { useApiAuth } from '@/lib/hooks/useApiAuth';
import { useHedgeRecommendations } from '@/contexts/AIDecisionsContext';
import { logger } from '@/lib/utils/logger';
import { useWalletClient, useChainId } from '@/lib/evm-wallet/hooks';
import { getContractAddresses } from '@/lib/contracts/addresses';
import { getExplorerUrl, getNetworkName, CHAIN_IDS } from '@/lib/utils/network';
import {
  HedgeDetailModal,
  CloseConfirmModal,
  CloseReceiptModal,
  AIRecommendationsSection,
  EmptyHedgesState,
  ActiveHedgeDetailRow,
  ActivePositionCard,
} from './active-hedges';
import type { HedgePosition, CloseReceipt, PerformanceStats, AIRecommendation } from './active-hedges';
import { mapOnChainHedge, computeStats, resolveAssetPriceUsd, pairIndexOf } from './active-hedges/helpers';

interface ActiveHedgesProps {
  address?: string;
  compact?: boolean;
  onCreateHedge?: () => void;
  onOpenChat?: () => void;
}

export const ActiveHedges = memo(function ActiveHedges({ address, compact = false, onCreateHedge, onOpenChat }: ActiveHedgesProps) {
  // Get the connected wallet client (works with OKX, MetaMask, etc.)
  const { data: walletClient } = useWalletClient();
  const chainId = useChainId();
  const { getAuthHeaders } = useApiAuth(address);
  const queryClient = useQueryClient();
  
  // Get dynamic contract addresses based on connected chain
  const contractAddresses = useMemo(() => getContractAddresses(chainId || CHAIN_IDS.CRONOS_TESTNET), [chainId]);
  const explorerUrl = useMemo(() => getExplorerUrl(chainId), [chainId]);
  const _networkName = useMemo(() => getNetworkName(chainId), [chainId]);
  
  // EIP-712 domain for signatures (dynamic based on chain)
  const getEIP712Domain = useCallback(() => ({
    name: 'ZKward',
    version: '1',
    chainId: chainId || CHAIN_IDS.CRONOS_TESTNET,
    verifyingContract: contractAddresses.hedgeExecutor,
  }), [chainId, contractAddresses.hedgeExecutor]);
  
  // EIP-712 signature helper for closing hedges - uses WDK walletClient for correct wallet
  // NO fallback to window.ethereum - that causes conflicts with multiple wallets (OKX vs MetaMask)
  const signCloseHedge = useCallback(async (hedgeId: string): Promise<{ signature: string; timestamp: number } | null> => {
    try {
      // IMPORTANT: Only use WDK walletClient - no window.ethereum fallback
      // Multiple wallet extensions conflict over window.ethereum
      if (!walletClient) {
        logger.error('❌ No walletClient available - ensure wallet is fully connected via WDK', { 
          component: 'ActiveHedges',
          hint: 'If using OKX, ensure it is selected as the active wallet in the connect modal'
        });
        alert('Wallet not connected properly. Please disconnect and reconnect your wallet using the Connect button.');
        return null;
      }
      
      const timestamp = Math.floor(Date.now() / 1000);

      const domain = getEIP712Domain();
      const types = {
        CloseHedge: [
          { name: 'hedgeId', type: 'bytes32' },
          { name: 'action', type: 'string' },
          { name: 'timestamp', type: 'uint256' },
        ],
      } as const;
      const message = { hedgeId: hedgeId as `0x${string}`, action: 'close', timestamp: BigInt(timestamp) };

      logger.info('🔑 Signing with connected wallet via WDK', { 
        component: 'ActiveHedges', 
        wallet: walletClient.account?.address,
        connector: walletClient.transport?.name || 'unknown'
      });
      
      const signature = await walletClient.signTypedData({
        domain,
        types,
        primaryType: 'CloseHedge',
        message,
      });

      logger.info('🔑 Signed close-hedge message', { component: 'ActiveHedges', signer: walletClient.account?.address });
      return { signature, timestamp };
    } catch (err) {
      logger.warn('Wallet signature declined or failed', { component: 'ActiveHedges', error: err });
      return null;
    }
  }, [walletClient, getEIP712Domain]);

  // EIP-712 signature helper for OPENING hedges. Proves user authorized this hedge
  const signOpenHedge = useCallback(async (asset: string, side: string, collateral: number, leverage: number): Promise<{ signature: string; timestamp: number } | null> => {
    try {
      if (!walletClient) {
        alert('Wallet not connected. Please connect your wallet first.');
        return null;
      }

      const timestamp = Math.floor(Date.now() / 1000);

      const domain = getEIP712Domain();
      const types = {
        OpenHedge: [
          { name: 'asset', type: 'string' },
          { name: 'side', type: 'string' },
          { name: 'collateral', type: 'uint256' },
          { name: 'leverage', type: 'uint256' },
          { name: 'timestamp', type: 'uint256' },
        ],
      } as const;
      const message = {
        asset,
        side,
        collateral: BigInt(Math.round(collateral * 1e6)), // USDC 6 decimals
        leverage: BigInt(leverage),
        timestamp: BigInt(timestamp),
      };

      logger.info('🔑 Requesting wallet signature for hedge execution', {
        component: 'ActiveHedges',
        wallet: walletClient.account?.address,
        asset,
        side,
      });

      const signature = await walletClient.signTypedData({
        domain,
        types,
        primaryType: 'OpenHedge',
        message,
      });

      logger.info('✅ Hedge execution signed by wallet', { component: 'ActiveHedges', signer: walletClient.account?.address });
      return { signature, timestamp };
    } catch (err) {
      logger.warn('Wallet signature declined or failed for hedge execution', { component: 'ActiveHedges', error: err });
      return null;
    }
  }, [walletClient, getEIP712Domain]);

  const [hedges, setHedges] = useState<HedgePosition[]>([]);
  const [stats, setStats] = useState<PerformanceStats>({
    totalHedges: 0,
    activeHedges: 0,
    winRate: 0,
    totalPnL: 0,
    avgHoldTime: '0h',
    bestTrade: 0,
    worstTrade: 0,
  });
  const [loading, setLoading] = useState(true);
  const [closingPosition, setClosingPosition] = useState<string | null>(null);
  const [showCloseConfirm, _toggleCloseConfirm, openCloseConfirm, closeCloseConfirm] = useToggle(false);
  const [selectedHedge, setSelectedHedge] = useState<HedgePosition | null>(null);
  const [showClosedPositions, toggleClosedPositions] = useToggle(false);
  const [closeReceipt, setCloseReceipt] = useState<CloseReceipt | null>(null);
  const [detailHedge, setDetailHedge] = useState<HedgePosition | null>(null);
  const processingRef = useRef(false);
  const _lastProcessedRef = useRef<string>('');
  
  // AI Recommendations from centralized context
  const { hedges: contextHedges, loading: contextHedgesLoading, refresh: refreshContextHedges } = useHedgeRecommendations();
  const [executingRecommendation, setExecutingRecommendation] = useState<string | null>(null);

  // Map context recommendations to AIRecommendation interface
  const recommendations: AIRecommendation[] = useMemo(() => {
    return contextHedges.map(h => ({
      strategy: `${h.side} ${h.asset} Hedge`,
      confidence: h.confidence / 100,
      expectedReduction: 0.3,
      description: h.reason,
      actions: [{
        action: h.side,
        asset: h.asset,
        size: h.size || 100,
        leverage: h.leverage,
        protocol: 'Moonlander',
        reason: h.reason,
      }],
      agentSource: h.source,
    }));
  }, [contextHedges]);
  const loadingRecommendations = contextHedgesLoading;

  const activeHedges = useMemo(() => hedges.filter(h => h.status === 'active' || h.status === 'pending'), [hedges]);
  const closedHedges = useMemo(() => hedges.filter(h => h.status === 'closed' || h.status === 'liquidated' || h.status === 'cancelled'), [hedges]);

  const loadHedges = useCallback(async () => {
    if (processingRef.current) return;

    try {
      processingRef.current = true;

      // Fetch on-chain hedges from HedgeExecutor contract
      let onChainHedges: HedgePosition[] = [];

      try {
        // Pass user's wallet address to filter hedges they actually own
        const walletParam = address ? `&walletAddress=${address}` : '';
        const onChainResponse = await fetch(`/api/agents/hedging/onchain?stats=true${walletParam}`);
        if (onChainResponse.ok) {
          const onChainData = await onChainResponse.json();
          if (onChainData.success && onChainData.summary?.details) {
            logger.debug('🔗 On-chain hedges loaded', { component: 'ActiveHedges', count: onChainData.summary.details.length });
            onChainHedges = onChainData.summary.details.map((h: Parameters<typeof mapOnChainHedge>[0]) =>
              mapOnChainHedge(h, contractAddresses.hedgeExecutor)
            );
          }
        }
      } catch (onChainErr) {
        logger.error('❌ On-chain hedges not available', onChainErr instanceof Error ? onChainErr : undefined, { component: 'ActiveHedges' });
      }

      // Use on-chain hedges only (DB cleared)
      setHedges(onChainHedges);
      setStats(computeStats(onChainHedges));
      setLoading(false);

    } catch (error) {
      logger.error('❌ [ActiveHedges] Error loading hedges', error instanceof Error ? error : undefined, { component: 'ActiveHedges' });
      setHedges([]);
      setLoading(false);
    } finally {
      processingRef.current = false;
    }
  }, [address]);

  usePolling(loadHedges, 30000);

  // Listen for hedge creation events to refresh immediately
  useEffect(() => {
    const handleHedgeAdded = () => {
      logger.debug('🔄 [ActiveHedges] Hedge added event received, refreshing...', { component: 'ActiveHedges' });
      loadHedges();
    };

    window.addEventListener('hedgeAdded', handleHedgeAdded);
    return () => window.removeEventListener('hedgeAdded', handleHedgeAdded);
  }, [loadHedges]);

  // AI Recommendations now come from the context (AIDecisionsContext)
  // No need for local fetch - context handles caching and sync

  // Execute AI recommendation
  const executeRecommendation = async (rec: AIRecommendation) => {
    if (!rec.actions || rec.actions.length === 0) return;
    
    const action = rec.actions[0];
    
    // REQUIRE wallet connection for ZK-private execution
    if (!address) {
      alert('Please connect your wallet first to execute hedges.');
      return;
    }
    if (!walletClient) {
      alert('Wallet not ready. Please disconnect and reconnect your wallet.');
      return;
    }

    // Determine collateral and leverage
    const actionLeverage = action.leverage || 5;

    // action.size is in ASSET units (e.g. 0.125 BTC), but the gasless endpoint
    // expects collateralAmount in USDC. Convert: collateral = size * price / leverage.
    const currentPrice = await resolveAssetPriceUsd(action.asset, queryClient);
    const notionalValue = action.size * currentPrice;
    const collateral = Math.round((notionalValue / actionLeverage) * 100) / 100; // USDC (2dp)

    logger.info('💰 Hedge collateral calculation', {
      component: 'ActiveHedges',
      assetSize: action.size,
      price: currentPrice,
      notional: notionalValue,
      collateral,
      leverage: actionLeverage,
    });

    const pairIndex = pairIndexOf(action.asset);
    const isLong = action.action === 'LONG';
    
    // Step 1: Request EIP-712 wallet signature (user must approve)
    const signResult = await signOpenHedge(
      action.asset,
      action.action,
      collateral,
      actionLeverage
    );
    
    if (!signResult) {
      // User declined the signature
      return;
    }
    
    setExecutingRecommendation(rec.strategy);
    
    try {
      // Step 2: Execute via ZK-private gasless endpoint (relayer sends tx, user stays hidden)
      const response = await fetch('/api/agents/hedging/open-onchain-gasless', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairIndex,
          collateralAmount: collateral,
          leverage: actionLeverage,
          isLong,
          walletAddress: address, // ZK-bound to hedge via commitment (never appears on-chain)
          signature: signResult.signature,
          timestamp: signResult.timestamp,
          reason: `AI Recommended: ${rec.description}`,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        logger.info('✅ ZK-Private hedge executed via gasless relay', { component: 'ActiveHedges', data });
        
        // Refresh hedges and recommendations
        window.dispatchEvent(new Event('hedgeAdded'));
        refreshContextHedges();
      } else {
        const error = await response.json();
        logger.error('❌ Failed to execute ZK hedge', undefined, { component: 'ActiveHedges', data: error });
        alert(`Failed to execute: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      logger.error('❌ Error executing AI recommendation', error instanceof Error ? error : undefined, { component: 'ActiveHedges' });
      alert('Failed to execute recommendation');
    } finally {
      setExecutingRecommendation(null);
    }
  };

  const handleClosePosition = async (hedge: HedgePosition) => {
    setSelectedHedge(hedge);
    openCloseConfirm();
  };

  const confirmClosePosition = async () => {
    if (!selectedHedge) return;
    
    setClosingPosition(selectedHedge.id);
    closeCloseConfirm();
    
    try {
      // For on-chain hedges, call the on-chain close API which triggers actual fund withdrawal
      if (selectedHedge.onChain && selectedHedge.hedgeId) {
        try {
          // NOTE: For ZK privacy hedges, the hedge.walletAddress might show the proxy wallet,
          // NOT the true owner. The backend verifies ownership via EIP-712 signature against
          // the TRUE owner stored in hedge_ownership table. So we skip frontend ownership check
          // and let the signature verification handle it properly.
          
          // Debug logging
          if (process.env.NODE_ENV === 'development') {
            logger.debug('[DEBUG] Close position - ZK hedge flow:', {
              hedgeId: selectedHedge.hedgeId,
              displayedWallet: selectedHedge.walletAddress,
              connectedWallet: address,
              proxyWallet: selectedHedge.proxyWallet,
              commitmentHash: selectedHedge.commitmentHash,
              zkVerified: selectedHedge.zkVerified,
            });
          }
          
          // The user signs with their REAL wallet, and the backend verifies
          // this signature against the TRUE owner from hedge_ownership table
          // This works even when hedge.walletAddress shows the proxy wallet

          // Sign the close request with the user's wallet (EIP-712)
          const sigResult = await signCloseHedge(selectedHedge.hedgeId);

          // Signature is REQUIRED for on-chain hedges - abort if user declined
          if (!sigResult) {
            logger.warn('⚠️ Signature declined - cannot close on-chain hedge without wallet verification', { component: 'ActiveHedges' });
            setCloseReceipt({
              success: false,
              asset: selectedHedge.asset,
              side: selectedHedge.type,
              collateral: selectedHedge.capitalUsed,
              leverage: selectedHedge.leverage,
              realizedPnl: 0,
              fundsReturned: 0,
              balanceBefore: 0,
              balanceAfter: 0,
              txHash: '',
              explorerLink: '',
              trader: address || '',
              gasless: false,
              error: 'Signature required! When MetaMask pops up, click "Sign" (not Reject) to verify you own this wallet. This proves ownership so funds can be withdrawn to you.',
              finalStatus: 'signature_declined',
            });
            setClosingPosition(null);
            return;
          }

          const closePayload = {
            hedgeId: selectedHedge.hedgeId,
            signature: sigResult.signature,
            walletAddress: address,
            signatureTimestamp: sigResult.timestamp,
          };

          const response = await fetch('/api/agents/hedging/close-onchain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(closePayload),
          });

          const data = await response.json();
          
          if (response.ok && data.success) {
            logger.info('✅ Hedge closed on-chain via x402 gasless, funds withdrawn', { component: 'ActiveHedges', data: {
              txHash: data.txHash,
              fundsReturned: data.fundsReturned,
              withdrawTo: data.withdrawalDestination,
              gasless: data.gasless,
              gasSaved: data.gasSavings?.totalSaved,
            }});
            
            // Show close receipt modal instead of alert
            setCloseReceipt({
              success: true,
              asset: data.asset || selectedHedge.asset,
              side: data.side || selectedHedge.type,
              collateral: data.collateral || selectedHedge.capitalUsed,
              leverage: data.leverage || selectedHedge.leverage,
              realizedPnl: data.realizedPnl || 0,
              fundsReturned: data.fundsReturned || 0,
              balanceBefore: data.balanceBefore || 0,
              balanceAfter: data.balanceAfter || 0,
              txHash: data.txHash || '',
              explorerLink: data.explorerLink || `${explorerUrl}/tx/${data.txHash}`,
              trader: data.trader || selectedHedge.walletAddress || '',
              gasless: data.gasless || false,
              gasSavings: data.gasSavings,
              elapsed: data.elapsed,
              finalStatus: data.finalStatus || 'closed',
            });
            
            // Remove from local state
            setHedges(prev => prev.filter(h => h.id !== selectedHedge.id));
            window.dispatchEvent(new Event('hedgeAdded'));
            return;
          } else {
            throw new Error(data.error || 'Close failed');
          }
        } catch (onChainErr) {
          logger.error('❌ On-chain close failed', onChainErr instanceof Error ? onChainErr : undefined, { component: 'ActiveHedges' });
          setCloseReceipt({
            success: false,
            asset: selectedHedge.asset,
            side: selectedHedge.type,
            collateral: selectedHedge.capitalUsed,
            leverage: selectedHedge.leverage,
            realizedPnl: 0,
            fundsReturned: 0,
            balanceBefore: 0,
            balanceAfter: 0,
            txHash: '',
            explorerLink: '',
            trader: selectedHedge.walletAddress || '',
            gasless: false,
            finalStatus: 'failed',
            error: onChainErr instanceof Error ? onChainErr.message : 'Unknown error',
          });
          return;
        }
      }

      // Fallback: Try to close in database for non-on-chain hedges
      try {
        const authHeaders = await getAuthHeaders();
        const response = await fetch('/api/agents/hedging/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            orderId: selectedHedge.id,
            realizedPnl: selectedHedge.pnl,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          logger.info('✅ Hedge closed in database', { component: 'ActiveHedges', data });
          
          // Remove from local state
          setHedges(prev => prev.filter(h => h.id !== selectedHedge.id));
          
          // Also update localStorage for fallback
          const settlements = localStorage.getItem('settlement_history');
          if (settlements) {
            const settlementData = JSON.parse(settlements);
            if (settlementData[selectedHedge.id]) {
              settlementData[selectedHedge.id].status = 'closed';
              settlementData[selectedHedge.id].closedAt = Date.now();
              settlementData[selectedHedge.id].finalPnL = selectedHedge.pnl;
              settlementData[selectedHedge.id].finalPnLPercent = selectedHedge.pnlPercent;
              localStorage.setItem('settlement_history', JSON.stringify(settlementData));
            }
          }
          
          window.dispatchEvent(new Event('hedgeAdded'));
          return;
        }
      } catch (apiErr) {
        logger.error('Failed to close in database, falling back to localStorage', apiErr instanceof Error ? apiErr : undefined, { component: 'ActiveHedges' });
      }

      // Fallback to localStorage only
      const settlements = localStorage.getItem('settlement_history');
      if (settlements) {
        const settlementData = JSON.parse(settlements);
        if (settlementData[selectedHedge.id]) {
          settlementData[selectedHedge.id].status = 'closed';
          settlementData[selectedHedge.id].closedAt = Date.now();
          settlementData[selectedHedge.id].finalPnL = selectedHedge.pnl;
          settlementData[selectedHedge.id].finalPnLPercent = selectedHedge.pnlPercent;
          
          localStorage.setItem('settlement_history', JSON.stringify(settlementData));
          window.dispatchEvent(new Event('hedgeAdded'));
          
          setHedges(prev => prev.map(h => 
            h.id === selectedHedge.id 
              ? { ...h, status: 'closed' as const, closedAt: new Date() }
              : h
          ));
        }
      }
    } catch (error) {
      logger.error('Failed to close position', error instanceof Error ? error : undefined, { component: 'ActiveHedges' });
      alert('Failed to close position. Please try again.');
    } finally {
      setClosingPosition(null);
      setSelectedHedge(null);
    }
  };

  if (loading) {
    return (
      <div className="px-4 sm:px-6 pb-4 sm:pb-6">
        <div className="space-y-2 sm:space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-24 sm:h-32 animate-pulse bg-[#f5f5f7] rounded-[12px] sm:rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 pb-4 sm:pb-6">
      {/* No Hedges State - Compact for Overview */}
      {hedges.length === 0 ? (
        <EmptyHedgesState onCreateHedge={onCreateHedge} onOpenChat={onOpenChat} />
      ) : compact ? (
        /* Compact view for Overview - show summary with clear status */
        <div>
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div className="flex items-center gap-2">
              {stats.activeHedges > 0 ? (
                <>
                <span className="text-[10px] sm:text-[11px] font-bold text-[#34C759] uppercase tracking-[0.04em] px-1.5 sm:px-2 py-0.5 sm:py-1 bg-[#34C759]/10 rounded-full">
                  {stats.activeHedges} Active
                </span>
                {activeHedges.some(h => h.onChain) && (
                  <span className="text-[9px] sm:text-[10px] font-bold text-[#FF9500] uppercase tracking-[0.04em] px-1.5 py-0.5 bg-[#FF9500]/10 rounded-full">
                    ⛓ On-Chain
                  </span>
                )}
                </>
              ) : (
                <span className="text-[10px] sm:text-[11px] font-bold text-[#86868b] uppercase tracking-[0.04em] px-1.5 sm:px-2 py-0.5 sm:py-1 bg-[#f5f5f7] rounded-full">
                  {stats.totalHedges} Closed
                </span>
              )}
            </div>
            <div className={`text-[17px] sm:text-[20px] font-bold ${stats.totalPnL >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
              {stats.totalPnL >= 0 ? '+' : ''}{stats.totalPnL.toFixed(2)} USDC
            </div>
          </div>
          
          {/* Quick Stats */}
          <div className="grid grid-cols-2 gap-2 mb-3 sm:mb-4">
            <div className="p-2 sm:p-3 bg-[#f5f5f7] rounded-[10px] sm:rounded-[12px]">
              <div className="text-[9px] sm:text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-0.5 sm:mb-1">Win Rate</div>
              <div className="text-[17px] sm:text-[20px] font-bold text-[#34C759] leading-none">{stats.winRate.toFixed(0)}%</div>
            </div>
            <div className="p-2 sm:p-3 bg-[#f5f5f7] rounded-[10px] sm:rounded-[12px]">
              <div className="text-[9px] sm:text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-0.5 sm:mb-1">Total P/L</div>
              <div className={`text-[17px] sm:text-[20px] font-bold leading-none ${stats.totalPnL >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                {stats.totalPnL >= 0 ? '+' : ''}{stats.totalPnL.toFixed(0)}
              </div>
            </div>
          </div>

          {/* Show active or recent closed positions */}
          <div className="space-y-2">
            {activeHedges.length > 0 ? (
              /* Active positions */
              activeHedges.slice(0, 2).map((hedge) => (
                <div key={hedge.id} className="flex items-center justify-between p-2 sm:p-3 bg-[#34C759]/5 rounded-[10px] sm:rounded-[12px] border border-[#34C759]/20 cursor-pointer hover:bg-[#34C759]/10 transition-colors" onClick={() => setDetailHedge(hedge)}>
                  <div className="flex items-center gap-2">
                    <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-[8px] sm:rounded-[10px] flex items-center justify-center ${
                      hedge.type === 'SHORT' ? 'bg-[#FF3B30]/10' : 'bg-[#34C759]/10'
                    }`}>
                      {hedge.type === 'SHORT' ? (
                        <TrendingDown className="w-4 h-4 text-[#FF3B30]" strokeWidth={2.5} />
                      ) : (
                        <TrendingUp className="w-4 h-4 text-[#34C759]" strokeWidth={2.5} />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[14px] font-semibold text-[#1d1d1f]">{hedge.type} {hedge.asset}</span>
                        <span className="px-1.5 py-0.5 bg-[#34C759] text-white text-[9px] font-bold rounded">ACTIVE</span>
                        {hedge.zkVerified && (
                          <span className="px-1.5 py-0.5 bg-[#5856D6] text-white text-[9px] font-bold rounded flex items-center gap-0.5" title="ZK-verified ownership">
                            <Lock className="w-2.5 h-2.5" />ZK
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] space-y-0.5">
                        <div className="text-[#1d1d1f] font-medium">{hedge.reason}</div>
                        {(hedge.txHash || hedge.onChain) && (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-[#86868b]">TX:</span>
                            <a
                              href={hedge.txHash ? `${explorerUrl}/tx/${hedge.txHash}` : `${explorerUrl}/address/${hedge.contractAddress || contractAddresses.hedgeExecutor}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                              title={hedge.txHash ? 'View transaction on Cronos Explorer' : 'View contract on Cronos Explorer'}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="font-mono">{hedge.txHash ? `${hedge.txHash.slice(0, 8)}...${hedge.txHash.slice(-6)}` : 'View on Explorer'}</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className={`text-[15px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                    {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)}
                  </div>
                </div>
              ))
            ) : closedHedges.length > 0 ? (
              /* Show recent closed positions when no active */
              closedHedges.slice(0, 2).map((hedge) => (
                <div key={hedge.id} className="flex items-center justify-between p-2 sm:p-3 bg-[#f5f5f7] rounded-[10px] sm:rounded-[12px] opacity-80">
                  <div className="flex items-center gap-2">
                    <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-[8px] sm:rounded-[10px] flex items-center justify-center ${
                      hedge.type === 'SHORT' ? 'bg-[#FF3B30]/10' : 'bg-[#34C759]/10'
                    }`}>
                      {hedge.type === 'SHORT' ? (
                        <TrendingDown className="w-4 h-4 text-[#FF3B30]" strokeWidth={2.5} />
                      ) : (
                        <TrendingUp className="w-4 h-4 text-[#34C759]" strokeWidth={2.5} />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[14px] font-semibold text-[#1d1d1f]">{hedge.type} {hedge.asset}</span>
                        <span className="px-1.5 py-0.5 bg-[#86868b] text-white text-[9px] font-bold rounded">CLOSED</span>
                        {hedge.zkVerified && (
                          <span className="px-1.5 py-0.5 bg-[#5856D6] text-white text-[9px] font-bold rounded flex items-center gap-0.5" title="ZK-verified ownership">
                            <Lock className="w-2.5 h-2.5" />ZK
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-[#86868b]">
                        <span>{hedge.closedAt ? `Closed ${new Date(hedge.closedAt).toLocaleDateString()}` : hedge.reason}</span>
                        {hedge.txHash && (
                          <a
                            href={`${explorerUrl}/tx/${hedge.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="font-mono">{hedge.txHash.slice(0, 6)}...{hedge.txHash.slice(-4)}</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className={`text-[15px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                    {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)}
                  </div>
                </div>
              ))
            ) : null}
            {activeHedges.length > 2 && (
              <div className="text-center text-[13px] text-[#86868b] pt-1">
                +{activeHedges.length - 2} more active
              </div>
            )}
            {activeHedges.length === 0 && closedHedges.length > 2 && (
              <div className="text-center text-[13px] text-[#86868b] pt-1">
                +{closedHedges.length - 2} more closed
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3 sm:space-y-4">
          {/* Performance Overview Card */}
          {stats.totalHedges > 0 && (
            <div className="bg-white rounded-[16px] sm:rounded-[20px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-black/5 p-3 sm:p-5">
              <div className="flex items-center justify-between mb-3 sm:mb-4">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <span className="text-[9px] sm:text-[11px] font-semibold text-[#34C759] uppercase tracking-[0.06em] px-2 sm:px-2.5 py-0.5 sm:py-1 bg-[#34C759]/10 rounded-full">
                    {stats.activeHedges} Active
                  </span>
                  {activeHedges.some(h => h.onChain) && (
                    <span className="text-[9px] sm:text-[10px] font-bold text-[#FF9500] uppercase tracking-[0.04em] px-2 py-0.5 bg-[#FF9500]/10 rounded-full">
                      ⛓ {activeHedges.filter(h => h.onChain).length} On-Chain
                    </span>
                  )}
                  <span className="text-[11px] sm:text-[13px] text-[#86868b]">
                    of {stats.totalHedges} total
                  </span>
                </div>
                <div className={`text-[18px] sm:text-[24px] font-bold leading-none ${stats.totalPnL >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                  {stats.totalPnL >= 0 ? '+' : ''}{stats.totalPnL.toFixed(2)} USDC
                </div>
              </div>

              {/* Compact Stats Grid — 2×2 on ≤ 375px (readable labels), 1×4 on
                  sm+ (dense info bar). 8px labels are unreadable on small
                  screens; we lift to 11px baseline. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-3 bg-[#34C759]/10 rounded-[12px]">
                  <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Win Rate</div>
                  <div className="text-[18px] sm:text-[20px] font-bold text-[#34C759] leading-none tabular-nums">{stats.winRate.toFixed(0)}%</div>
                </div>
                <div className="p-3 bg-[#f5f5f7] rounded-[12px]">
                  <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Total</div>
                  <div className="text-[18px] sm:text-[20px] font-bold text-[#1d1d1f] leading-none tabular-nums">{stats.totalHedges}</div>
                </div>
                <div className="p-3 bg-[#34C759]/10 rounded-[12px]">
                  <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Best</div>
                  <div className="text-[15px] sm:text-[17px] font-bold text-[#34C759] leading-none tabular-nums">+{stats.bestTrade.toFixed(0)}</div>
                </div>
                <div className="p-3 bg-[#007AFF]/10 rounded-[12px]">
                  <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Avg</div>
                  <div className="text-[15px] sm:text-[17px] font-bold text-[#007AFF] leading-none tabular-nums">{stats.avgHoldTime}</div>
                </div>
              </div>
            </div>
          )}

          {/* Active Positions - Preview or Full View */}
          {activeHedges.length > 0 ? (
            <div className="bg-white rounded-[16px] sm:rounded-[20px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-black/5 p-3 sm:p-5">
              {!showClosedPositions ? (
                /* Compact Preview - Horizontal Scroll (Apple Music style) */
                <div>
                  <div className="flex items-center justify-between mb-2 sm:mb-3">
                    <h3 className="text-[13px] sm:text-[15px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">
                      Active Positions
                    </h3>
                    <button
                      onClick={() => onCreateHedge?.()}
                      className="px-3 py-1.5 bg-[#007AFF] text-white rounded-[10px] text-[12px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all flex items-center gap-1.5"
                    >
                      <Shield className="w-3.5 h-3.5" />
                      <span>Create Hedge</span>
                    </button>
                  </div>
                  <div className="flex gap-2 sm:gap-3 overflow-x-auto pb-2 scrollbar-hide -mx-3 sm:-mx-5 px-3 sm:px-5">
                    {activeHedges.slice(0, 5).map((hedge) => (
                      <ActivePositionCard
                        key={hedge.id}
                        hedge={hedge}
                        explorerUrl={explorerUrl}
                        contractAddresses={contractAddresses}
                        closingPosition={closingPosition}
                        onOpenDetail={setDetailHedge}
                        onClose={handleClosePosition}
                      />
                    ))}
                  </div>
                  {activeHedges.length > 5 && (
                    <div className="mt-2 sm:mt-3 text-center">
                      <button
                        onClick={toggleClosedPositions}
                        className="text-[11px] sm:text-[13px] font-medium text-[#007AFF] hover:text-[#0051D5] transition-colors"
                      >
                        +{activeHedges.length - 5} more positions
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                /* Full View - All Active Positions */
                <div className="space-y-3">
                  <h3 className="text-[15px] font-semibold text-[#1d1d1f] mb-3 tracking-[-0.01em]">
                    All Active Positions
                  </h3>
                  <AnimatePresence>
                    {activeHedges.map((hedge) => (
                      <ActiveHedgeDetailRow
                        key={hedge.id}
                        hedge={hedge}
                        explorerUrl={explorerUrl}
                        contractAddresses={contractAddresses}
                        closingPosition={closingPosition}
                        onClose={handleClosePosition}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          ) : closedHedges.length > 0 ? (
            /* Show closed positions when no active hedges */
            <div className="bg-white rounded-[16px] sm:rounded-[20px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-black/5 p-3 sm:p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex-1">
                  <h3 className="text-[13px] sm:text-[15px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">
                    Closed Positions
                  </h3>
                  <span className="text-[11px] text-[#86868b]">{closedHedges.length} total</span>
                </div>
                <button
                  onClick={() => onCreateHedge?.()}
                  className="px-3 py-1.5 bg-[#007AFF] text-white rounded-[10px] text-[12px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all flex items-center gap-1.5"
                >
                  <Shield className="w-3.5 h-3.5" />
                  <span>Create Hedge</span>
                </button>
              </div>
              <div className="space-y-2">
                {closedHedges.map((hedge) => (
                  <div
                    key={hedge.id}
                    className="flex items-center justify-between p-3 bg-[#f5f5f7] rounded-[12px]"
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-[10px] flex items-center justify-center ${
                        hedge.type === 'SHORT' ? 'bg-[#FF3B30]/10' : 'bg-[#34C759]/10'
                      }`}>
                        {hedge.type === 'SHORT' ? (
                          <TrendingDown className="w-4 h-4 text-[#FF3B30]" strokeWidth={2} />
                        ) : (
                          <TrendingUp className="w-4 h-4 text-[#34C759]" strokeWidth={2} />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[14px] font-semibold text-[#1d1d1f]">{hedge.type} {hedge.asset}</span>
                          <span className="px-1.5 py-0.5 bg-[#86868b]/20 text-[#86868b] text-[9px] font-bold rounded">CLOSED</span>
                        </div>
                        <div className="text-[11px] text-[#86868b] space-y-0.5">
                          <div>{hedge.closedAt ? `Closed ${new Date(hedge.closedAt).toLocaleDateString()}` : hedge.reason}</div>
                          {hedge.txHash && (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] uppercase tracking-wider">TX:</span>
                              <a
                                href={`${explorerUrl}/tx/${hedge.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="font-mono">{hedge.txHash.slice(0, 10)}...{hedge.txHash.slice(-8)}</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`text-[15px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                        {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)}
                      </div>
                      <div className={`text-[11px] ${hedge.pnlPercent >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                        {hedge.pnlPercent >= 0 ? '+' : ''}{hedge.pnlPercent.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Closed Positions - Only in expanded view when there ARE active hedges */}
          {closedHedges.length > 0 && activeHedges.length > 0 && showClosedPositions && (
            <div className="bg-white rounded-[20px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-black/5 p-5 mt-4">
              <h3 className="text-[15px] font-semibold text-[#1d1d1f] mb-3 tracking-[-0.01em]">
                Closed Positions ({closedHedges.length})
              </h3>
              
              <div className="space-y-3">
                {closedHedges.map((hedge) => (
                  <div
                    key={hedge.id}
                    className="p-4 bg-[#f5f5f7] rounded-[14px] border border-[#e8e8ed] opacity-75"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-[12px] flex items-center justify-center ${
                          hedge.type === 'SHORT' ? 'bg-[#FF3B30]/10' : 'bg-[#34C759]/10'
                        }`}>
                          {hedge.type === 'SHORT' ? (
                            <TrendingDown className="w-5 h-5 text-[#FF3B30]" strokeWidth={2} />
                          ) : (
                            <TrendingUp className="w-5 h-5 text-[#34C759]" strokeWidth={2} />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[15px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">{hedge.type} {hedge.asset}</span>
                            <span className="text-[11px] px-2 py-0.5 bg-[#86868b]/20 text-[#86868b] rounded-full font-semibold">
                              Closed
                            </span>
                          </div>
                          <div className="text-[11px] text-[#86868b] mt-0.5 space-y-0.5">
                            <div>{hedge.closedAt && `Closed ${new Date(hedge.closedAt).toLocaleDateString()}`}</div>
                            {hedge.txHash && (
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] uppercase tracking-wider">TRANSACTION:</span>
                                <a
                                  href={`${explorerUrl}/tx/${hedge.txHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                  title="View on Cronos Explorer"
                                >
                                  <span className="font-mono">{hedge.txHash.slice(0, 10)}...{hedge.txHash.slice(-8)}</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`text-[17px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                          {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)} USDC
                        </div>
                        <div className={`text-[13px] ${hedge.pnlPercent >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                          {hedge.pnlPercent >= 0 ? '+' : ''}{hedge.pnlPercent.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Multi-Agent Recommendations Section */}
          {!compact && (
            <AIRecommendationsSection
              recommendations={recommendations}
              loading={loadingRecommendations}
              executingRecommendation={executingRecommendation}
              onRefresh={refreshContextHedges}
              onExecute={executeRecommendation}
            />
          )}
        </div>
      )}

      {/* Footer Info - Only show when viewing all */}
      {hedges.length > 0 && showClosedPositions && (
        <div className="mt-6 pt-6 border-t border-[#e8e8ed] flex flex-wrap items-center justify-between gap-3 text-[11px] text-[#86868b]">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <CheckCircle className="w-3.5 h-3.5 text-[#34C759]" />
              <span>x402 gasless</span>
            </div>
            <div className="flex items-center gap-1">
              <Shield className="w-3.5 h-3.5 text-[#007AFF]" />
              <span>Manager-approved</span>
            </div>
          </div>
          <a
            href={`${explorerUrl}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-[#007AFF] transition-colors"
          >
            <span>View on Explorer</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      <HedgeDetailModal
        hedge={detailHedge}
        onClose={() => setDetailHedge(null)}
        onClosePosition={handleClosePosition}
        closingPosition={closingPosition}
        explorerUrl={explorerUrl}
        chainId={chainId || CHAIN_IDS.CRONOS_TESTNET}
        contractAddresses={contractAddresses}
      />

      <CloseConfirmModal
        isOpen={showCloseConfirm}
        hedge={selectedHedge}
        onClose={closeCloseConfirm}
        onConfirm={confirmClosePosition}
      />

      <CloseReceiptModal
        receipt={closeReceipt}
        onDismiss={() => setCloseReceipt(null)}
      />
    </div>
  );
});
