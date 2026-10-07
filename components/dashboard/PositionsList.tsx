'use client';

import { useState, useMemo, useCallback } from 'react';
import { WalletContextBadge } from '@/components/wallet/ChainBadge';
import { TrendingUp, TrendingDown, Coins, RefreshCw, BarChart2 } from 'lucide-react';
import { useWallet } from '@/lib/hooks/useWallet';
import { PositionsLoadingSkeleton } from './positions-list/LoadingSkeleton';
import { NotConnectedState } from './positions-list/EmptyStates';
import { WalletBalancesList } from './positions-list/WalletBalancesList';
import { usePositions } from '@/contexts/PositionsContext';

export function PositionsList() {
  const { hasPortfolioWallet: isConnected } = useWallet();
  const { positionsData, derived, refetch: refetchPositions } = usePositions();
  const [refreshing, setRefreshing] = useState(false);

  const positions = positionsData?.positions || [];
  const totalValue = positionsData?.totalValue || 0;
  const lastUpdated = positionsData ? new Date(positionsData.lastUpdated) : null;

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchPositions();
    setRefreshing(false);
  }, [refetchPositions]);

  // Value-weighted 24h change across the wallet's tokens.
  const change24h = useMemo(
    () =>
      positions.reduce((acc, pos) => {
        const posValue = parseFloat(pos.balanceUSD || '0');
        const weight = totalValue > 0 ? posValue / totalValue : 0;
        return acc + pos.change24h * weight;
      }, 0),
    [positions, totalValue]
  );

  if (!isConnected) {
    return <NotConnectedState />;
  }

  if (!positionsData) {
    return <PositionsLoadingSkeleton />;
  }

  return (
    <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-4">
      {/* Compact Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-black/5 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Total Value */}
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-semibold text-[#86868b] uppercase tracking-wider">
                Total Value
              </span>
              <WalletContextBadge />
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[#34C759]/10 rounded-full">
                <span className="w-1 h-1 bg-[#34C759] rounded-full animate-pulse" />
                <span className="text-[9px] font-bold text-[#34C759]">LIVE</span>
              </span>
            </div>
            <div className="text-[22px] xs:text-[28px] sm:text-[36px] font-bold text-[#1d1d1f] leading-none tracking-[-0.02em] tabular-nums break-all">
              $
              {totalValue.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-[12px] text-[#86868b]">
              {derived?.pnl && derived.pnl.total !== 0 && (
                <>
                  <span
                    className={`font-semibold flex items-center gap-1 ${derived.pnl.total >= 0 ? 'text-green-700' : 'text-red-700'}`}
                  >
                    <BarChart2 className="w-3 h-3" />
                    {derived.pnl.total >= 0 ? '+' : '−'}$
                    {Math.abs(derived.pnl.total).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    unrealized
                  </span>
                  <span className="text-[#86868b]/60">•</span>
                </>
              )}
              <span
                className={`font-semibold flex items-center gap-1 ${change24h >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}
              >
                {change24h >= 0 ? (
                  <TrendingUp className="w-3 h-3" />
                ) : (
                  <TrendingDown className="w-3 h-3" />
                )}
                {change24h >= 0 ? '+' : ''}
                {change24h.toFixed(2)}% 24h
              </span>
              <span className="text-[#86868b]/60">•</span>
              <span>
                {lastUpdated
                  ? `Synced ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Syncing...'}
              </span>
            </div>
          </div>

          {/* Right: Refresh + token count */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-[#f5f5f7] rounded-lg">
              <Coins className="w-3.5 h-3.5 text-[#FF9500]" />
              <span className="text-[12px] font-semibold text-[#1d1d1f]">{positions.length}</span>
            </div>

            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-2.5 bg-[#f5f5f7] hover:bg-[#e8e8ed] rounded-xl transition-all disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 text-[#1d1d1f] ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Mobile Stats Row */}
        <div className="flex sm:hidden items-center gap-2 mt-3 pt-3 border-t border-black/5">
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f5f5f7] rounded-lg">
            <Coins className="w-3 h-3 text-[#FF9500]" />
            <span className="text-[11px] font-semibold text-[#1d1d1f]">
              {positions.length} Tokens
            </span>
          </div>
        </div>
      </div>

      <WalletBalancesList positions={positions} totalValue={totalValue} />
    </div>
  );
}
