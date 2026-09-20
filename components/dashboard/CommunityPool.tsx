'use client';

/**
 * CommunityPool - Refactored & Optimized
 *
 * Main orchestration component. All UI sections are extracted into
 * memoized sub-components under ./community-pool/. State management
 * uses useReducer via the useCommunityPool hook for minimal re-renders.
 *
 * OPTIMIZATIONS:
 * - memo() on all child components
 * - useMemo for derived values in hook
 * - useCallback for stable function refs
 * - Intersection observer for lazy loading heavy panels
 * - Skeleton loading states for better perceived performance
 * - startTransition for non-urgent state updates
 *
 * ~300 lines vs previous ~1,632 lines
 */

import { useState, memo, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import { usePrivyEmbeddedAddress } from '@/lib/evm-wallet/usePrivyEmbeddedAddress';
import { HederaVaultActions } from './HederaVaultActions';
import { HederaPoolHedgesProjection } from './HederaPoolHedgesProjection';
import { HederaRecentActivity } from './HederaRecentActivity';
import { MultiChainVaultsPanel } from './MultiChainVaultsPanel';
import { motion } from 'framer-motion';
import { useIntersectionObserver } from '@/lib/hooks';
import {
  PoolHeader,
  PoolStats,
  AllocationChart,
  HedgesPanel,
  UserPositionCard,
  DepositWithdrawActions,
  StatusMessages,
  Leaderboard,
  AIInsightsModal,
  CollapsibleSection,
  PoolVolatilityContext,
  useCommunityPool,
} from './community-pool';
import { PieChart, Shield, Users } from 'lucide-react';
import { CommunityPoolSkeleton } from './community-pool/Skeletons';
import { NavHistoryChart } from './NavHistoryChart'; // Lazy load heavy panels (only load when in viewport)
const RiskMetricsPanel = lazy(() =>
  import('./RiskMetricsPanel').then((mod) => ({ default: mod.RiskMetricsPanel }))
);
const AutoHedgePanel = lazy(() =>
  import('./AutoHedgePanel').then((mod) => ({ default: mod.AutoHedgePanel }))
);

// Skeleton fallbacks
const PanelSkeleton = () => (
  <div className="animate-pulse bg-gray-100 dark:bg-gray-700 h-48 rounded-lg" />
);

// Skeleton + delayed "taking longer than usual" hint.
// Pool loading normally resolves in <2s; when the SUI RPC is down the
// skeleton previously spun forever with zero UX feedback. After 12s
// we show a small non-blocking hint + retry button so users know the
// dashboard hasn't frozen.
function CommunityPoolSkeletonWithTimeout({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="relative">
      <CommunityPoolSkeleton />
      {slow && (
        <div className="mt-3 flex items-center justify-center gap-3 text-caption-1 text-label-tertiary">
          <span>Pool data slower than usual. SUI RPC may be busy.</span>
          <button
            type="button"
            onClick={onRetry}
            className="text-ios-blue hover:text-ios-blueHover font-medium"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

interface CommunityPoolProps {
  address?: string;
  compact?: boolean;
}

export const CommunityPool = memo(function CommunityPool({
  address: propAddress,
  compact = false,
}: CommunityPoolProps) {
  const [showAI, setShowAI] = useState(false);

  // Privy embedded-wallet fallback. When users sign in with Google/email
  // via Privy, an EVM self-custodial wallet is created. But Privy's
  // WagmiProvider doesn't always surface it via useAccount() immediately.
  // Reading useWallets() directly gives us the address as soon as login
  // completes so the deposit UI unlocks without a manual reconnect.
  const privyEmbeddedAddress = usePrivyEmbeddedAddress();

  const pool = useCommunityPool(propAddress ?? privyEmbeddedAddress ?? undefined);

  // Auto-select Hedera the first time a Privy embedded wallet appears.
  // Privy wallets live on Hedera Testnet by default (privy-client-config
  // defaultChain: hederaTestnet) so switching the pool picker keeps the
  // user's on-chain context aligned with what they can actually deposit
  // into. Runs exactly once per session. After that the user's manual
  // chain switch wins.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (!privyEmbeddedAddress) return;
    if (pool.selectedChain === 'hedera') { autoSelectedRef.current = true; return; }
    // Only auto-switch from the SUI default; if the user is already on
    // an EVM chain manually, respect that choice.
    if (pool.selectedChain !== 'sui') { autoSelectedRef.current = true; return; }
    autoSelectedRef.current = true;
    pool.handleChainSelect('hedera');
  }, [privyEmbeddedAddress, pool]);

  // ============================================================================
  // TRANSACTION CONFIRMATION EFFECTS (tightly coupled to WDK lifecycle)
  // ============================================================================

  // Guard against duplicate isConfirmed fires (React Strict Mode / rapid tx)
  const txProcessedRef = useRef<string | null>(null);

  // Shared helper for recording deposit/withdraw in backend after on-chain confirmation
  const recordTransaction = useCallback(
    async (
      action: 'deposit' | 'withdraw',
      value: string,
      successMsg: string,
      resetField: () => void,
      hidePanel: () => void
    ) => {
      try {
        pool.setError(`Please sign to confirm your ${action}...`);
        const authData = await pool.signForApi(action, value);
        if (!authData) {
          pool.setError(`Signature required to confirm ${action}`);
          pool.setTxStatus('idle');
          pool.setActionLoading(false);
          return;
        }
        pool.setError(null);

        const body =
          action === 'deposit'
            ? { walletAddress: pool.address, amount: parseFloat(value), txHash: pool.lastTxHash }
            : { walletAddress: pool.address, shares: parseFloat(value), txHash: pool.lastTxHash };

        const res = await fetch(
          `/api/community-pool?action=${action}&chain=${pool.selectedChain}&network=${pool.network}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-wallet-address': pool.address || '',
              'x-wallet-signature': authData.signature,
              'x-wallet-message': btoa(authData.message),
            },
            body: JSON.stringify(body),
          }
        );

        const json = await res.json();

        if (json.success) {
          pool.setSuccess(successMsg);
          resetField();
          hidePanel();
          pool.setTxStatus('idle');
          pool.resetWrite();

          await fetch(`/api/community-pool?action=sync&user=${pool.address}`);
          pool.fetchPoolData();

          setTimeout(() => {
            pool.setSuccess(null);
            pool.setLastTxHash(null);
          }, 10000);
        } else {
          pool.setError(json.error);
          pool.setTxStatus('idle');
        }
      } catch (err: any) {
        pool.setError(err.message);
        pool.setTxStatus('idle');
      } finally {
        pool.setActionLoading(false);
      }
    },
    [pool]
  );

  // Handle transaction confirmation based on current status
  useEffect(() => {
    if (!pool.isConfirmed) return;

    // Deduplicate: skip if we already processed this exact txStatus
    const txKey = `${pool.txStatus}`;
    if (txProcessedRef.current === txKey) return;
    txProcessedRef.current = txKey;

    // Approval confirmed -> trigger deposit
    if (pool.txStatus === 'approving' && pool.depositAmount) {
      pool.setTxStatus('depositing');
      pool.resetWrite();
      return;
    }

    // Deposit confirmed - record in backend
    if (pool.txStatus === 'depositing') {
      const amount = parseFloat(pool.depositAmount);
      recordTransaction(
        'deposit',
        pool.depositAmount,
        `Deposited $${amount.toFixed(2)} successfully!`,
        () => pool.setDepositAmount(''),
        () => pool.setShowDeposit(false)
      );
      return;
    }

    // Withdrawal confirmed - record in backend
    if (pool.txStatus === 'withdrawing') {
      const shares = parseFloat(pool.withdrawShares);
      recordTransaction(
        'withdraw',
        pool.withdrawShares,
        `Withdrew ${shares.toFixed(2)} shares successfully!`,
        () => pool.setWithdrawShares(''),
        () => pool.setShowWithdraw(false)
      );
    }
  }, [pool.isConfirmed]);

  // Reset tx guard when status returns to idle
  useEffect(() => {
    if (pool.txStatus === 'idle') {
      txProcessedRef.current = null;
    }
  }, [pool.txStatus]);

  // Handle write errors
  useEffect(() => {
    if (pool.writeError) {
      const errorMsg = pool.writeError.message || '';

      if (errorMsg.includes('User rejected') || errorMsg.includes('user rejected')) {
        pool.setError('Transaction rejected by user');
      } else if (errorMsg.includes('Invalid value') || errorMsg.includes('fetch')) {
        pool.setError('Transaction failed - please check your input values and try again');
      } else if (errorMsg.includes('InsufficientShares')) {
        pool.setError('Insufficient shares to withdraw');
      } else if (errorMsg.includes('InsufficientLiquidity')) {
        pool.setError('Insufficient liquidity in pool - please try a smaller amount');
      } else {
        const shortMsg = (pool.writeError as any).shortMessage || errorMsg;
        pool.setError(shortMsg.slice(0, 200));
      }
      pool.setActionLoading(false);
      pool.setTxStatus('idle');
    }
  }, [pool.writeError]);

  // ============================================================================
  // AI MODAL HANDLER
  // ============================================================================

  const handleAIClick = useCallback(() => {
    setShowAI(true);
    pool.fetchAIRecommendation();
  }, [pool.fetchAIRecommendation]);

  const chainName = pool.chainConfig?.name || pool.selectedChain;

  // ============================================================================
  // INTERSECTION OBSERVER FOR LAZY LOADING HEAVY PANELS
  // ============================================================================

  const [riskMetricsRef, riskMetricsVisible] = useIntersectionObserver<HTMLDivElement>({
    rootMargin: '200px', // Start loading 200px before entering viewport
    freezeOnceVisible: true,
  });

  const [autoHedgeRef, autoHedgeVisible] = useIntersectionObserver<HTMLDivElement>({
    rootMargin: '200px',
    freezeOnceVisible: true,
  });

  // ============================================================================
  // LOADING STATE (with optimized skeleton)
  // ============================================================================

  if (pool.loading) {
    return <CommunityPoolSkeletonWithTimeout onRetry={() => pool.fetchPoolData(true)} />;
  }

  // ============================================================================
  // NO DATA STATE
  // ============================================================================

  if (!pool.poolData) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white dark:bg-gray-800 rounded-2xl sm:rounded-xl shadow-lg overflow-hidden min-w-0 max-w-full"
      >
        <PoolHeader
          selectedChain={pool.selectedChain}
          onChainSelect={pool.handleChainSelect}
          onRefresh={() => pool.fetchPoolData(true)}
        />
        <div className="p-4 sm:p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center text-sm">
            {pool.error ||
              `Unable to load ${chainName} pool data. Try refreshing or selecting a different chain.`}
          </p>
        </div>
      </motion.div>
    );
  }

  // ============================================================================
  // MAIN RENDER
  // ============================================================================

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white dark:bg-gray-800 rounded-2xl sm:rounded-xl shadow-lg overflow-hidden min-w-0 max-w-full"
    >
      <PoolHeader
        selectedChain={pool.selectedChain}
        onChainSelect={pool.handleChainSelect}
        onRefresh={() => pool.fetchPoolData(true)}
        onAIClick={handleAIClick}
        chainName={chainName}
        network={pool.network}
        poolDeployed={pool.poolDeployed}
      />

      {/* Share-price history chart owns the hero slot. Total Value and
          Total Shares tiles that used to sit atop PoolStats were removed
          in favour of showing the story rather than the point-in-time
          number. Current NAV surfaces as the last tooltip on the chart. */}
      <NavHistoryChart chain={pool.selectedChain === 'hedera' ? 'hedera' : 'sui'} />

      <PoolStats poolData={pool.poolData} selectedChain={pool.selectedChain} />

      {/* Honest volatility context — shows "24h range" and "vs 30d ago" so
          users don't misread a routine pullback from ATH as ongoing loss. */}
      <PoolVolatilityContext
        selectedChain={pool.selectedChain}
        network={pool.network}
        currentSharePrice={Number(pool.poolData?.sharePrice) || undefined}
      />

      {/* Show user position if wallet is connected — kept above allocation
          on mobile so members see their stake before the pool-wide charts. */}
      {pool.activeAddress && pool.userPosition && (
        <UserPositionCard
          userPosition={pool.userPosition}
          selectedChain={pool.selectedChain}
          chainName={chainName}
        />
      )}

      {/* Allocation chart. Collapsed on mobile, expanded on desktop */}
      <CollapsibleSection
        title="Allocation"
        icon={<PieChart className="w-4 h-4 text-indigo-500" />}
        summary={pool.chainConfig?.assets?.join(' · ') ?? 'Multi-asset'}
      >
        <AllocationChart
          allocations={pool.poolData.allocations}
          assets={pool.chainConfig?.assets}
        />
      </CollapsibleSection>

      {/* Active BlueFin perp hedges (SUI pool only). Renders nothing when
          no real hedges are open or when the chain doesn't have any. */}
      {pool.selectedChain === 'sui' && pool.poolData.hedges && pool.poolData.hedges.length > 0 && (
        <CollapsibleSection
          title="Active Hedges"
          icon={<Shield className="w-4 h-4 text-purple-500" />}
          summary={`${pool.poolData.hedges.length} pos.`}
        >
          <HedgesPanel hedges={pool.poolData.hedges} />
        </CollapsibleSection>
      )}

      {/* Hedera vault has its own compact deposit/withdraw component wired
          to SimpleUsdcVault directly. Keeps this dedicated path free of the
          SUI + Sepolia + Cronos + WDK + permit code that the monolith
          DepositWithdrawActions carries for backwards compatibility.
          Prefer privyEmbeddedAddress over pool.address so Google/email
          login users see their embedded wallet immediately even before
          wagmi's useAccount resolves. */}
      {pool.selectedChain === 'hedera' && pool.poolData && (
        <HederaPoolHedgesProjection poolNavUsd={Number(pool.poolData.totalValueUSD) || 0} />
      )}
      {pool.selectedChain === 'hedera' ? (
        <HederaVaultActions
          address={(privyEmbeddedAddress ?? pool.address) as `0x${string}` | undefined}
          onRefresh={() => pool.fetchPoolData(true)}
        />
      ) : (
        <DepositWithdrawActions
          selectedChain={pool.selectedChain}
          poolData={pool.poolData}
          userPosition={pool.userPosition}
          chainConfig={pool.chainConfig}
          poolDeployed={pool.poolDeployed}
          communityPoolAddress={pool.COMMUNITY_POOL_ADDRESS}
          suiPoolStateId={pool.suiPoolStateId}
          network={pool.network}
          isFirstDeposit={pool.isFirstDeposit}
          isChainMismatch={pool.isChainMismatch}
          userUsdtBalance={pool.userUsdtBalance}
          showDeposit={pool.showDeposit}
          showWithdraw={pool.showWithdraw}
          depositAmount={pool.depositAmount}
          withdrawShares={pool.withdrawShares}
          actionLoading={pool.actionLoading}
          isPending={pool.isPending}
          isConfirming={pool.isConfirming}
          txStatus={pool.txStatus}
          address={pool.address}
          activeWalletType={pool.activeWalletType}
          suiIsConnected={pool.suiIsConnected}
          suiAddress={pool.suiAddress}
          suiBalance={pool.suiBalance}
          suiDepositAmount={pool.suiDepositAmount}
          suiWithdrawShares={pool.suiWithdrawShares}
          suiNetwork={pool.suiNetwork}
          suiIsWrongNetwork={pool.suiIsWrongNetwork}
          onShowDeposit={pool.setShowDeposit}
          onShowWithdraw={pool.setShowWithdraw}
          onDepositAmountChange={pool.setDepositAmount}
          onWithdrawSharesChange={pool.setWithdrawShares}
          onSuiDepositAmountChange={pool.setSuiDepositAmount}
          onSuiWithdrawSharesChange={pool.setSuiWithdrawShares}
          onDeposit={pool.handleDeposit}
          onWithdraw={pool.handleWithdraw}
          onSuiDeposit={pool.handleSuiDeposit}
          onSuiWithdraw={pool.handleSuiWithdraw}
        />
      )}

      <StatusMessages
        successMessage={pool.successMessage}
        error={pool.error}
        lastTxHash={pool.lastTxHash}
        selectedChain={pool.selectedChain}
        network={pool.network}
      />

      {/* Hedera swaps SUI's RiskMetrics + AutoHedge (both BlueFin-shaped)
          for a chain-native Recent Activity feed. Real events from Mirror
          Node; refreshes every 15s. Keeps the tab useful without the
          "insufficient data" empty state that SUI panels show on Hedera. */}
      {!compact && pool.selectedChain === 'hedera' && <HederaRecentActivity />}

      {/* One GraphQL query, two indexing backends. Proves the AI-vault
          schema abstracts over indexing infrastructure, not just chains.
          Studio subgraph indexes Sepolia; adapter projects Hedera Mirror
          Node into the same shape. Hedera-only surface for now. */}
      {!compact && pool.selectedChain === 'hedera' && (
        <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
          <MultiChainVaultsPanel />
        </div>
      )}

      {/* Risk Metrics. SUI/Cronos only; needs BlueFin history */}
      {!compact && pool.selectedChain !== 'hedera' && (
        <div
          ref={riskMetricsRef}
          className="p-3 sm:p-4 md:p-5 border-b border-gray-100 dark:border-gray-700 min-h-[200px]"
        >
          {riskMetricsVisible ? (
            <Suspense fallback={<PanelSkeleton />}>
              <RiskMetricsPanel compact={false} chain={pool.selectedChain} />
            </Suspense>
          ) : (
            <PanelSkeleton />
          )}
        </div>
      )}

      {/* Auto Hedge Panel. SUI-only feature (BlueFin auto-hedging) */}
      {!compact && pool.selectedChain !== 'hedera' && (
        <div
          ref={autoHedgeRef}
          className="p-3 sm:p-4 md:p-5 border-b border-gray-100 dark:border-gray-700 min-h-[200px]"
        >
          {autoHedgeVisible ? (
            <Suspense fallback={<PanelSkeleton />}>
              <AutoHedgePanel chain={pool.selectedChain} />
            </Suspense>
          ) : (
            <PanelSkeleton />
          )}
        </div>
      )}

      {!compact && (
        <CollapsibleSection
          title="Members & Pool Info"
          icon={<Users className="w-4 h-4 text-yellow-500" />}
          summary={(() => {
            const n = pool.poolData?.memberCount ?? pool.leaderboard?.length ?? 0;
            return `${n.toLocaleString()} ${n === 1 ? 'member' : 'members'}`;
          })()}
        >
          <Leaderboard
            entries={pool.leaderboard}
            totalMembers={pool.poolData?.memberCount}
            poolTVL={pool.poolData?.totalValueUSD}
            chainId={
              typeof pool.chainConfig?.chainId === 'number' ? pool.chainConfig.chainId : 11155111
            }
            selectedChain={pool.selectedChain}
            chainConfig={pool.chainConfig}
          />
        </CollapsibleSection>
      )}

      <AIInsightsModal
        isOpen={showAI}
        onClose={() => setShowAI(false)}
        recommendation={pool.aiRecommendation}
      />
    </motion.div>
  );
});

export default CommunityPool;
